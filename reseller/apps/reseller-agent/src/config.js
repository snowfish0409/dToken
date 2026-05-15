/**
 * 配置加载与校验
 *
 * 配置优先级：环境变量 > 配置文件 > 默认值
 * 敏感字段（私钥、API key、RPC URL）仅通过环境变量注入
 */

import fs from "node:fs";
import path from "node:path";
import { applyCompanyDefaults, supportedCompanyNames } from "./companies/index.js";
import { isDTokenAmount, parseDTokenAmount } from "./services/dtokenUnits.js";
import { expandModelCatalogs } from "./services/modelCatalog.js";

const DEFAULT_CONFIG = {
  port: 8788,
  publicBaseUrl: "http://127.0.0.1:8788/v1",

  provider: {
    name: "dToken Reseller Agent",
    wallet: "0x0000000000000000000000000000000000000000",
    serviceSigner: "",
    serviceSignerAddress: "0x0000000000000000000000000000000000000000",
    minEscrowAmount: "50000",
    minProviderAutoSettleAmount: "1",
  },

  contract: {
    network: "mainnet",
    rpcUrl: "",
    contractAddress: "0x0000000000000000000000000000000000000000",
    protocolAddress: "",
    tokenAddress: "",
    chainId: 1,
    localContractBaseUrl: "http://127.0.0.1:8789",
    providerPrivateKey: "",
  },

  upstreams: [],

  models: [],
  modelCatalogs: [],

  accessKeys: [],

  ledger: {
    storagePath: "./data",
    autoSaveIntervalMs: 10000,
    saveMessages: false,
  },

  logging: {
    level: "info",
    format: "text",
  },
};

/**
 * 加载配置
 * @returns {Object} 合并后的配置对象
 */
export function loadConfig() {
  const configPath = process.env.DTOKEN_PROVIDER_CONFIG;
  let fileConfig = {};

  if (configPath) {
    fileConfig = readJsonConfig(configPath);
  } else {
    // 尝试默认路径；公开发布包不再自动加载 demo/example 配置，避免误用旧价格或示例 API key。
    const defaultPaths = [
      path.join(process.cwd(), "config", "default.json"),
    ];
    for (const p of defaultPaths) {
      if (fs.existsSync(p)) {
        fileConfig = readJsonConfig(p);
        break;
      }
    }
  }

  const merged = applyEnvOverrides(mergeConfig(DEFAULT_CONFIG, fileConfig));

  // 环境变量必须先覆盖，再展开模型目录；模型 metadata 需要使用真实 provider wallet / endpoint。
  return filterUnavailableOptionalUpstreams(applyCompanyDefaults(expandModelCatalogs(merged)));
}

function readJsonConfig(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    // 支持环境变量占位符 ${VAR_NAME}
    const expanded = raw.replace(/\$\{(\w+)\}/g, (_, name) => {
      return process.env[name] ?? "";
    });
    return JSON.parse(expanded);
  } catch (error) {
    throw new Error(`Failed to read config at ${filePath}: ${error.message}`);
  }
}

function mergeConfig(base, override) {
  const merged = { ...base };

  // 深度合并 provider
  merged.provider = { ...base.provider, ...(override.provider ?? {}) };

  // 深度合并 contract
  merged.contract = { ...base.contract, ...(override.contract ?? {}) };

  // 深度合并 ledger
  merged.ledger = { ...base.ledger, ...(override.ledger ?? {}) };

  // 深度合并 logging
  merged.logging = { ...base.logging, ...(override.logging ?? {}) };

  // 数组字段：直接覆盖
  merged.upstreams = override.upstreams ?? base.upstreams;
  merged.models = override.models ?? base.models;
  merged.modelCatalogs = override.modelCatalogs ?? override.modelCatalog ?? base.modelCatalogs;
  merged.accessKeys = override.accessKeys ?? base.accessKeys;

  // 简单字段
  merged.port = override.port ?? base.port;
  merged.publicBaseUrl = override.publicBaseUrl ?? base.publicBaseUrl;

  return merged;
}

