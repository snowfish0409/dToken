import fs from "node:fs";
import path from "node:path";
import { Wallet } from "ethers";

loadDotEnv(path.resolve(process.cwd(), ".env"));

const { loadConfig, validateConfig } = await import("../apps/reseller-agent/src/config.js");

const config = loadConfig();
const errors = validateConfig(config);
const warnings = [];

checkPrivateKeyMatches({
  label: "DTOKEN_PROVIDER_PRIVATE_KEY",
  key: process.env.DTOKEN_PROVIDER_PRIVATE_KEY,
  address: config.provider.wallet,
  errors,
});

checkPrivateKeyMatches({
  label: "DTOKEN_SERVICE_SIGNER_KEY",
  key: process.env.DTOKEN_SERVICE_SIGNER_KEY,
  address: config.provider.serviceSignerAddress,
  errors,
});

if (!String(config.publicBaseUrl || "").endsWith("/v1")) {
  warnings.push("publicBaseUrl should normally end with /v1 because this is the endpoint Users copy from /v1/models.");
}

if (String(config.publicBaseUrl || "").startsWith("http://")) {
  warnings.push("publicBaseUrl uses HTTP. This works for a first test, but HTTPS is strongly recommended for production.");
}

const summary = {
  ok: errors.length === 0,
  errors,
  warnings,
  config: {
    providerName: config.provider.name,
    providerWallet: config.provider.wallet,
    serviceSignerAddress: config.provider.serviceSignerAddress,
    publicBaseUrl: config.publicBaseUrl,
    rpcHost: safeHost(config.contract.rpcUrl),
    contractChainId: config.contract.chainId,
    minEscrowAmount: config.provider.minEscrowAmount,
    upstreams: config.upstreams.map((upstream) => ({
      id: upstream.id,
      company: upstream.company,
      type: upstream.type,
      baseUrl: upstream.baseUrl,
      hasApiKey: hasSecret(upstream.apiKey),
    })),
    models: config.models.map((model) => ({
      displayName: model.displayName,
      upstreamId: model.upstreamId,
      upstreamModel: model.upstreamModel,
      providerWallet: model.providerWallet,
      contextLength: model.contextLength,
      capabilities: model.capabilities,
      inputTokenPrice: model.pricing?.inputTokenPrice,
      outputTokenPrice: model.pricing?.outputTokenPrice,
    })),
  },
};

console.log(JSON.stringify(summary, null, 2));
process.exit(errors.length === 0 ? 0 : 1);

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, valueRaw] = match;
    let value = valueRaw.trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function checkPrivateKeyMatches({ label, key, address, errors }) {
  if (!hasSecret(key) || !address || address.startsWith("0xYour")) return;
  try {
    const wallet = new Wallet(normalizePrivateKey(key));
    if (wallet.address.toLowerCase() !== String(address).toLowerCase()) {
      errors.push(`${label} derives ${wallet.address}, but configured address is ${address}`);
    }
  } catch (error) {
    errors.push(`${label} is not a valid EVM private key: ${error.message}`);
  }
}

function normalizePrivateKey(value) {
  const text = String(value || "").trim();
  return text.startsWith("0x") ? text : `0x${text}`;
}

function hasSecret(value) {
  const text = String(value ?? "").trim();
  return !!text && !text.startsWith("${") && !text.includes("your-") && !text.includes("Your");
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid)";
  }
}
