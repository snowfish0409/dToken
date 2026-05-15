export const openrouterCompany = {
  name: "openrouter",
  aliases: ["openrouter", "llama", "meta", "meta_llama", "open_source"],
  upstream: {
    type: "openai_compatible",
    providerFamily: "openrouter",
    messageFormat: "openai_chat_completions",
    baseUrl: "https://openrouter.ai/api/v1",
    streamStrategy: "native_with_usage",
    includeStreamUsage: true,
    multimodalPolicy: "strip_unsupported_media_with_text",
  },
  capabilities: ["chat", "vision", "image", "reasoning"],
};
