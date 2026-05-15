export const mistralCompany = {
  name: "mistral",
  aliases: ["mistral", "magistral", "pixtral"],
  upstream: {
    type: "openai_compatible",
    providerFamily: "mistral",
    messageFormat: "openai_chat_completions",
    baseUrl: "https://api.mistral.ai/v1",
    streamStrategy: "native_with_usage",
    includeStreamUsage: true,
    multimodalPolicy: "strip_unsupported_media_with_text",
  },
  capabilities: ["chat", "vision", "image", "file", "reasoning"],
};
