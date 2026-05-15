export const qwenCompany = {
  name: "qwen",
  aliases: ["qwen", "dashscope", "aliyun", "alibaba"],
  upstream: {
    type: "openai_compatible",
    providerFamily: "qwen",
    messageFormat: "openai_chat_completions",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    streamStrategy: "native_with_usage",
    includeStreamUsage: true,
    multimodalPolicy: "strip_unsupported_media_with_text",
  },
  capabilities: ["chat", "vision", "image", "video", "audio", "file", "multimodal"],
};
