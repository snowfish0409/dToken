export const geminiCompany = {
  name: "gemini",
  aliases: ["gemini", "google", "google_gemini"],
  upstream: {
    type: "gemini",
    providerFamily: "gemini",
    messageFormat: "gemini_generate_content",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    streamStrategy: "native_with_usage",
    multimodalPolicy: "strip_unsupported_media_with_text",
  },
  capabilities: ["chat", "vision", "image", "audio", "video", "file", "multimodal", "reasoning"],
};
