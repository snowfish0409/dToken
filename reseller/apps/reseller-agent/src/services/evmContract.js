/**
 * dToken mainnet contract client — 基于 ethers.js
 *
 * 当前优先对接 V5 upgradeable proxy：
 * - 链上只验证 UserDTokenSettlement（handshakeId + cumulativeSpent + meteringHash + signedAt）
 * - dToken hash chain、模型、价格、token 明细只留在链下服务账本
 * - API 接入只做链下 handshakeCredential 验证，不再有 Provider accept 上链动作
 * - 默认聊天链下等待 User 签 dToken credential；退出/争议/最终认领时才写链
 */

import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEPLOYMENT_PATHS = [
  "mainnet-dtoken-v0.json",
].flatMap((file) => [
  path.resolve(process.cwd(), "smart-contracts/deployments", file),
  path.resolve(process.cwd(), "../../smart-contracts/deployments", file),
  path.resolve(process.cwd(), "deploy", file),
  path.resolve(MODULE_DIR, "../../../../smart-contracts/deployments", file),
  path.resolve(MODULE_DIR, "../../../../deploy", file),
]);

const STATUS_NAMES = {
  0: "NONE",
  1: "OPEN",
  2: "USER_BREAKUP_PENDING",
  3: "SETTLED",
};

const USER_DTOKEN_SETTLEMENT_TYPES = {
  UserDTokenSettlement: [
    { name: "handshakeId", type: "bytes32" },
    { name: "cumulativeSpent", type: "uint256" },
    { name: "meteringHash", type: "bytes32" },
    { name: "signedAt", type: "uint64" },
  ],
};

