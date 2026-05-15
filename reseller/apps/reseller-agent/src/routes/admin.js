/**
 * 管理接口
 *
 * GET  /admin/status     — 代理状态概览
 * GET  /admin/sessions   — 所有 session 列表
 * POST /admin/sessions/request — User 申请 API Key（链上验证后签发）
 * GET  /admin/sessions/:handshakeId/ledger — 调用记录
 * POST /admin/sessions/:handshakeId/settle  — 手动结算
 */

import { ethers } from "ethers";
import { parseDTokenAmount, modelPricing } from "../services/dtokenUnits.js";
import { sendJson, sendError, readJson, uptime } from "../http.js";
import { providerSettleWithLatestCredential } from "../services/settlement.js";
import { normalizeCapabilities } from "../services/messageCapabilities.js";
import { ZERO_HASH } from "../services/credentials.js";

export async function handleAdminRoutes({
  config, keyStore, upstreamRouter,
  contractClient, ledger, startTime,
  persistSessions,
  request, response, url,
}) {
  const pathname = url.pathname;
  const method = request.method;

  // GET /admin/status
  if (method === "GET" && pathname === "/admin/status") {
    const upstreamHealth = await upstreamRouter.healthAll();
    const summary = ledger.getSummary();

    sendJson(response, 200, {
      service: "dtoken-reseller-agent",
      provider: {
        name: config.provider.name,
        wallet: config.provider.wallet,
        wallets: configuredProviderWallets(config),
        network: config.contract.network,
      },
      contract: {
        mode: contractClient.mode,
        address: contractClient.contractAddress ?? config.contract.contractAddress,
        chainId: contractClient.chainId ?? config.contract.chainId,
        protocolVersion: contractClient.protocolVersion,
        signingVersion: contractClient.signingVersion,
      },
      upstreams: upstreamHealth,
      sessions: {
        total: keyStore.getTotalCount(),
        active: keyStore.getActiveCount(),
      },
      ledger: summary,
      uptime: uptime(startTime),
    });
    return;
  }

  // GET /admin/sessions
  if (method === "GET" && pathname === "/admin/sessions") {
    sendJson(response, 200, {
      sessions: keyStore.listSessions(),
    });
    return;
  }

  // POST /admin/provider/announce — 将当前 Provider 服务声明到当前 dToken 合约
  if (method === "POST" && pathname === "/admin/provider/announce") {
    let body = {};
    try {
      body = await readJson(request) ?? {};
    } catch {
      sendError(response, 400, "invalid_body", "Request body must be valid JSON");
      return;
    }

    if (contractClient.mode !== "mainnet") {
      sendError(response, 400, "unsupported_mode", "Provider announcement requires an EVM contract mode");
      return;
    }
    if (contractClient.needsSigner) {
      sendError(response, 400, "no_signer", "Provider signer not configured. Set DTOKEN_PROVIDER_PRIVATE_KEY env var.");
      return;
    }

    const modelCfg = findModelConfig(config, body.modelId ?? body.model ?? config.models?.[0]?.displayName);
    if (!modelCfg) {
      sendError(response, 400, "model_not_configured", "No configured model found to announce");
      return;
    }

    const update = buildProviderUpdate({ config, contractClient, modelCfg, body });
    try {
      const result = await contractClient.announceProvider(update);
      sendJson(response, 200, {
        announced: true,
        provider: update.providerWallet,
        model: update.modelId,
        endpoint: update.endpoint,
        pricingPolicyHash: update.pricingPolicyHash,
        tokenizerHash: update.tokenizerHash,
        inputTokenPrice: update.inputTokenPrice,
        outputTokenPrice: update.outputTokenPrice,
        minEscrowAmount: update.minEscrowAmount,
        txHash: result?.hash ?? result?.transactionHash,
      });
    } catch (error) {
      sendError(response, 502, "announce_failed", error.message);
    }
    return;
  }

  // GET /admin/providers — 查看所有已配置模型的链上声明
  if (method === "GET" && pathname === "/admin/providers") {
    try {
      const providers = [];
      for (const modelCfg of config.models ?? []) {
        const wallet = modelProviderWallet(config, modelCfg);
        try {
          providers.push({
            wallet,
            model: modelCfg.displayName,
            provider: await contractClient.getProvider(wallet, modelCfg.displayName),
          });
        } catch (error) {
          providers.push({
            wallet,
            model: modelCfg.displayName,
            error: error.message,
          });
        }
      }
      sendJson(response, 200, {
        providers,
        wallets: configuredProviderWallets(config),
      });
    } catch (error) {
      sendError(response, 502, "providers_query_failed", error.message);
    }
    return;
  }

  // GET /admin/provider — 查看当前 Provider 链上声明
  if (method === "GET" && pathname === "/admin/provider") {
    try {
      const modelName = url.searchParams.get("model");
      const modelCfg = modelName ? findModelConfig(config, modelName) : null;
      const providerWallet = url.searchParams.get("provider")
        ?? url.searchParams.get("wallet")
        ?? (modelCfg ? modelProviderWallet(config, modelCfg) : config.provider.wallet);
      const provider = await contractClient.getProvider(providerWallet, modelName);
      sendJson(response, 200, {
        provider,
        wallet: ethers.getAddress(providerWallet),
        model: modelName ?? provider.modelId ?? null,
        configured: isConfiguredProviderWallet(config, providerWallet),
        models: (config.models ?? [])
          .filter((m) => sameAddress(modelProviderWallet(config, m), providerWallet))
          .map((m) => m.displayName),
      });
    } catch (error) {
      sendError(response, 502, "provider_query_failed", error.message);
    }
    return;
  }

  // ====== 新增：POST /admin/sessions/request — User 申请 API Key ======
  if (method === "POST" && pathname === "/admin/sessions/request") {
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      sendError(response, 400, "invalid_body", "Request body must be valid JSON");
      return;
    }

    const { handshakeId, handshakeCredential } = body || {};
    if (!handshakeId || !handshakeCredential) {
      sendError(response, 400, "missing_params", "handshakeId and handshakeCredential are required");
      return;
    }
    if (!ethers.isHexString(handshakeCredential, 32)) {
      sendError(response, 400, "invalid_handshake_credential", "handshakeCredential must be a 32-byte hex string");
      return;
    }

    // 1. 从链上读取 handshake 状态（8 秒超时）
    let chainState;
    try {
      chainState = await Promise.race([
        contractClient.getHandshake(handshakeId),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("RPC timeout after 8s")), 8000)
        ),
      ]);
    } catch (error) {
      sendError(response, 504, "chain_timeout",
        "Chain query failed: " + error.message);
      return;
    }

    // 2. 验证 handshake 状态
    if (!chainState.isOpen) {
      sendError(response, 401, "handshake_not_open",
        `Handshake status is ${chainState.statusName}. It must be OPEN.`);
      return;
    }

    // 3. 验证 providerOperator。多模型模式下，每个模型可以配置独立 provider 钱包。
    const chainProviderWallet = ethers.getAddress(chainState.providerOperator);
    if (!isConfiguredProviderWallet(config, chainProviderWallet)) {
      sendError(response, 403, "provider_mismatch",
        "This handshake is for a provider wallet not configured on this reseller");
      return;
    }

    // 4. User 只能通过链上预承诺的握手凭证领取 API key。
    const expectedCredentialHash = normalizeHash(chainState.handshakeCredentialHash).toLowerCase();
    if (expectedCredentialHash === ethers.ZeroHash.toLowerCase()) {
      sendError(response, 409, "missing_handshake_credential_hash", "Handshake does not contain a credential hash");
      return;
    }
    const actualCredentialHash = hashHandshakeCredential({
      contractClient,
      config,
      handshakeCredential,
    }).toLowerCase();
    if (actualCredentialHash !== expectedCredentialHash) {
      sendError(response, 401, "invalid_handshake_credential", "Handshake credential does not match the on-chain commitment");
      return;
    }

    const modelMatch = await findModelForChainState(config, contractClient, chainState, body?.providerUpdate);
    const modelCfg = modelMatch?.modelCfg;
    const chainProviderUpdate = modelMatch?.providerUpdate ?? null;
    if (!modelCfg) {
      sendError(response, 409, "provider_model_not_configured",
        "No configured reseller model matches the on-chain handshake model/pricing snapshot");
      return;
    }
    // 5. 检查是否已有活跃 session（避免重复签发）
    const existing = keyStore.findByHandshakeId(handshakeId);
    if (existing && existing.active) {
      keyStore.syncSessionFromChain(existing, chainState);
      existing.providerUpdate = chainProviderUpdate ?? buildProviderUpdate({ config, contractClient, modelCfg, body: {} });
      applyModelRuntimeToSession(existing, modelCfg);
      persistSessions?.();
      sendJson(response, 200, {
        apiKey: existing.apiKey,
        endpoint: config.publicBaseUrl ?? `http://localhost:${config.port}/v1`,
        model: modelCfg.displayName,
        ...sessionRuntimeConfig(config, modelCfg),
        handshakeId,
        latestCredentialRound: existing.latestCredentialRound ?? 0,
        latestReceiptRound: existing.latestCredentialRound ?? 0,
        dtokenHashChain: sessionHashChainState(existing, chainState),
        reused: true,
      });
      return;
    }

    // 6. 创建链下 session 并签发 API key。Provider 不再为接入动作上链。
    const { apiKey, session } = keyStore.createSession({
      handshakeId,
      userWallet: ethers.getAddress(chainState.userWallet),
      escrowAmount: chainState.escrowAmount,
      modelScope: modelCfg.displayName,
      chainState,
    });
    session.providerUpdate = chainProviderUpdate ?? buildProviderUpdate({ config, contractClient, modelCfg, body: {} });
    applyModelRuntimeToSession(session, modelCfg);

    // 7. 返回凭据和当前 hash chain 状态；新 session 无消费时返回空链。
    persistSessions?.();
    sendJson(response, 200, {
      apiKey,
      endpoint: config.publicBaseUrl ?? `http://localhost:${config.port}/v1`,
      model: modelCfg.displayName,
      ...sessionRuntimeConfig(config, modelCfg),
      handshakeId,
      latestCredentialRound: session.latestCredentialRound ?? 0,
      latestReceiptRound: session.latestCredentialRound ?? 0,
      pricingPolicyHash: session.pricingPolicyHash,
      tokenizerHash: session.tokenizerHash,
      dtokenHashChain: sessionHashChainState(session, chainState),
    });
    return;
  }

  // GET /admin/sessions/:handshakeId/ledger
  const ledgerMatch = pathname.match(/^\/admin\/sessions\/(0x[a-fA-F0-9]+)\/ledger$/);
  if (method === "GET" && ledgerMatch) {
    const handshakeId = ledgerMatch[1];
    const records = ledger.queryByHandshake(handshakeId);
    sendJson(response, 200, { handshakeId, calls: records.length, records });
    return;
  }

  // POST /admin/sessions/:handshakeId/settle
  const settleMatch = pathname.match(/^\/admin\/sessions\/(0x[a-fA-F0-9]+)\/settle$/);
  if (method === "POST" && settleMatch) {
    const handshakeId = settleMatch[1];
    const session = keyStore.findByHandshakeId(handshakeId);

    if (!session) {
      sendError(response, 404, "not_found", `No session found for handshake ${handshakeId}`);
      return;
    }

    if (!session.active) {
      sendError(response, 409, "session_closed", "Session is already closed");
      return;
    }

    try {
      if (contractClient.mode === "local") {
        const { result } = await providerSettleWithLatestCredential({ contractClient, keyStore, session, persistSessions });
        sendJson(response, 200, {
          settled: true,
          handshakeId,
          cumulativeSpent: session.cumulativeSpent.toString(),
          lastConfirmedCumulativeSpent: session.credentialChain.lastConfirmedCumulativeSpent.toString(),
          result,
        });
      } else if (contractClient.mode === "mainnet") {
        if (!contractClient.needsSigner) {
          const settled = await providerSettleWithLatestCredential({ contractClient, keyStore, session, persistSessions });
          if (!settled.settled) {
            sendError(response, 409, "missing_user_credential", "Provider direct settlement requires the latest User-signed dToken credential");
            return;
          }
          sendJson(response, 200, {
            settled: true,
            handshakeId,
            cumulativeSpent: session.cumulativeSpent.toString(),
            lastConfirmedCumulativeSpent: session.credentialChain.lastConfirmedCumulativeSpent.toString(),
            txHash: settled.result?.hash ?? settled.result?.transactionHash,
          });
        } else {
          sendError(response, 400, "no_signer", "Provider signer not configured. Set DTOKEN_PROVIDER_PRIVATE_KEY env var.");
        }
      } else {
        sendError(response, 501, "not_implemented", "Settlement not available in current contract mode");
      }
    } catch (error) {
      sendError(response, 502, "settlement_error", error.message);
    }
    return;
  }

  // POST /admin/sessions/:handshakeId/stop — Provider 停止服务并结算
  const stopMatch = pathname.match(/^\/admin\/sessions\/(0x[a-fA-F0-9]+)\/stop$/);
  if (method === "POST" && stopMatch) {
    const handshakeId = stopMatch[1];
    const session = keyStore.findByHandshakeId(handshakeId);
    if (!session) { sendError(response, 404, "not_found", "Session not found"); return; }

    try {
      const chainState = await contractClient.getHandshake(handshakeId);
      if (chainState.isOpen) {
        const settled = await providerSettleWithLatestCredential({ contractClient, keyStore, session, persistSessions });
        if (!settled.settled) {
          sendError(response, 409, "missing_user_credential", "Provider direct stop requires the latest User-signed dToken credential");
          return;
        }
        sendJson(response, 200, {
          stopped: true, handshakeId,
          cumulativeSpent: session.cumulativeSpent.toString(),
          txHash: settled.result?.hash ?? settled.result?.transactionHash,
        });
      } else if (chainState.status === 2) {
        sendJson(response, 200, {
          stopped: false, handshakeId,
          status: chainState.statusName,
          message: "User already requested exit. Auto-settle timer will handle."
        });
      } else {
        sendJson(response, 200, {
          stopped: false, handshakeId,
          status: chainState.statusName,
          message: "Already settled or cancelled"
        });
      }
    } catch (e) {
      sendError(response, 502, "stop_error", e.message);
    }
    return;
  }

  // POST /admin/reset (仅 local 模式)
  if (method === "POST" && pathname === "/admin/reset") {
    if (contractClient.mode === "local") {
      try {
        await contractClient.reset();
        sendJson(response, 200, { reset: true });
      } catch (error) {
        sendError(response, 502, "reset_error", error.message);
      }
    } else {
      sendError(response, 403, "not_allowed", "Reset only available in local mode");
    }
    return;
  }

  // 404
  sendError(response, 404, "not_found", "Admin endpoint not found");
}

