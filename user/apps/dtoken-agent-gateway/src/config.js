import fs from "node:fs";
import path from "node:path";

const DEFAULT_CONFIG = {
  host: "127.0.0.1",
  port: 8789,
  publicBaseUrl: "http://127.0.0.1:8789",
  profilePath: "",
  dataPath: "apps/dtoken-agent-gateway/data",
  gateway: {
    phase: "phase2-format-bridge",
    allowProfileInstall: true,
    exposeDTokenMetadata: false,
    defaultBudgetLimitDToken: null,
    minRoundReserveDToken: "1",
  },
  compatibility: {
    openaiChatCompletions: true,
    openaiResponses: true,
    anthropicMessages: true,
  },
};

export function loadConfig(argv = process.argv) {
  const args = parseArgs(argv);
  const filePath = args.config ?? process.env.DTOKEN_AGENT_GATEWAY_CONFIG ?? "";
  let fileConfig = {};
  if (filePath) {
    fileConfig = readJson(filePath);
  }

  const config = mergeConfig(DEFAULT_CONFIG, fileConfig);
  if (args.profile) config.profilePath = args.profile;
  if (args.port) config.port = Number(args.port);
  if (process.env.DTOKEN_AGENT_PROFILE) config.profilePath = process.env.DTOKEN_AGENT_PROFILE;
  if (process.env.DTOKEN_AGENT_GATEWAY_PORT || process.env.PORT) {
    config.port = Number(process.env.DTOKEN_AGENT_GATEWAY_PORT ?? process.env.PORT);
  }
  if (process.env.DTOKEN_AGENT_GATEWAY_HOST) {
    config.host = process.env.DTOKEN_AGENT_GATEWAY_HOST;
  }
  if (process.env.DTOKEN_AGENT_GATEWAY_DATA) {
    config.dataPath = process.env.DTOKEN_AGENT_GATEWAY_DATA;
  }
  if (process.env.DTOKEN_AGENT_GATEWAY_PUBLIC_BASE_URL) {
    config.publicBaseUrl = process.env.DTOKEN_AGENT_GATEWAY_PUBLIC_BASE_URL;
  } else if (!fileConfig.publicBaseUrl && config.host && config.port) {
    const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
    config.publicBaseUrl = `http://${host}:${config.port}`;
  }

  config.dataPath = path.resolve(config.dataPath);
  if (config.profilePath) config.profilePath = path.resolve(config.profilePath);
  return config;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config" && argv[i + 1]) args.config = argv[++i];
    else if (arg === "--profile" && argv[i + 1]) args.profile = argv[++i];
    else if (arg === "--port" && argv[i + 1]) args.port = argv[++i];
  }
  return args;
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const expanded = raw.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
  return JSON.parse(expanded);
}

function mergeConfig(base, override) {
  return {
    ...base,
    ...override,
    gateway: { ...base.gateway, ...(override.gateway ?? {}) },
    compatibility: { ...base.compatibility, ...(override.compatibility ?? {}) },
  };
}
