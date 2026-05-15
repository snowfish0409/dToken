export const grokCompany = {
  name: "grok",
  aliases: ["grok", "xai", "x.ai"],
  upstream: {
    type: "openai_compatible",
    responsesType: "xai_responses",
    providerFamily: "grok",
    messageFormat: "openai_chat_completions",
    baseUrl: "https://api.x.ai/v1",
    streamStrategy: "native_with_usage",
    includeStreamUsage: true,
    multimodalPolicy: "strip_unsupported_media_with_text",
  },
  capabilities: ["chat", "vision", "image", "reasoning"],
};