export async function createEvmContractClient(config) {
  const rpcUrl = config.rpcUrl;
  if (!rpcUrl) {
    throw new Error("Mainnet RPC URL is required. Set DTOKEN_CONTRACT_RPC env var.");
  }

  const deployment = loadDeployment(config.protocolAddress ?? config.contractAddress);
  const contractAddress = deployment.protocol_address ?? deployment.contract_address;
  const chainId = Number(config.chainId ?? deployment.chain_id);

  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId, {
    staticNetwork: true,
    batchMaxCount: 1,
  });
  provider._getConnection().timeout = Number(config.rpcTimeoutMs ?? 30000);

  const network = await provider.getNetwork();
  if (Number(network.chainId) !== chainId) {
    throw new Error(`Chain ID mismatch: RPC returned ${network.chainId}, expected ${chainId}`);
  }

  const contract = new ethers.Contract(contractAddress, deployment.protocol_abi ?? deployment.abi, provider);
  const proxyContract = deployment.proxy_abi
    ? new ethers.Contract(contractAddress, deployment.proxy_abi, provider)
    : null;

  let signer = null;
  let serviceSigner = null;
  let contractWithSigner = null;
  const providerSigners = new Map();
  const providerEventCache = new Map();
  function addProviderSigner(privateKey, label = "provider") {
    if (!privateKey) return null;
    const wallet = new ethers.Wallet(privateKey, provider);
    providerSigners.set(wallet.address.toLowerCase(), wallet);
    console.log(`[mainnet] ${label} signer ready: ${wallet.address}`);
    return wallet;
  }
  if (config.providerWalletPrivateKey) {
    signer = addProviderSigner(config.providerWalletPrivateKey, "Provider");
    contractWithSigner = contract.connect(signer);
  }
  for (const key of config.providerOperatorPrivateKeys ?? []) {
    const wallet = addProviderSigner(key, "Provider operator");
    if (!signer && wallet) {
      signer = wallet;
      contractWithSigner = contract.connect(signer);
    }
  }
  if (config.serviceSignerPrivateKey) {
    serviceSigner = new ethers.Wallet(config.serviceSignerPrivateKey, provider);
    if (!contractWithSigner) contractWithSigner = contract.connect(serviceSigner);
    console.log(`[mainnet] Service signer ready: ${serviceSigner.address}`);
  }

  const protocolVersion = await contract.PROTOCOL_VERSION().catch(() => "unknown");
  const signingVersion = await contract.SIGNING_VERSION().catch(() => "0");
  const contractName = await contract.name().catch(() => "dToken");
  console.log(`[mainnet] Connected to ${contractAddress} on chain ${chainId} (protocol ${protocolVersion}, signing ${signingVersion})`);

  let _domainCache = {
    name: contractName,
    version: signingVersion,
    chainId,
    verifyingContract: contractAddress,
  };
  async function getDomain() {
    if (_domainCache) return _domainCache;
    _domainCache = {
      name: contractName,
      version: signingVersion,
      chainId,
      verifyingContract: contractAddress,
    };
    return _domainCache;
  }

  return {
    mode: "mainnet",
    contractAddress,
    chainId,
    protocolVersion,
    signingVersion,
    provider,
    signer,
    serviceSigner,
    providerSigners,
    contract,
    proxyContract,
    contractWithSigner,

    async userSettlementDigest(settlement) {
      return ethers.TypedDataEncoder.hash(
        await getDomain(),
        USER_DTOKEN_SETTLEMENT_TYPES,
        toContractSettlement(settlement),
      );
    },

    async verifyUserCredential(credential, signature) {
      return this.verifyUserSettlement(credential, signature);
    },

    async verifyUserSettlement(settlement, signature) {
      return contract.verifyUserSettlement(toContractSettlement(settlement), signature);
    },

    async health() {
      try {
        const [code, blockNumber] = await Promise.all([
          provider.getCode(contractAddress),
          provider.getBlockNumber(),
        ]);
        if (!code || code === "0x") {
          throw new Error(`No contract code at ${contractAddress}`);
        }
        const proxyImplementation = proxyContract
          ? await proxyContract.implementation().catch(() => null)
          : null;
        return {
          connected: true,
          contract: {
            name: "dToken Protocol",
            token: deployment.token_address ?? null,
            address: contractAddress,
            implementation: proxyImplementation,
            protocolVersion,
            signingVersion,
          },
          blockNumber,
          signerReady: contractWithSigner !== null,
          providerSigners: Array.from(providerSigners.keys()),
        };
      } catch (error) {
        return { connected: false, error: error.message };
      }
    },

    async getProvider(providerOperator, modelId = null) {
      const providers = await readProviderEvents({ providerOperator });
      if (modelId) {
        return providers.find((p) => p.modelId === modelId) ?? emptyProvider(providerOperator, modelId);
      }
      return providers.find((p) => p.active) ?? providers[providers.length - 1] ?? emptyProvider(providerOperator, "");
    },

    async getProviderById(providerId) {
      const wanted = String(providerId ?? "").toLowerCase();
      return (await readProviderEvents({ providerId: wanted })).find((p) => String(p.providerId).toLowerCase() === wanted)
        ?? emptyProvider(null, "");
    },

    async listProviderModels(providerOperator) {
      return readProviderEvents({ providerOperator });
    },

    async listProviderListings() {
      return readProviderEvents({});
    },

    async announceProvider(update) {
      const writer = await writableContractForProvider(update.providerOperator ?? update.providerWallet, { requireOperator: true });
      const normalized = normalizeProviderUpdate(update);
      let gasLimit = 700000n;
      try {
        const estimated = await writer.announceProvider.estimateGas(normalized);
        gasLimit = estimated + (estimated / 5n) + 50000n;
      } catch (error) {
        console.warn(`[mainnet] announceProvider gas estimate failed, using fallback: ${error.message}`);
      }
      const tx = await writer.announceProvider(normalized, { gasLimit });
      return tx.wait();
    },

    async getHandshake(handshakeId) {
      const raw = await rpcRead("getHandshake", () => contract.getHandshake(handshakeId));
      const statusCode = Number(raw.status);
      const escrowAmount = raw.escrowAmount.toString();
      const pendingCloseAmount = raw.pendingCloseAmount?.toString?.() ?? "0";
      return {
        handshakeId,
        status: statusCode,
        statusName: STATUS_NAMES[statusCode] ?? `UNKNOWN(${statusCode})`,
        userWallet: raw.userWallet,
        providerOperator: raw.providerOperator,
        providerOfferId: raw.providerOfferId ?? ethers.ZeroHash,
        userSessionSigner: raw.userSessionSigner,
        handshakeCredentialHash: raw.handshakeCredentialHash ?? ethers.ZeroHash,
        escrowAmount,
        pendingCloseAmount,
        challengeDeadline: Number(raw.challengeDeadline),
        pendingSettlementProofHash: raw.pendingSettlementProofHash,
        // Compatibility fields: chain no longer stores these; reseller/user derive them from metadata and local ledger.
        providerId: raw.providerOfferId ?? ethers.ZeroHash,
        providerServiceSignerSnapshot: raw.providerOperator,
        providerMetadataURI: "",
        providerMetadataHash: ethers.ZeroHash,
        providerEndpoint: "",
        providerModelId: "",
        providerMinEscrowAmount: "0",
        providerDefaultIdleTimeout: 0,
        lastConfirmedCumulativeSpent: pendingCloseAmount,
        latestUserCredentialCumulativeSpent: pendingCloseAmount,
        inputTokenPrice: "0",
        outputTokenPrice: "0",
        openedAt: 0,
        acceptedAt: 0,
        idleDeadline: 0,
        latestUserCredentialRound: 0,
        lastConfirmedCredentialRound: 0,
        pendingSettlementRound: 0,
        pricingPolicyHash: ethers.ZeroHash,
        tokenizerHash: ethers.ZeroHash,
        modelHash: ethers.ZeroHash,
        accessCredentialHash: ethers.ZeroHash,
        latestUserCredentialHash: ethers.ZeroHash,
        lastConfirmedCredentialHash: ethers.ZeroHash,
        latestMeteringHash: ethers.ZeroHash,
        isOpen: statusCode === 1,
        isSettled: statusCode === 3,
        remaining: (BigInt(escrowAmount) - BigInt(pendingCloseAmount)).toString(),
      };
    },

    async providerSettle(handshakeId) {
      throw new Error("providerSettle requires the latest User-signed settlement proof");
    },

    async providerSettleWithUserSettlement(settlement, userSignature, refreshUpdate = null) {
      const writer = await writableContractForHandshake(settlement.handshake_id ?? settlement.handshakeId, { requireOperator: true });
      const contractSettlement = toContractSettlement(settlement);
      const normalizedUpdate = normalizeProviderUpdate(refreshUpdate);
      let gasLimit = 900000n;
      try {
        const estimated = await writer.providerSettleWithUserSettlement.estimateGas(
          contractSettlement,
          userSignature,
          normalizedUpdate,
        );
        gasLimit = estimated + (estimated / 5n) + 50000n;
      } catch (error) {
        console.warn(`[mainnet] providerSettleWithUserSettlement gas estimate failed, using fallback: ${error.message}`);
      }
      const tx = await writer.providerSettleWithUserSettlement(
        contractSettlement,
        userSignature,
        normalizedUpdate,
        { gasLimit },
      );
      return tx.wait();
    },

    async providerClaimUserBreakup(handshakeId, refreshUpdate = null) {
      const writer = await writableContractForHandshake(handshakeId);
      const tx = await writer.providerClaimUserBreakup(handshakeId, normalizeProviderUpdate(refreshUpdate), { gasLimit: 300000 });
      return tx.wait();
    },

    async challengeUserBreakupWithUserSettlement(settlement, userSignature, refreshUpdate = null) {
      const writer = await writableContractForHandshake(settlement.handshake_id ?? settlement.handshakeId);
      const contractSettlement = toContractSettlement(settlement);
      const normalizedUpdate = normalizeProviderUpdate(refreshUpdate);
      let gasLimit = 900000n;
      try {
        const estimated = await writer.challengeUserBreakupWithUserSettlement.estimateGas(
          contractSettlement,
          userSignature,
          normalizedUpdate,
        );
        gasLimit = estimated + (estimated / 5n) + 50000n;
      } catch (error) {
        throw new Error(`challengeUserBreakupWithUserSettlement gas estimate failed: ${error.message}`);
      }
      const tx = await writer.challengeUserBreakupWithUserSettlement(
        contractSettlement,
        userSignature,
        normalizedUpdate,
        { gasLimit },
      );
      return tx.wait();
    },

    async finalizeUserBreakup(handshakeId) {
      if (!contractWithSigner) throw new Error("Signer required for finalizeUserBreakup");
      const tx = await contractWithSigner.finalizeUserBreakup(handshakeId, { gasLimit: 220000 });
      return tx.wait();
    },

    async getProviderHandshakeIds(providerOperator) {
      const current = await provider.getBlockNumber();
      const lookback = Number(config.providerHandshakeLookbackBlocks ?? config.providerAutoSettleLookbackBlocks ?? 100);
      const fromBlock = lookback > 0 ? Math.max(0, current - lookback) : 0;
      const operator = ethers.getAddress(providerOperator);
      const events = await queryFilterChunked(contract.filters.HandshakeOpened(null, null, operator), fromBlock, current);
      const seen = new Set();
      const ids = [];
      for (const ev of events) {
        const id = ev.args?.handshakeId ?? ev.args?.[0];
        const key = String(id ?? "").toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        ids.push(id);
      }
      return ids;
    },
  };

  async function queryFilterChunked(filter, fromBlock, toBlock, chunkSize = null) {
    const events = [];
    const from = Number(fromBlock);
    const to = Number(toBlock);
    const blockCount = Math.max(1, Number(chunkSize ?? config.providerEventChunkBlocks ?? 2000));
    for (let start = from; start <= to; start += blockCount) {
      const end = Math.min(to, start + blockCount - 1);
      try {
        events.push(...await contract.queryFilter(filter, start, end));
      } catch (error) {
        if (blockCount <= 1) throw error;
        events.push(...await queryFilterChunked(filter, start, end, Math.floor(blockCount / 2)));
      }
    }
    return events;
  }

  async function readProviderEvents({ providerOperator = null, providerId = null } = {}) {
    const current = await provider.getBlockNumber();
    const lookback = Number(config.providerEventLookbackBlocks ?? 10000);
    const fromBlock = lookback > 0 ? Math.max(0, current - lookback) : 0;
    const toBlock = current;
    const events = [];
    const operator = providerOperator ? ethers.getAddress(providerOperator) : null;
    const cacheKey = `${operator ?? "*"}:${String(providerId ?? "*").toLowerCase()}:${lookback}`;
    const cached = providerEventCache.get(cacheKey);
    if (cached && Date.now() - cached.at < Number(config.providerEventCacheMs ?? 30000)) {
      return cached.items;
    }
    try {
      const filter = operator
        ? contract.filters.ProviderAnnounced(operator)
        : contract.filters.ProviderAnnounced();
      for (const ev of await queryFilterChunked(filter, fromBlock, toBlock)) {
        events.push(["announce", ev]);
      }
    } catch (error) {
      console.warn(`[mainnet] ProviderAnnounced scan failed: ${error.message}`);
    }

    const latest = new Map();
    for (const [kind, ev] of events
      .sort((a, b) =>
        (a[1].blockNumber - b[1].blockNumber)
        || ((a[1].index ?? a[1].logIndex ?? 0) - (b[1].index ?? b[1].logIndex ?? 0)))) {
        const item = kind === "model"
          ? await normalizeProviderModelEvent(ev)
          : await normalizeProviderAnnounceEvent(ev);
        if (providerId && String(item.providerId).toLowerCase() !== providerId) continue;
        latest.set(String(item.providerId).toLowerCase(), item);
    }
    const items = [...latest.values()];
    providerEventCache.set(cacheKey, { at: Date.now(), items });
    return items;
  }

  async function writableContractForHandshake(handshakeId, { requireOperator = false } = {}) {
    if (!handshakeId) return writableContractForProvider(null, { requireOperator });
    const raw = await rpcRead("getHandshakeForWriter", () => contract.getHandshake(handshakeId));
    return writableContractForProvider(resultField(raw, "providerOperator", 2), { requireOperator });
  }

  async function writableContractForProvider(providerOperator, { requireOperator = false } = {}) {
    if (providerOperator) {
      const addr = ethers.getAddress(providerOperator);
      const operatorSigner = providerSigners.get(addr.toLowerCase());
      if (operatorSigner) return contract.connect(operatorSigner);
      if (requireOperator) throw new Error(`Provider operator signer not configured for ${addr}`);
    }
    if (!contractWithSigner) throw new Error("Signer required for contract write");
    return contractWithSigner;
  }
}

