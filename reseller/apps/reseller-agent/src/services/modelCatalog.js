const PROVIDER_WALLET = "$provider.wallet";

export const MODEL_CATALOGS = Object.freeze({
  "reference-v1": [
    model("deepseek-v4-pro", "deepseek", "deepseek-v4-pro", "deepseek", "openai_chat_completions", 1048576, ["chat", "reasoning"], 4, 7),
    model("qwen3.6-plus", "qwen", "qwen3.6-plus", "qwen", "openai_chat_completions", 1048576, ["chat", "vision", "image", "video", "multimodal", "reasoning"], 15, 36),
  ],
});

export function expandModelCatalogs(config) {
  const requested = normalizeCatalogNames(config.modelCatalogs ?? config.modelCatalog);
  if (!requested.length) return config;

  const existing = new Set((config.models ?? []).map((item) => item.displayName));
  const catalogModels = [];
  for (const name of requested) {
    const catalog = MODEL_CATALOGS[name];
    if (!catalog) throw new Error(`Unknown model catalog "${name}"`);
    for (const item of catalog) {
      if (existing.has(item.displayName)) continue;
      catalogModels.push(materializeModel(item, config));
      existing.add(item.displayName);
    }
  }

  return {
    ...config,
    models: [...(config.models ?? []), ...catalogModels],
  };
}

export function supportedModelCatalogNames() {
  return Object.keys(MODEL_CATALOGS);
}

function model(displayName, upstreamId, upstreamModel, providerFamily, messageFormat, contextLength, capabilities, inputTokenPrice, outputTokenPrice) {
  return {
    displayName,
    upstreamId,
    upstreamModel,
    providerFamily,
    messageFormat,
    upstreamFormat: messageFormat,
    providerWallet: PROVIDER_WALLET,
    contextLength,
    capabilities,
    pricing: {
      inputTokenPrice: String(inputTokenPrice),
      outputTokenPrice: String(outputTokenPrice),
    },
  };
}

function materializeModel(item, config) {
  return {
    ...item,
    providerWallet: item.providerWallet === PROVIDER_WALLET
      ? config.provider?.wallet
      : item.providerWallet,
    pricing: { ...item.pricing },
    capabilities: [...item.capabilities],
  };
}

function normalizeCatalogNames(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : String(value).split(/[,\s]+/u);
  return [...new Set(list.map((item) => String(item ?? "").trim()).filter(Boolean))];
}
