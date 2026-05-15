/**
 * dToken 合约客户端 — 统一入口
 *
 * 支持两种模式：
 * - local：本地 Mock 合约（HTTP）
 * - mainnet：真实 Ethereum mainnet（ethers.js）
 */

import { UpstreamBackendError } from "../backends/interface.js";
import { createEvmContractClient } from "./evmContract.js";

/**
 * 创建合约客户端
 *
 * @param {Object} config - 全局配置
 * @returns {Promise<Object>} 合约客户端对象
 */
export async function createContractClient(config) {
  const contractCfg = config.contract ?? {};
  const network = contractCfg.network ?? "local";

  if (network === "mainnet") {
    return createMainnetClient(contractCfg, config);
  }

  return createLocalContractClient(contractCfg.localContractBaseUrl ?? "http://127.0.0.1:8789");
}

/**
 * EVM 真实合约客户端
 */
async function createMainnetClient(contractCfg, config) {
  let client;

  try {
    client = await createEvmContractClient({
      rpcUrl: contractCfg.rpcUrl,
      contractAddress: contractCfg.protocolAddress || contractCfg.contractAddress,
      protocolAddress: contractCfg.protocolAddress || contractCfg.contractAddress,
      tokenAddress: contractCfg.tokenAddress,
      chainId: contractCfg.chainId,
      providerWalletPrivateKey: contractCfg.providerPrivateKey ?? null,
      providerOperatorPrivateKeys: collectProviderOperatorPrivateKeys(config),
      serviceSignerPrivateKey: config.provider?.serviceSigner ?? null,
    });
  } catch (error) {
    console.error(`[evm] Failed to create contract client: ${error.message}`);
    console.warn("[evm] Falling back to read-only stub — write operations unavailable");

    // 降级为只读桩
    return {
      mode: "mainnet",
      contractAddress: contractCfg.protocolAddress || contractCfg.contractAddress,
      chainId: contractCfg.chainId,
      providerSignerAddress: null,
      needsSigner: true,

      async health() {
        return { connected: false, error: error.message };
      },

      async getHandshake() {
        throw new UpstreamBackendError(
          "EVM contract unavailable: " + error.message,
          { statusCode: 502, code: "contract_unavailable" },
        );
      },

      async getProvider() {
        throw new UpstreamBackendError(
          "EVM contract unavailable",
          { statusCode: 502, code: "contract_unavailable" },
        );
      },
      async getProviderById() { throw new Error("Contract unavailable"); },
      async listProviderModels() { return []; },
      async listProviderListings() { return []; },

      async announceProvider() { throw new Error("Contract unavailable"); },
      async userCredentialDigest() { throw new Error("Contract unavailable"); },
      async userSettlementDigest() { throw new Error("Contract unavailable"); },
      async verifyUserCredential() { throw new Error("Contract unavailable"); },
      async providerSettle() { throw new Error("Contract unavailable"); },
      async providerSettleWithUserSettlement() { throw new Error("Contract unavailable"); },
      async providerClaimUserBreakup() { throw new Error("Contract unavailable"); },
      async challengeUserBreakupWithUserSettlement() { throw new Error("Contract unavailable"); },
      async finalizeUserBreakup() { throw new Error("Contract unavailable"); },
      async getProviderHandshakeIds() { return []; },
    };
  }

  // 适配 EVM 合约客户端接口到统一的 contract 接口
  return {
    mode: "mainnet",
    contractAddress: client.contractAddress,
    chainId: client.chainId,
    protocolVersion: client.protocolVersion,
    signingVersion: client.signingVersion,
    providerSignerAddress: client.signer?.address ?? null,
    needsSigner: !client.contractWithSigner,
    _client: client,

    health: () => client.health(),
    getHandshake: (id) => client.getHandshake(id),
    getProvider: (addr, modelId = null) => client.getProvider(addr, modelId),
    getProviderById: (providerId) => client.getProviderById(providerId),
    listProviderModels: (addr) => client.listProviderModels(addr),
    listProviderListings: () => client.listProviderListings(),

    async userCredentialDigest(credential) {
      return client.userSettlementDigest(credential);
    },

    async userSettlementDigest(settlement) {
      return client.userSettlementDigest(settlement);
    },

    async verifyUserCredential(credential, signature) {
      return client.verifyUserCredential(credential, signature);
    },

    async announceProvider(update) {
      return client.announceProvider(update);
    },

    // Provider 主动结算
    async providerSettle(handshakeId) {
      return client.providerSettle(handshakeId);
    },

    async providerSettleWithUserSettlement(settlement, userSignature, refreshUpdate = null) {
      return client.providerSettleWithUserSettlement(settlement, userSignature, refreshUpdate);
    },

    async providerClaimUserBreakup(handshakeId, refreshUpdate = null) {
      return client.providerClaimUserBreakup(handshakeId, refreshUpdate);
    },

    async challengeUserBreakupWithUserSettlement(settlement, userSignature, refreshUpdate = null) {
      return client.challengeUserBreakupWithUserSettlement(settlement, userSignature, refreshUpdate);
    },

    // Finalize 退出
    async finalizeUserBreakup(handshakeId) {
      return client.finalizeUserBreakup(handshakeId);
    },

    // 获取 Provider 的 handshake 列表
    async getProviderHandshakeIds(providerAddress) {
      return client.getProviderHandshakeIds(providerAddress);
    },
  };
}

