/**
 * dToken Reseller Agent — HTTP 服务入口
 *
 * 启动一个中间代理服务，将 User 的模型请求转发到商业 API，
 * 同时完成 dToken 计费、凭证签名和状态管理。
 */

import http from "node:http";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, validateConfig } from "./config.js";
import { sendJson, notFound } from "./http.js";
import { createKeyStore } from "./services/keyStore.js";
import { createUpstreamRouter } from "./services/upstream.js";
import { createContractClient } from "./services/contract.js";
import { createLedger } from "./services/ledger.js";
import { createRateLimiter } from "./middleware/rateLimit.js";
import { handleHealth } from "./routes/health.js";
import { handleModels } from "./routes/models.js";
import { handleChatCompletions } from "./routes/chatCompletions.js";
import { handleCredentialSignature } from "./routes/credentialSignatures.js";
import { handleAdminRoutes } from "./routes/admin.js";
import { hasLatestUserCredential, latestUserCredentialCumulative } from "./services/settlement.js";
import { parseDTokenAmount } from "./services/dtokenUnits.js";

export async function createResellerAgent(config = loadConfig()) {
  // 校验配置
  const errors = validateConfig(config);
  if (errors.length > 0) {
    console.error("[config] Validation errors:");
    for (const err of errors) console.error(`  - ${err}`);
  }

  const startTime = Date.now();

  // 初始化服务
  const keyStore = createKeyStore(config);
  const upstreamRouter = createUpstreamRouter(config);
  const contractClient = await createContractClient(config);
  const rateLimiter = createRateLimiter();
  const ledger = createLedger(config);
  const sessionsFile = path.resolve(config.ledger?.storagePath ?? "./data", "sessions.json");

  function persistSessions() {
    fs.mkdirSync(path.dirname(sessionsFile), { recursive: true });
    fs.writeFileSync(sessionsFile, JSON.stringify(keyStore.exportState(), null, 2), "utf8");
  }

  try {
    if (fs.existsSync(sessionsFile)) {
      const data = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
      keyStore.importState(data);
      console.log(`[init] Restored ${data.length} sessions from ${sessionsFile}`);
    }
  } catch (error) {
    console.warn(`[init] Could not restore sessions: ${error.message}`);
  }

  console.log(`[init] Upstreams: ${config.upstreams.map((u) => u.id).join(", ") || "(none)"}`);
  console.log(`[init] Models: ${config.models.map((m) => m.displayName).join(", ") || "(none)"}`);
  console.log(`[init] Sessions: ${keyStore.getTotalCount()} loaded, ${keyStore.getActiveCount()} active`);

  const server = http.createServer(async (request, response) => {
    // CORS preflight
    if (request.method === "OPTIONS") {
      sendJson(response, 204, {});
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host ?? "127.0.0.1"}`);
    const pathname = url.pathname;

    try {
      // ====== 健康检查 ======
      if (request.method === "GET" && pathname === "/health") {
        await handleHealth({ config, upstreamRouter, contractClient, startTime, response });
        return;
      }

      // ====== 模型列表 ======
      if (request.method === "GET" && pathname === "/v1/models") {
        handleModels({ config, upstreamRouter, response });
        return;
      }

      // ====== Chat Completion ======
      if (request.method === "POST" && pathname === "/v1/chat/completions") {
        await handleChatCompletions({
          config, keyStore, upstreamRouter,
          contractClient, rateLimiter, ledger,
          persistSessions, request, response,
        });
        return;
      }

      // ====== dToken User-signed credential ======
      if (
        request.method === "POST"
          && pathname === "/v1/dtoken/credential-signature"
      ) {
        await handleCredentialSignature({
          keyStore, contractClient,
          persistSessions, request, response,
        });
        return;
      }

      // ====== 管理接口 ======
      if (pathname.startsWith("/admin")) {
        await handleAdminRoutes({
          config, keyStore, upstreamRouter,
          contractClient, ledger, startTime,
          persistSessions, request, response, url,
        });
        return;
      }

      // ====== 404 ======
      notFound(response);
    } catch (error) {
      console.error(`[error] ${request.method} ${pathname}: ${error.message}`);
      sendJson(response, 500, {
        error: {
          type: "internal_error",
          code: "internal_error",
          message: "An unexpected error occurred",
        },
      });
    }
  });

  return {
    server, config, keyStore, upstreamRouter, contractClient, rateLimiter, ledger, startTime, persistSessions,
  };
}

export async function startResellerAgent(config = loadConfig()) {
  const runtime = await createResellerAgent(config);

  return new Promise((resolve, reject) => {
    runtime.server.once("error", reject);
    runtime.server.listen(config.port, () => {
      runtime.server.off("error", reject);

      console.log("");
      console.log("══════════════════════════════════════════");
      console.log(`  dToken Reseller Agent v1.0.0`);
      console.log(`  Provider: ${config.provider.name}`);
      console.log(`  Network:  ${config.contract.network} (chainId: ${config.contract.chainId})`);
      console.log(`  Protocol: ${config.contract.protocolAddress || config.contract.contractAddress}`);
      if (config.contract.tokenAddress) console.log(`  dToken:   ${config.contract.tokenAddress}`);
      console.log(`  Models:   ${config.models.map((m) => m.displayName).join(", ") || "(none)"}`);
      console.log(`  Upstreams: ${config.upstreams.map((u) => `${u.id}(${u.type})`).join(", ") || "(none)"}`);
      console.log(`  Listening: http://0.0.0.0:${config.port}`);
      console.log(`  Public:    ${config.publicBaseUrl}`);
      console.log("══════════════════════════════════════════");
      console.log("");

      // 启动自动结算定时器：同时检查本地 session 和 Provider 钱包名下的链上 handshake。
      const minProviderAutoSettleAmount = providerMinAutoSettleAmount(config);
      async function autoSettleCheck() {
        if (runtime.contractClient.mode !== "mainnet") return;
        const { handshakeIds, sessionByHandshake } = await collectAutoSettleHandshakeIds(runtime);
        for (const handshakeId of handshakeIds) {
          const sessionEntry = sessionByHandshake.get(normalizeId(handshakeId));
          const apiKey = sessionEntry?.apiKey ?? null;
          const session = sessionEntry?.session ?? null;
          try {
            const hs = await runtime.contractClient.getHandshake(handshakeId);
            const now = Math.floor(Date.now() / 1000);

            if (hs.status === 2) { // UserBreakupPending
              const pendingAmount = BigInt(hs.pendingCloseAmount ?? "0");
              const providerCredentialSpent = session && hasLatestUserCredential(session)
                ? latestUserCredentialCumulative(session)
                : 0n;
              const claimableAmount = providerCredentialSpent > pendingAmount
                ? providerCredentialSpent
                : pendingAmount;
              if (stopSessionForBreakup(runtime, apiKey)) {
                console.log(`[auto-settle] stopped service for pending breakup ${handshakeId}`);
              }

              if (claimableAmount <= minProviderAutoSettleAmount) {
                console.log(
                  `[auto-settle] low-value breakup ${handshakeId}: pending=${pendingAmount.toString()} signed=${providerCredentialSpent.toString()} threshold=${minProviderAutoSettleAmount.toString()}; service stopped, Provider will not spend gas`,
                );
                continue;
              }

              if (providerCredentialSpent > pendingAmount) {
                if (now >= hs.challengeDeadline) {
                  console.warn(
                    `[auto-settle] missed challenge window for ${handshakeId}: pending=${pendingAmount.toString()} signed=${providerCredentialSpent.toString()}; claiming pending amount instead`,
                  );
                } else if (session && hasLatestUserCredential(session)) {
                  try {
                    await runtime.contractClient.challengeUserBreakupWithUserSettlement(
                      session.latestUserCredential,
                      session.latestUserCredentialSignature,
                      session.providerUpdate,
                    );
                    stopSessionForBreakup(runtime, apiKey);
                    console.log(`[auto-settle] challenged dishonest breakup and settled ${handshakeId}`);
                  } catch(e) {
                    console.warn(`[auto-settle] challenge with user credential failed: ${e.message}`);
                  }
                  continue;
                }
              }

              try {
                await runtime.contractClient.providerClaimUserBreakup(handshakeId, session?.providerUpdate ?? null);
                stopSessionForBreakup(runtime, apiKey);
                console.log(`[auto-settle] claimed user breakup ${handshakeId}: pending=${pendingAmount.toString()} signed=${providerCredentialSpent.toString()}`);
              } catch(e) { console.warn(`[auto-settle] claim user breakup: ${e.message}`); }
            }

            if (session && hs.status === 3) { // Settled
              stopSessionForBreakup(runtime, apiKey);
              console.log(`[auto-settle] deactivated ${handshakeId}`);
            }
          } catch(e) {
            // RPC 偶尔失败忽略
          }
        }
      }

      setInterval(() => {
        autoSettleCheck().catch(() => {});
      }, 60000);
      console.log("[init] Auto-settle checker started (60s interval)");

      const persistIntervalMs = config.ledger?.autoSaveIntervalMs ?? 10000;
      const sessionPersistTimer = setInterval(() => {
        try { runtime.persistSessions(); }
        catch (error) { console.warn(`[sessions] Could not persist sessions: ${error.message}`); }
      }, persistIntervalMs);
      sessionPersistTimer.unref?.();
      runtime.sessionPersistTimer = sessionPersistTimer;
      console.log(`[init] Session persistence enabled (${persistIntervalMs}ms)`);

      resolve(runtime);
    });
  });
}

