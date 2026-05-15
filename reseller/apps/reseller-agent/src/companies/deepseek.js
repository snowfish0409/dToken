export const deepseekCompany = {
  name: "deepseek",
  aliases: ["deepseek", "dpv4"],
  upstream: {
    type: "openai_compatible",
    providerFamily: "deepseek",
    messageFormat: "openai_chat_completions",
    baseUrl: "https://api.deepseek.com/v1",
    streamStrategy: "native_with_usage",
    includeStreamUsage: true,
    preserveReasoningContent: true,
    multimodalPolicy: "strip_unsupported_media_with_text",
  },
  capabilities: ["chat", "reasoning"],
};