function applyEnvOverrides(config) {
  // 端口
  if (process.env.DTOKEN_PORT || process.env.PORT) {
    config.port = Number(process.env.DTOKEN_PORT ?? process.env.PORT);
  }

  if (process.env.DTOKEN_PUBLIC_BASE_URL) {
    config.publicBaseUrl = process.env.DTOKEN_PUBLIC_BASE_URL;
  }

  if (process.env.DTOKEN_PROVIDER_WALLET) {
    config.provider.wallet = process.env.DTOKEN_PROVIDER_WALLET;
  }

  if (process.env.DTOKEN_MIN_PROVIDER_AUTO_SETTLE_AMOUNT) {
    config.provider.minProviderAutoSettleAmount = process.env.DTOKEN_MIN_PROVIDER_AUTO_SETTLE_AMOUNT;
  }

  if (process.env.DTOKEN_PROVIDER_IDENTITIES_JSON) {
    try {
      config.provider.identities = JSON.parse(process.env.DTOKEN_PROVIDER_IDENTITIES_JSON);
    } catch {
      throw new Error("DTOKEN_PROVIDER_IDENTITIES_JSON must be valid JSON");
    }
  }

  if (process.env.DTOKEN_SERVICE_SIGNER_ADDRESS) {
    config.provider.serviceSignerAddress = process.env.DTOKEN_SERVICE_SIGNER_ADDRESS;
  }

  // 合约 RPC
  if (process.env.DTOKEN_CONTRACT_RPC) {
    config.contract.rpcUrl = process.env.DTOKEN_CONTRACT_RPC;
  }

  // Provider 钱包私钥（用于合约写操作）
  if (process.env.DTOKEN_PROVIDER_PRIVATE_KEY) {
    config.contract.providerPrivateKey = process.env.DTOKEN_PROVIDER_PRIVATE_KEY;
  }

  // Provider 签名私钥
  if (process.env.DTOKEN_SERVICE_SIGNER_KEY) {
    config.provider.serviceSigner = process.env.DTOKEN_SERVICE_SIGNER_KEY;
  }

  // 上游 API key 注入
  // 环境变量格式：DTOKEN_UPSTREAM_<UPSTREAM_ID>_KEY
  for (const upstream of config.upstreams) {
    const envVar = `DTOKEN_UPSTREAM_${envId(upstream.id)}_KEY`;
    if (process.env[envVar]) {
      upstream.apiKey = process.env[envVar];
    }
  }

  // 合约地址覆盖
  if (process.env.DTOKEN_CONTRACT_ADDRESS) {
    config.contract.contractAddress = process.env.DTOKEN_CONTRACT_ADDRESS;
  }
  if (process.env.DTOKEN_PROTOCOL_ADDRESS) {
    config.contract.protocolAddress = process.env.DTOKEN_PROTOCOL_ADDRESS;
    config.contract.contractAddress = process.env.DTOKEN_PROTOCOL_ADDRESS;
  }
  if (process.env.DTOKEN_TOKEN_ADDRESS) {
    config.contract.tokenAddress = process.env.DTOKEN_TOKEN_ADDRESS;
  }

  // 本地合约 URL 覆盖
  if (process.env.DTOKEN_CONTRACT_BASE_URL) {
    config.contract.localContractBaseUrl = process.env.DTOKEN_CONTRACT_BASE_URL;
  }

  return config;
}

function filterUnavailableOptionalUpstreams(config) {
  const skipped = new Set();
  const upstreams = [];
  for (const upstream of config.upstreams ?? []) {
    if (upstream.optional === true && !isUsableSecret(upstream.apiKey)) {
      skipped.add(upstream.id);
      continue;
    }
    upstreams.push(upstream);
  }
  if (!skipped.size) return config;
  return {
    ...config,
    upstreams,
    models: (config.models ?? []).filter((model) => !skipped.has(model.upstreamId)),
  };
}

function isUsableSecret(value) {
  const text = String(value ?? "").trim();
  return !!text && text !== "YOUR_API_KEY_HERE" && !text.startsWith("${");
}

/**
 * 校验配置
 * @param {Object} config
 * @returns {string[]} 错误列表（空数组表示通过）
 */