function findModelConfig(config, displayName) {
  const wanted = displayName ? String(displayName) : "";
  return config.models?.find((m) => m.displayName === wanted) ?? config.models?.[0] ?? null;
}

async function findModelForChainState(config, contractClient, chainState, submittedProviderUpdate = null) {
  const providerWallet = chainState.providerOperator;
  const providerAddr = providerWallet ? ethers.getAddress(providerWallet) : null;
  const offerId = normalizeHash(chainState.providerOfferId ?? chainState.providerId).toLowerCase();
  const candidates = (config.models ?? []).filter((m) =>
    !providerAddr || sameAddress(modelProviderWallet(config, m), providerAddr)
  );

  const submittedProvider = await providerFromSubmittedUpdate(providerAddr, offerId, submittedProviderUpdate);
  if (submittedProvider && providerEventIsDeclared(submittedProvider)) {
    const modelCfg = candidates.find((m) =>
      modelNameMatchesProvider(m, submittedProvider)
      && modelPricingMatchesProvider(m, submittedProvider)
    ) ?? (candidates.length === 1 && modelPricingMatchesProvider(candidates[0], submittedProvider) ? candidates[0] : null);
    if (modelCfg) {
      return {
        modelCfg,
        providerUpdate: providerUpdateFromChainProvider(submittedProvider),
        chainProvider: submittedProvider,
      };
    }
  }

  const exactCurrent = candidates.find((m) => {
    const update = buildProviderUpdate({ config, contractClient: null, modelCfg: m, body: {} });
    return providerAddr
      && offerId !== ethers.ZeroHash.toLowerCase()
      && offerIdForLocal(providerAddr, update.metadataHash).toLowerCase() === offerId;
  }) ?? null;
  if (exactCurrent) {
    return {
      modelCfg: exactCurrent,
      providerUpdate: buildProviderUpdate({ config, contractClient: null, modelCfg: exactCurrent, body: {} }),
    };
  }

  let chainProvider = null;
  if (providerAddr && offerId !== ethers.ZeroHash.toLowerCase()) {
    try {
      const listed = await contractClient.listProviderModels(providerAddr);
      chainProvider = listed.find((p) => String(p.providerId ?? p.offerId ?? "").toLowerCase() === offerId) ?? null;
    } catch (error) {
      console.warn(`[admin] provider event lookup by operator failed: ${error.message}`);
    }
    if (!chainProvider) {
      try {
        const byId = await contractClient.getProviderById(offerId);
        if (byId && String(byId.providerId ?? byId.offerId ?? "").toLowerCase() === offerId) {
          chainProvider = byId;
        }
      } catch (error) {
        console.warn(`[admin] provider event lookup by offerId failed: ${error.message}`);
      }
    }
  }

  if (chainProvider && providerEventIsDeclared(chainProvider)) {
    const modelCfg = candidates.find((m) =>
      modelNameMatchesProvider(m, chainProvider)
      && modelPricingMatchesProvider(m, chainProvider)
    ) ?? (candidates.length === 1 && modelPricingMatchesProvider(candidates[0], chainProvider) ? candidates[0] : null);
    if (modelCfg) {
      return {
        modelCfg,
        providerUpdate: providerUpdateFromChainProvider(chainProvider),
        chainProvider,
      };
    }
  }

  return null;
}