async function collectAutoSettleHandshakeIds(runtime) {
  const handshakeIds = new Map();
  const sessionByHandshake = new Map();
  for (const [apiKey, session] of runtime.keyStore.sessions) {
    if (!session?.handshakeId) continue;
    const id = normalizeId(session.handshakeId);
    handshakeIds.set(id, session.handshakeId);
    sessionByHandshake.set(id, { apiKey, session });
  }

  for (const wallet of configuredProviderWallets(runtime.config)) {
    try {
      const ids = await runtime.contractClient.getProviderHandshakeIds(wallet);
      for (const handshakeId of ids ?? []) {
        if (!handshakeId) continue;
        handshakeIds.set(normalizeId(handshakeId), handshakeId);
      }
    } catch (error) {
      console.warn(`[auto-settle] could not list provider handshakes for ${wallet}: ${error.message}`);
    }
  }

  return { handshakeIds: Array.from(handshakeIds.values()), sessionByHandshake };
}

function providerMinAutoSettleAmount(config) {
  try {
    return parseDTokenAmount(config.provider?.minProviderAutoSettleAmount ?? "1", "provider.minProviderAutoSettleAmount");
  } catch (error) {
    console.warn(`[auto-settle] invalid provider.minProviderAutoSettleAmount, using 1 dToken: ${error.message}`);
    return 1n;
  }
}

