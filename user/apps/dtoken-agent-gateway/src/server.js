import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { handleOptions, notFound, sendError, sendJson, sendHtml } from "./http.js";
import { createProfileStore } from "./core/profileStore.js";
import { createSerialQueue } from "./core/serialQueue.js";
import { createGatewayLedger } from "./core/ledger.js";
import { createUserStateStore } from "./core/userState.js";
import { handleModels, handleChatCompletions } from "./routes/openaiChat.js";
import { CLIENT_FORMATS } from "./core/formatBridge.js";
import { handleAdminRoutes } from "./routes/admin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const userDappPath = path.join(repoRoot, "deploy/user-dapp.html");
const dtokenAbiCandidates = [
  path.join(repoRoot, "deploy/mainnet-dtoken-v0.json"),
];
const dtokenAbiPath = dtokenAbiCandidates.find((p) => fs.existsSync(p)) ?? dtokenAbiCandidates[0];

export function createAgentGateway(config = loadConfig()) {
  const profileStore = createProfileStore(config);
  const queue = createSerialQueue();
  const ledger = createGatewayLedger(config);
  const userState = createUserStateStore(config);
  const startTime = Date.now();

  const server = http.createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      handleOptions(response);
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host ?? "127.0.0.1"}`);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (request.method === "GET" && (pathname === "/" || pathname === "/user-dapp" || pathname === "/user-dapp.html")) {
        sendHtml(response, 200, fs.readFileSync(userDappPath, "utf8"));
        return;
      }

      if (request.method === "GET" && pathname === "/mainnet-dtoken-v0.json") {
        sendStaticJson(response, fs.readFileSync(dtokenAbiPath, "utf8"));
        return;
      }

      if (request.method === "GET" && pathname === "/console") {
        response.writeHead(302, { Location: "/" });
        response.end();
        return;
      }

      if (request.method === "GET" && pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          service: "dtoken-user",
          phase: config.gateway.phase,
          uptime: Math.floor((Date.now() - startTime) / 1000),
          profileLoaded: !!profileStore.get(),
        });
        return;
      }

      if (request.method === "GET" && pathname === "/v1/models") {
        handleModels({ profileStore, ledger, response });
        return;
      }

      if (request.method === "POST" && pathname === "/v1/chat/completions") {
        await handleChatCompletions({ config, profileStore, queue, ledger, request, response, clientFormat: CLIENT_FORMATS.OPENAI_CHAT });
        return;
      }

      if (request.method === "POST" && (pathname === "/v1/responses" || pathname === "/responses")) {
        await handleChatCompletions({ config, profileStore, queue, ledger, request, response, clientFormat: CLIENT_FORMATS.OPENAI_RESPONSES });
        return;
      }

      if (request.method === "POST" && (pathname === "/anthropic/v1/messages" || pathname === "/v1/messages")) {
        await handleChatCompletions({ config, profileStore, queue, ledger, request, response, clientFormat: CLIENT_FORMATS.ANTHROPIC_MESSAGES });
        return;
      }

      if (pathname.startsWith("/admin")) {
        const handled = await handleAdminRoutes({
          config, profileStore, queue, ledger, request, response, pathname,
          userState,
        });
        if (handled) return;
      }

      notFound(response);
    } catch (error) {
      console.error(`[gateway] ${request.method} ${pathname}: ${error.stack || error.message}`);
      sendError(response, error.statusCode ?? 500, error.code ?? "internal_error", error.message);
    }
  });

  return { server, config, profileStore, queue, ledger, userState, startTime };
}

export function startAgentGateway(config = loadConfig()) {
  const runtime = createAgentGateway(config);
  return new Promise((resolve, reject) => {
    runtime.server.once("error", reject);
    runtime.server.listen(config.port, config.host, () => {
      runtime.server.off("error", reject);
      console.log("");
      console.log("  dToken User");
      console.log(`  UI:        ${config.publicBaseUrl}/`);
      console.log(`  Agent API: ${config.publicBaseUrl}/v1`);
      console.log(`  Data:      ${config.dataPath}`);
      console.log("");
      resolve(runtime);
    });
  });
}

function sendStaticJson(response, raw) {
  response.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(raw),
    "Access-Control-Allow-Origin": "*",
  });
  response.end(raw);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = await startAgentGateway();
  const shutdown = (signal) => {
    console.log(`\n[gateway] Received ${signal}, shutting down...`);
    runtime.server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