async function providerFromSubmittedUpdate(providerAddr, offerId, update) {
  if (!providerAddr || !update || typeof update !== "object") return null;
  const metadataHash = normalizeHash(update.metadataHash);
  if (metadataHash.toLowerCase() === ethers.ZeroHash.toLowerCase()) return null;
  if (offerId && offerId !== ethers.ZeroHash.toLowerCase()) {
    const derivedOfferId = offerIdForLocal(providerAddr, metadataHash).toLowerCase();
    if (derivedOfferId !== offerId) return null;
  }
  const metadataURI = String(update.metadataURI ?? "");
  const metadata = await loadSubmittedProviderMetadata(metadataURI).catch(() => ({}));
  if (Object.keys(metadata).length) {
    const computedHash = hashJson(metadata).toLowerCase();
    if (computedHash !== metadataHash.toLowerCase()) return null;
  }
  const pricing = metadata.pricing ?? {};
  return {
    operator: providerAddr,
    providerId: offerId && offerId !== ethers.ZeroHash.toLowerCase()
      ? offerId
      : offerIdForLocal(providerAddr, metadataHash),
    offerId: offerId && offerId !== ethers.ZeroHash.toLowerCase()
      ? offerId
      : offerIdForLocal(providerAddr, metadataHash),
    metadataURI,
    metadataHash,
    endpoint: metadata.endpoint ?? "",
    modelId: metadata.modelId ?? metadata.model_id ?? metadata.displayName ?? metadata.display_name ?? metadata.model_name ?? "",
    pricingPolicyHash: metadata.pricingPolicyHash ?? metadata.pricing_policy_hash ?? ZERO_HASH,
    tokenizerHash: metadata.tokenizerHash ?? metadata.tokenizer_hash ?? ZERO_HASH,
    inputTokenPrice: String(pricing.inputTokenPrice ?? pricing.input_token_price ?? "0"),
    outputTokenPrice: String(pricing.outputTokenPrice ?? pricing.output_token_price ?? "0"),
    minEscrowAmount: String(metadata.minEscrowAmount ?? metadata.min_escrow_amount ?? "0"),
    defaultIdleTimeout: Number(metadata.defaultIdleTimeout ?? metadata.default_idle_timeout ?? 0),
    active: true,
  };
}