function stopSessionForBreakup(runtime, apiKey) {
  if (!apiKey) return false;
  const session = runtime.keyStore.sessions?.get(apiKey);
  if (!session || session.active === false) return false;
  runtime.keyStore.deactivateSession(apiKey);
  runtime.persistSessions();
  return true;
}

function configuredProviderWallets(config) {
  const wallets = [
    config.provider?.wallet,
    ...(config.provider?.identities ?? []).map((identity) => identity.wallet),
    ...(config.models ?? []).map((model) => model.providerWallet ?? model.providerOperator ?? config.provider?.wallet),
  ];
  const seen = new Set();
  const out = [];
  for (const wallet of wallets) {
    const key = normalizeAddressKey(wallet);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(wallet);
  }
  return out;
}

function normalizeAddressKey(value) {
  const text = String(value ?? "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? text.toLowerCase() : text;
}

function normalizeId(value) {
  const text = String(value ?? "").trim();
  return /^0x[0-9a-fA-F]{64}$/.test(text) ? text.toLowerCase() : text;
}

// 直接运行时启动
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // 支持 --config <path> 命令行参数
    const configArgIndex = process.argv.indexOf("--config");
    if (configArgIndex !== -1 && process.argv[configArgIndex + 1]) {
      process.env.DTOKEN_PROVIDER_CONFIG = process.argv[configArgIndex + 1];
    }
    const runtime = await startResellerAgent();

    // 优雅关闭
    const shutdown = async (signal) => {
      console.log(`\n[shutdown] Received ${signal}, shutting down...`);

      try {
        if (runtime.sessionPersistTimer) clearInterval(runtime.sessionPersistTimer);
        runtime.persistSessions();
        console.log("[shutdown] Saved sessions.");
      } catch (error) {
        console.warn(`[shutdown] Could not save sessions: ${error.message}`);
      }

      runtime.ledger.flush();
      runtime.server.close(() => {
        console.log("[shutdown] Done.");
        process.exit(0);
      });
      // 强制退出
      setTimeout(() => process.exit(1), 10000);
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  } catch (error) {
    console.error(`[fatal] ${error.message}`);
    process.exit(1);
  }
}
