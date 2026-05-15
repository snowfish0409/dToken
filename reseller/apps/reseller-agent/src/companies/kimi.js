export const kimiCompany = {
  name: "kimi",
  aliases: ["kimi", "moonshot"],
  upstream: {
    type: "openai_compatible",
    providerFamily: "kimi",
    messageFormat: "openai_chat_completions",
    baseUrl: "https://api.moonshot.cn/v1",
    streamStrategy: "native_with_usage",
    includeStreamUsage: true,
    multimodalPolicy: "strip_unsupported_media_with_text",
  },
  capabilities: ["chat"],
};