async function loadSubmittedProviderMetadata(uri) {
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

function providerEventIsDeclared(provider) {
  const providerId = normalizeHash(provider?.providerId ?? provider?.offerId).toLowerCase();
  return !!provider
    && providerId !== ethers.ZeroHash.toLowerCase()
    && !!String(provider.modelId ?? "").trim();
}

function modelNameMatchesProvider(modelCfg, provider) {
  const providerModel = normalizeModelName(provider.modelId);
  if (!providerModel || providerModel === "unknown") return false;
  return [
    modelCfg.displayName,
    modelCfg.upstreamModel,
    modelCfg.modelId,
    modelCfg.model,
  ].some((name) => normalizeModelName(name) === providerModel);
}

function modelPricingMatchesProvider(modelCfg, provider) {
  const pricing = modelPricing(modelCfg);
  const input = toBigIntOrZero(provider.inputTokenPrice);
  const output = toBigIntOrZero(provider.outputTokenPrice);
  if (input > 0n && input !== pricing.inputTokenPrice) return false;
  if (output > 0n && output !== pricing.outputTokenPrice) return false;
  return true;
}

function providerUpdateFromChainProvider(provider) {
  const metadataHash = normalizeHash(provider?.metadataHash);
  return {
    providerWallet: provider.operator,
    providerOperator: provider.operator,
    metadataURI: provider.metadataURI ?? "",
    metadataHash,
    endpoint: provider.endpoint ?? "",
    modelId: provider.modelId ?? "",
    pricingPolicyHash: provider.pricingPolicyHash ?? ZERO_HASH,
    tokenizerHash: provider.tokenizerHash ?? ZERO_HASH,
    inputTokenPrice: String(provider.inputTokenPrice ?? "0"),
    outputTokenPrice: String(provider.outputTokenPrice ?? "0"),
    minEscrowAmount: String(provider.minEscrowAmount ?? "0"),
    defaultIdleTimeout: Number(provider.defaultIdleTimeout ?? 0),
  };
}

function normalizeModelName(value) {
  return String(value ?? "").trim().toLowerCase();
}

function toBigIntOrZero(value) {
  try {
    return BigInt(value ?? 0);
  } catch {
    return 0n;
  }
}

function buildProviderUpdate({ config, contractClient, modelCfg, body }) {
  const providerWallet = body.providerWallet
    ?? body.providerOperator
    ?? modelProviderWallet(config, modelCfg);
  const configuredPricing = modelPricing(modelCfg);
  const inputTokenPrice = body.inputTokenPrice != null
    ? parseDTokenAmount(body.inputTokenPrice, "inputTokenPrice")
    : configuredPricing.inputTokenPrice;
  const outputTokenPrice = body.outputTokenPrice != null
    ? parseDTokenAmount(body.outputTokenPrice, "outputTokenPrice")
    : configuredPricing.outputTokenPrice;
  const minEscrowAmount = parseDTokenAmount(
    body.minEscrowAmount ?? config.provider.minEscrowAmount ?? "0",
    "minEscrowAmount",
  );
  const pricingPolicyHash = body.pricingPolicyHash ?? hashJson({
    protocol: "dtoken-v5",
    unit: "dtoken_base_units",
    model: modelCfg.displayName,
    inputTokenPrice: inputTokenPrice.toString(),
    outputTokenPrice: outputTokenPrice.toString(),
  });
  const tokenizerHash = body.tokenizerHash ?? hashText(body.tokenizer ?? `${modelCfg.displayName}:upstream-tokenizer`);
  const endpoint = body.endpoint ?? config.publicBaseUrl;
  const metadata = {
    protocol: "dtoken-v5",
    schema: "dtoken.provider.metadata.v17",
    model_id: modelCfg.displayName,
    modelId: modelCfg.displayName,
    model_name: modelCfg.displayName,
    displayName: modelCfg.displayName,
    endpoint,
    pricing: {
      unit: "dtoken_base_units",
      inputTokenPrice: inputTokenPrice.toString(),
      outputTokenPrice: outputTokenPrice.toString(),
    },
    min_escrow_amount: minEscrowAmount.toString(),
    minEscrowAmount: minEscrowAmount.toString(),
    provider: providerWallet,
  };
  const metadataHash = body.metadataHash ?? hashJson(metadata);
  const metadataURI = body.metadataURI ?? dataJsonUri(metadata);

  return {
    providerWallet,
    providerOperator: providerWallet,
    metadataURI,
    metadataHash,
    endpoint,
    modelId: modelCfg.displayName,
    pricingPolicyHash,
    tokenizerHash,
    inputTokenPrice: inputTokenPrice.toString(),
    outputTokenPrice: outputTokenPrice.toString(),
    minEscrowAmount: minEscrowAmount.toString(),
    defaultIdleTimeout: Number(body.defaultIdleTimeout ?? config.provider.defaultIdleTimeout ?? 3600),
  };
}

function applyModelRuntimeToSession(session, modelCfg) {
  const pricing = modelPricing(modelCfg);
  session.modelHash = hashText(modelCfg.displayName ?? "");
  session.pricingPolicyHash = session.providerUpdate?.pricingPolicyHash ?? session.pricingPolicyHash;
  session.tokenizerHash = session.providerUpdate?.tokenizerHash ?? session.tokenizerHash;
  session.inputTokenPrice = pricing.inputTokenPrice;
  session.outputTokenPrice = pricing.outputTokenPrice;
}

function sessionRuntimeConfig(config, modelCfg) {
  const capabilities = normalizeCapabilities(modelCfg.capabilities ?? ["chat"]);
  const providerFamily = modelCfg.providerFamily ?? modelCfg.company ?? "";
  const upstreamFormat = modelCfg.messageFormat ?? modelCfg.upstreamFormat ?? upstreamFormatForModel(config, modelCfg);
  const messageFormat = "dtoken.multimodal.v1";
  const contextLength = Number(modelCfg.contextLength ?? 0);
  const multimodalPolicy = modelCfg.multimodalPolicy ?? "strip_unsupported_media_with_text";
  const inputModes = inputModesFromCapabilities(capabilities);
  const outputModes = outputModesFromCapabilities(capabilities);
  const agentGatewayFormats = ["openai_chat_completions", "openai_responses", "anthropic_messages"];
  const runtime = {
    protocol: "dtoken.runtime.v1",
    model: modelCfg.displayName,
    upstreamModel: modelCfg.upstreamModel ?? modelCfg.displayName,
    providerFamily,
    upstreamFormat,
    messageFormat,
    contextLength,
    capabilities,
    inputModes,
    outputModes,
    multimodalPolicy,
    incompatibleMedia: multimodalPolicy === "reject_unsupported_media"
      ? "reject_before_upstream"
      : "strip_if_text_remains_else_reject",
    agentGatewayFormats,
    tokenAccounting: "strict_upstream_usage",
  };
  return {
    capabilities,
    providerFamily,
    provider_family: providerFamily,
    upstreamFormat,
    upstream_format: upstreamFormat,
    messageFormat,
    message_format: messageFormat,
    contextLength,
    context_length: contextLength,
    inputModes,
    input_modes: inputModes,
    outputModes,
    output_modes: outputModes,
    multimodalPolicy,
    multimodal_policy: multimodalPolicy,
    agentGatewayFormats,
    agent_gateway_formats: agentGatewayFormats,
    runtime,
  };
}

function inputModesFromCapabilities(capabilities) {
  const modes = new Set(["text"]);
  for (const cap of normalizeCapabilities(capabilities)) {
    if (["vision", "image", "images", "image_url", "visual", "omni"].includes(cap)) modes.add("image");
    if (["audio", "audio_input", "speech", "voice", "omni"].includes(cap)) modes.add("audio");
    if (["video", "video_url", "video_input", "omni"].includes(cap)) modes.add("video");
    if (["file", "files", "document", "pdf", "document_input", "omni"].includes(cap)) modes.add("file");
  }
  return [...modes];
}

function upstreamFormatForModel(config, modelCfg = {}) {
  const upstream = (config.upstreams ?? []).find((item) => item.id === modelCfg.upstreamId) ?? {};
  const value = modelCfg.messageFormat ?? modelCfg.upstreamFormat ?? upstream.messageFormat ?? "";
  if (value) return value;
  if (upstream.type === "gemini" || upstream.type === "google_gemini") return "gemini_generate_content";
  if (upstream.type === "anthropic" || upstream.type === "anthropic_messages") return "anthropic_messages";
  if (upstream.type === "openai_responses") return "openai_responses";
  if (upstream.type === "xai_responses") return "xai_responses";
  return "openai_chat_completions";
}

function outputModesFromCapabilities(capabilities) {
  const modes = new Set(["text"]);
  for (const cap of normalizeCapabilities(capabilities)) {
    if (["image_output", "image_generation", "omni"].includes(cap)) modes.add("image");
    if (["audio_output", "speech_output", "voice_output", "omni"].includes(cap)) modes.add("audio");
    if (["video_output", "video_generation", "omni"].includes(cap)) modes.add("video");
    if (["file_output", "document_output"].includes(cap)) modes.add("file");
  }
  return [...modes];
}

function sessionHashChainState(session, chainState = null) {
  const latestCredentialHash = normalizeHash(
    session?.latestCredentialHash
      ?? session?.credentialChain?.latestCredentialHash
      ?? chainState?.latestUserCredentialHash
  );
  const latestCredentialRound = Number(
    session?.latestCredentialRound
      ?? session?.credentialChain?.latestCredentialRound
      ?? chainState?.latestUserCredentialRound
      ?? 0
  );
  const cumulativeSpent = String(
    session?.cumulativeSpent
      ?? session?.credentialChain?.cumulativeSpent
      ?? chainState?.latestUserCredentialCumulativeSpent
      ?? "0"
  );
  const lastConfirmedCumulativeSpent = String(
    session?.credentialChain?.lastConfirmedCumulativeSpent
      ?? chainState?.lastConfirmedCumulativeSpent
      ?? "0"
  );
  const previousCredentialHash = normalizeHash(session?.credentialChain?.previousCredentialHash);
  const credentialCount = Number(session?.credentialChain?.credentialCount ?? latestCredentialRound ?? 0);
  const latestCredential = session?.latestCredential ?? session?.latestUserCredential ?? null;
  const empty = latestCredentialRound === 0
    && latestCredentialHash.toLowerCase() === ZERO_HASH.toLowerCase()
    && cumulativeSpent === "0";

  return {
    version: "dtoken.hash-chain.v1",
    handshakeId: session?.handshakeId ?? chainState?.handshakeId ?? null,
    latestCredentialHash,
    latestReceiptHash: latestCredentialHash,
    latestCredentialRound,
    latestReceiptRound: latestCredentialRound,
    previousCredentialHash,
    credentialCount,
    cumulativeSpent,
    lastConfirmedCumulativeSpent,
    latestCredential,
    latestReceipt: latestCredential,
    latestUserCredential: session?.latestUserCredential ?? null,
    latestUserCredentialSignature: session?.latestUserCredentialSignature ?? null,
    empty,
  };
}

function hashText(value) {
  return ethers.keccak256(ethers.toUtf8Bytes(String(value ?? "")));
}

function hashJson(value) {
  return hashText(stableJson(value));
}

function dataJsonUri(value) {
  return `data:application/json;base64,${Buffer.from(stableJson(value), "utf8").toString("base64")}`;
}

function offerIdForLocal(operator, metadataHash) {
  try {
    return ethers.keccak256(ethers.solidityPacked(["address", "bytes32"], [ethers.getAddress(operator), metadataHash]));
  } catch {
    return ethers.ZeroHash;
  }
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
}

function hashHandshakeCredential({ contractClient, config, handshakeCredential }) {
  const chainId = BigInt(contractClient.chainId ?? config.contract?.chainId ?? 0);
  const contractAddress = ethers.getAddress(contractClient.contractAddress ?? config.contract?.contractAddress ?? ethers.ZeroAddress);
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint256", "address", "bytes32"],
    [
      ethers.keccak256(ethers.toUtf8Bytes("dtoken-handshake-v1")),
      chainId,
      contractAddress,
      handshakeCredential,
    ],
  );
  return ethers.keccak256(encoded);
}

