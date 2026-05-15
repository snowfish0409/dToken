export const anthropicCompany = {
  name: "anthropic",
  aliases: ["anthropic", "claude"],
  upstream: {
    type: "anthropic_messages",
    providerFamily: "anthropic",
    messageFormat: "anthropic_messages",
    baseUrl: "https://api.anthropic.com/v1",
    anthropicVersion: "2023-06-01",
    defaultMaxTokens: 1024,
    streamStrategy: "native_with_usage",
    multimodalPolicy: "strip_unsupported_media_with_text",
  },
  capabilities: ["chat", "vision", "image", "file", "reasoning"],
};