export function modelHash(model) {
  return ethers.keccak256(ethers.toUtf8Bytes(model ?? ""));
}

function toContractSettlement(credential) {
  return {
    handshakeId: credential.handshake_id ?? credential.handshakeId,
    cumulativeSpent: credential.cumulative_spent ?? credential.cumulativeSpent,
    meteringHash: credential.metering_hash ?? credential.meteringHash,
    signedAt: credential.signed_at ?? credential.signedAt ?? Math.floor(Date.now() / 1000),
  };
}

function toContractSessionAuth(auth) {
  return {
    handshakeId: auth.handshakeId ?? auth.handshake_id,
    sessionSigner: auth.sessionSigner ?? auth.session_signer,
    validAfter: auth.validAfter ?? auth.valid_after ?? 0,
    expiresAt: auth.expiresAt ?? auth.expires_at ?? 0,
    nonce: auth.nonce ?? "0",
  };
}

function resultField(result, name, index) {
  return result?.[name] ?? result?.[index];
}

async function rpcRead(label, fn, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i === attempts - 1 || !isRetryableRpcError(error)) break;
      await delay(300 * (i + 1));
    }
  }
  if (lastError) {
    lastError.message = `${label}: ${lastError.message}`;
  }
  throw lastError;
}

function isRetryableRpcError(error) {
  const msg = String(error?.message ?? error ?? "").toLowerCase();
  const code = String(error?.code ?? "").toLowerCase();
  return code.includes("timeout")
    || code.includes("server_error")
    || code.includes("network")
    || msg.includes("timeout")
    || msg.includes("408")
    || msg.includes("429")
    || msg.includes("temporarily unavailable")
    || msg.includes("could not coalesce error");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeProvider(raw) {
  const metadata = raw.metadata ?? {};
  const pricing = metadata.pricing ?? raw.pricing ?? {};
  const operator = resultField(raw, "operator", 0);
  const metadataHash = resultField(raw, "metadataHash", 3) ?? metadata.metadataHash ?? ethers.ZeroHash;
  const providerId = resultField(raw, "providerId", 16)
    ?? resultField(raw, "offerId", 17)
    ?? (operator && metadataHash ? offerIdForLocal(operator, metadataHash) : ethers.ZeroHash);
  return {
    operator,
    serviceSigner: operator,
    metadataURI: resultField(raw, "metadataURI", 2) ?? "",
    metadataHash,
    endpoint: resultField(raw, "endpoint", 4) ?? metadata.endpoint ?? "",
    modelId: resultField(raw, "modelId", 5) ?? metadata.modelId ?? metadata.model_id ?? metadata.displayName ?? metadata.display_name ?? "",
    pricingPolicyHash: resultField(raw, "pricingPolicyHash", 6) ?? metadata.pricingPolicyHash ?? metadata.pricing_policy_hash ?? ethers.ZeroHash,
    tokenizerHash: resultField(raw, "tokenizerHash", 7) ?? metadata.tokenizerHash ?? metadata.tokenizer_hash ?? ethers.ZeroHash,
    inputTokenPrice: (resultField(raw, "inputTokenPrice", 8) ?? pricing.inputTokenPrice ?? pricing.input_token_price ?? "0").toString(),
    outputTokenPrice: (resultField(raw, "outputTokenPrice", 9) ?? pricing.outputTokenPrice ?? pricing.output_token_price ?? "0").toString(),
    minEscrowAmount: (resultField(raw, "minEscrowAmount", 10) ?? metadata.minEscrowAmount ?? metadata.min_escrow_amount ?? "0").toString(),
    defaultIdleTimeout: Number(resultField(raw, "defaultIdleTimeout", 11) ?? metadata.defaultIdleTimeout ?? metadata.default_idle_timeout ?? 0),
    active: resultField(raw, "active", 12) ?? metadata.active ?? true,
    announcedAt: Number(resultField(raw, "announcedAt", 13) ?? 0),
    updatedAt: Number(resultField(raw, "updatedAt", 14) ?? 0),
    version: Number(resultField(raw, "version", 15) ?? 0),
    providerId,
    offerId: providerId,
    capabilities: metadata.capabilities ?? [],
    runtime: metadata.runtime ?? null,
    providerFamily: metadata.providerFamily ?? metadata.provider_family ?? "",
    upstreamFormat: metadata.upstreamFormat ?? metadata.upstream_format ?? "",
    contextLength: Number(metadata.contextLength ?? metadata.context_length ?? 0),
    multimodalPolicy: metadata.multimodalPolicy ?? metadata.multimodal_policy ?? "",
    agentGatewayFormats: metadata.agentGatewayFormats ?? metadata.agent_gateway_formats ?? [],
  };
}

function offerIdForLocal(operator, metadataHash) {
  try {
    return ethers.keccak256(ethers.solidityPacked(["address", "bytes32"], [ethers.getAddress(operator), metadataHash]));
  } catch {
    return ethers.ZeroHash;
  }
}

async function normalizeProviderModelEvent(ev) {
  const a = ev.args ?? {};
  const u = providerUpdateEventArg(a, 3);
  if (u) {
    const operator = a.provider ?? a[0];
    const modelId = u.modelId ?? u[4] ?? "";
    return normalizeProvider({
      operator,
      serviceSigner: u.serviceSigner ?? u[0],
      metadataURI: u.metadataURI ?? u[1] ?? "",
      metadataHash: u.metadataHash ?? u[2] ?? ethers.ZeroHash,
      endpoint: u.endpoint ?? u[3] ?? "",
      modelId,
      pricingPolicyHash: u.pricingPolicyHash ?? u[5] ?? ethers.ZeroHash,
      tokenizerHash: u.tokenizerHash ?? u[6] ?? ethers.ZeroHash,
      inputTokenPrice: u.inputTokenPrice ?? u[7] ?? 0n,
      outputTokenPrice: u.outputTokenPrice ?? u[8] ?? 0n,
      minEscrowAmount: u.minEscrowAmount ?? u[9] ?? 0n,
      defaultIdleTimeout: u.defaultIdleTimeout ?? u[10] ?? 0n,
      active: u.active ?? u[11] ?? false,
      announcedAt: 0,
      updatedAt: 0,
      version: a.version ?? a[4] ?? 0n,
      providerId: a.providerId ?? a[1] ?? offerIdForLocal(operator, u.metadataHash ?? u[2] ?? ethers.ZeroHash),
    });
  }
  return normalizeProvider({
    operator: a.provider ?? a[1],
    serviceSigner: a.serviceSigner ?? a[3],
    metadataURI: a.metadataURI ?? a[4] ?? "",
    metadataHash: a.metadataHash ?? a[5] ?? ethers.ZeroHash,
    endpoint: a.endpoint ?? a[6] ?? "",
    modelId: a.modelId ?? a[7] ?? "",
    pricingPolicyHash: a.pricingPolicyHash ?? a[8] ?? ethers.ZeroHash,
    tokenizerHash: a.tokenizerHash ?? a[9] ?? ethers.ZeroHash,
    inputTokenPrice: a.inputTokenPrice ?? a[10] ?? 0n,
    outputTokenPrice: a.outputTokenPrice ?? a[11] ?? 0n,
    minEscrowAmount: a.minEscrowAmount ?? a[12] ?? 0n,
    defaultIdleTimeout: a.defaultIdleTimeout ?? a[13] ?? 0n,
    active: a.active ?? a[14] ?? false,
    announcedAt: 0,
    updatedAt: 0,
    version: a.version ?? a[15] ?? 0n,
    providerId: a.providerId ?? a[0] ?? offerIdForLocal(a.provider ?? a[1], a.metadataHash ?? a[5] ?? ethers.ZeroHash),
  });
}

async function normalizeProviderAnnounceEvent(ev) {
  const a = ev.args ?? {};
  const u = providerUpdateEventArg(a, 3);
  if (u) {
    const operator = a.provider ?? a[0];
    const modelId = u.modelId ?? u[4] ?? "";
    return normalizeProvider({
      operator,
      serviceSigner: u.serviceSigner ?? u[0],
      metadataURI: u.metadataURI ?? u[1] ?? "",
      metadataHash: u.metadataHash ?? u[2] ?? ethers.ZeroHash,
      endpoint: u.endpoint ?? u[3] ?? "",
      modelId,
      pricingPolicyHash: u.pricingPolicyHash ?? u[5] ?? ethers.ZeroHash,
      tokenizerHash: u.tokenizerHash ?? u[6] ?? ethers.ZeroHash,
      inputTokenPrice: u.inputTokenPrice ?? u[7] ?? 0n,
      outputTokenPrice: u.outputTokenPrice ?? u[8] ?? 0n,
      minEscrowAmount: u.minEscrowAmount ?? u[9] ?? 0n,
      defaultIdleTimeout: u.defaultIdleTimeout ?? u[10] ?? 0n,
      active: u.active ?? u[11] ?? false,
      announcedAt: 0,
      updatedAt: 0,
      version: a.version ?? a[4] ?? 0n,
      providerId: a.providerId ?? a[1] ?? offerIdForLocal(operator, u.metadataHash ?? u[2] ?? ethers.ZeroHash),
    });
  }
  const operator = a.provider ?? a[0];
  const metadataURI = a.metadataURI ?? a[3] ?? "";
  const metadataHash = a.metadataHash ?? a[2] ?? ethers.ZeroHash;
  const metadata = await loadProviderMetadata(metadataURI).catch(() => ({}));
  return normalizeProvider({
    operator,
    metadataURI,
    metadataHash,
    metadata,
    version: a.version ?? a[4] ?? 0n,
    providerId: a.offerId ?? a[1] ?? offerIdForLocal(operator, metadataHash),
  });
}

function emptyProvider(operator = null, modelId = "") {
  return normalizeProvider({
    operator: operator ? ethers.getAddress(operator) : ethers.ZeroAddress,
    metadataURI: "",
    metadataHash: ethers.ZeroHash,
    endpoint: "",
    modelId,
    pricingPolicyHash: ethers.ZeroHash,
    tokenizerHash: ethers.ZeroHash,
    inputTokenPrice: 0n,
    outputTokenPrice: 0n,
    minEscrowAmount: 0n,
    defaultIdleTimeout: 0n,
    active: false,
    announcedAt: 0,
    updatedAt: 0,
    version: 0,
    providerId: ethers.ZeroHash,
  });
}

function normalizeProviderUpdate(update) {
  if (!update) return { metadataURI: "", metadataHash: ethers.ZeroHash };
  return {
    metadataURI: update.metadataURI ?? "",
    metadataHash: update.metadataHash ?? ethers.ZeroHash,
  };
}

function providerUpdateEventArg(args, index) {
  const candidate = args?.update ?? args?.[index];
  if (!candidate || typeof candidate !== "object") return null;
  return candidate;
}

async function loadProviderMetadata(uri) {
  const text = String(uri ?? "");
  if (!text) return {};
  if (text.startsWith("data:")) {
    const comma = text.indexOf(",");
    if (comma < 0) return {};
    const header = text.slice(0, comma);
    const body = text.slice(comma + 1);
    const jsonText = header.includes(";base64")
      ? Buffer.from(body, "base64").toString("utf8")
      : decodeURIComponent(body);
    return JSON.parse(jsonText);
  }
  if (/^https?:\/\//i.test(text)) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    try {
      const res = await fetch(text, { signal: ctrl.signal });
      if (!res.ok) return {};
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
  return {};
}

function loadDeployment(overrideAddress) {
  for (const p of DEPLOYMENT_PATHS) {
    if (!fs.existsSync(p)) continue;
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    data.contract_address = data.protocol_address ?? data.proxy_address ?? data.contract_address;
    data.chain_id = data.chain_id ?? 1;
    if (overrideAddress) {
      data.contract_address = overrideAddress;
    }
    return data;
  }
  throw new Error("No deployment file found. Deploy mainnet protocol first or set contractAddress in config.");
}