function normalizeHash(value) {
  if (!value || value === "0x0") return ethers.ZeroHash;
  return value;
}

function getConfiguredServiceSigner(config, contractClient = null) {
  try {
    const value = config.provider.serviceSignerAddress || config.provider.wallet;
    return ethers.getAddress(value);
  } catch {
    return ethers.getAddress(config.provider.wallet);
  }
}

function modelProviderWallet(config, modelCfg) {
  return modelCfg?.providerWallet ?? modelCfg?.providerOperator ?? config.provider.wallet;
}

function configuredProviderWallets(config) {
  const wallets = [
    config.provider.wallet,
    ...(config.provider.identities ?? []).map((identity) => identity.wallet),
    ...(config.models ?? []).map((model) => modelProviderWallet(config, model)),
  ];
  const seen = new Set();
  const result = [];
  for (const wallet of wallets) {
    if (!wallet) continue;
    const normalized = normalizeAddressForCompare(wallet);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    try {
      result.push(ethers.getAddress(wallet));
    } catch {
      result.push(String(wallet));
    }
  }
  return result;
}

function isConfiguredProviderWallet(config, wallet) {
  return configuredProviderWallets(config).some((configured) => sameAddress(configured, wallet));
}

function sameAddress(a, b) {
  return normalizeAddressForCompare(a) === normalizeAddressForCompare(b);
}

function normalizeAddressForCompare(addr) {
  try {
    return ethers.getAddress(addr).toLowerCase();
  } catch {
    return String(addr ?? "").toLowerCase();
  }
}
