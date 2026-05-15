export const openaiCompany = {
  name: "openai",
  aliases: ["openai", "chatgpt", "gpt"],
  upstream: {
    type: "openai_compatible",
    responsesType: "openai_responses",
    providerFamily: "openai",
    messageFormat: "openai_chat_completions",
    baseUrl: "https://api.openai.com/v1",
    streamStrategy: "native_with_usage",
    includeStreamUsage: true,
    multimodalPolicy: "strip_unsupported_media_with_text",
  },
  capabilities: ["chat", "vision", "image", "file", "reasoning"],
};