export function validateConfig(config) {
  const errors = [];

  // Provider
  if (!isValidAddress(config.provider.wallet)) {
    errors.push("provider.wallet is not a valid Ethereum address");
  }
  for (const identity of config.provider.identities ?? []) {
    if (!isValidAddress(identity.wallet ?? "")) {
      errors.push("provider.identities[].wallet is not a valid Ethereum address");
    }
  }
  if (!isDTokenAmount(config.provider.minEscrowAmount ?? "0")) {
    errors.push("provider.minEscrowAmount must be a non-negative dToken amount");
  }
  if (!isDTokenAmount(config.provider.minProviderAutoSettleAmount ?? "0")) {
    errors.push("provider.minProviderAutoSettleAmount must be a non-negative dToken amount");
  }

  // Upstreams
  const upstreamIds = new Set();
  const supportedUpstreamTypes = new Set([
    "openai_compatible",
    "openai_responses",
    "xai_responses",
    "qwen_coding_plan",
    "anthropic",
    "anthropic_messages",
    "gemini",
    "google_gemini",
  ]);
  for (const us of config.upstreams) {
    if (!us.id) {
      errors.push("upstream missing 'id'");
      continue;
    }
    if (upstreamIds.has(us.id)) {
      errors.push(`duplicate upstream id: ${us.id}`);
    }
    upstreamIds.add(us.id);

    if (!supportedUpstreamTypes.has(us.type)) {
      errors.push(`upstream "${us.id}" has unsupported type "${us.type}". Use one of ${[...supportedUpstreamTypes].join(", ")} or company: ${supportedCompanyNames().join(", ")}`);
    }
    if (!us.baseUrl && !["anthropic", "anthropic_messages", "gemini", "google_gemini"].includes(us.type)) {
      errors.push(`upstream "${us.id}" missing baseUrl`);
    }
    if (!isUsableSecret(us.apiKey)) {
      errors.push(`upstream "${us.id}" apiKey is not set — set DTOKEN_UPSTREAM_${envId(us.id)}_KEY env var`);
    }
  }

  // Models
  const displayNames = new Set();
  const supportedMessageFormats = new Set([
    "openai_chat_completions",
    "openai_compatible",
    "openai_responses",
    "xai_responses",
    "anthropic_messages",
    "gemini_generate_content",
  ]);
  for (const m of config.models) {
    if (!m.displayName) {
      errors.push("model missing 'displayName'");
      continue;
    }
    if (displayNames.has(m.displayName)) {
      errors.push(`duplicate model displayName: ${m.displayName}`);
    }
    displayNames.add(m.displayName);

    if (!upstreamIds.has(m.upstreamId)) {
      errors.push(`model "${m.displayName}" references unknown upstream "${m.upstreamId}"`);
    }

    if (!m.pricing
      || !isDTokenAmount(m.pricing.inputTokenPrice)
      || !isDTokenAmount(m.pricing.outputTokenPrice)) {
      errors.push(`model "${m.displayName}" has invalid pricing; prices must be dToken per LLM token`);
    } else if (
      parseDTokenAmount(m.pricing.inputTokenPrice, "inputTokenPrice") === 0n
      && parseDTokenAmount(m.pricing.outputTokenPrice, "outputTokenPrice") === 0n
    ) {
      errors.push(`model "${m.displayName}" has invalid pricing; inputTokenPrice and outputTokenPrice cannot both be zero`);
    }

    const providerWallet = m.providerWallet ?? m.providerOperator;
    if (providerWallet && !isValidAddress(providerWallet)) {
      errors.push(`model "${m.displayName}" providerWallet is not a valid Ethereum address`);
    }
    if (m.messageFormat && !supportedMessageFormats.has(m.messageFormat)) {
      errors.push(`model "${m.displayName}" has unsupported messageFormat "${m.messageFormat}"`);
    }
  }

  return errors;
}

function isValidAddress(addr) {
  return /^0x[0-9a-fA-F]{40}$/.test(addr) || addr.startsWith("0xMock") || addr.startsWith("0xProvider") || addr.startsWith("0xService");
}

function envId(id) {
  return String(id ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}