function collectProviderOperatorPrivateKeys(config) {
  const keys = [];
  for (const identity of config.provider?.identities ?? []) {
    const key = identity.privateKey ?? identity.providerPrivateKey;
    if (key) keys.push(key);
  }
  for (const model of config.models ?? []) {
    const key = model.providerPrivateKey;
    if (key) keys.push(key);
  }
  return [...new Set(keys.filter(Boolean))];
}

/**
 * 本地 Mock 合约客户端
 */
function createLocalContractClient(baseUrl) {
  const base = baseUrl.replace(/\/$/, "");

  async function request(method, path, body = null) {
    const url = `${base}${path}`;
    const options = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(url, options);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new UpstreamBackendError(
        `Local contract returned ${response.status}: ${text}`,
        { statusCode: 502, code: "contract_error" },
      );
    }

    return response.json();
  }

  return {
    mode: "local",
    contractAddress: "0x0000000000000000000000000000000000000000",
    chainId: 0,
    providerSignerAddress: null,
    needsSigner: false,

    async health() {
      try {
        await request("GET", "/health");
        return { connected: true };
      } catch {
        return { connected: false };
      }
    },

    async getHandshake(handshakeId) {
      const raw = await request("GET", `/handshakes/${handshakeId}`);
      return {
        handshakeId: raw.handshake_id,
        status: raw.status === "OPEN" ? 1 : raw.status === "SETTLED" ? 3 : 0,
        statusName: raw.status,
        userWallet: raw.user_wallet,
        providerOperator: raw.provider_operator_wallet,
        handshakeCredentialHash: raw.handshake_credential_hash ?? raw.handshakeCredentialHash ?? "0x0000000000000000000000000000000000000000000000000000000000000000",
        escrowAmount: raw.escrow_amount,
        lastConfirmedCumulativeSpent: raw.last_safe_cumulative_spent ?? "0",
        latestUserCredentialCumulativeSpent: raw.cumulative_spent ?? "0",
        isOpen: raw.status === "OPEN",
        isSettled: raw.status === "SETTLED",
        remaining: (
          BigInt(raw.escrow_amount ?? "0") - BigInt(raw.cumulative_spent ?? "0")
        ).toString(),
        apiKey: raw.api_key,
        _raw: raw,
      };
    },

    async providerSettle(handshakeId) {
      return request("POST", "/settlement/provider-settle", { handshake_id: handshakeId });
    },

    async providerSettleWithUserSettlement() {
      throw new Error("Local providerSettleWithUserSettlement not implemented");
    },

    async verifyUserCredential() {
      return true;
    },

    async providerClaimUserBreakup(handshakeId) {
      return request("POST", "/settlement/finalize-user-breakup", { handshake_id: handshakeId });
    },

    async announceProvider() {
      return { announced: true, mode: "local" };
    },

    async finalizeUserBreakup(handshakeId) {
      return request("POST", "/settlement/finalize-user-breakup", { handshake_id: handshakeId });
    },

    async challengeUserBreakupWithUserSettlement() {
      throw new Error("Local challengeUserBreakupWithUserSettlement not implemented");
    },

    async getProviderHandshakeIds() {
      const state = await request("GET", "/state");
      return (state.handshakes ?? []).map((h) => h.handshake_id);
    },

    async getState() {
      return request("GET", "/state");
    },

    async reset() {
      return request("POST", "/reset");
    },
  };
}
