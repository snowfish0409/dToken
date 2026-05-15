export const glmCompany = {
  name: "glm",
  aliases: ["glm", "zhipu", "bigmodel"],
  upstream: {
    type: "openai_compatible",
    providerFamily: "glm",
    messageFormat: "openai_chat_completions",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    streamStrategy: "native_with_usage",
    includeStreamUsage: true,
    multimodalPolicy: "strip_unsupported_media_with_text",
  },
  capabilities: ["chat"],
};
