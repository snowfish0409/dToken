import { OpenAICompatibleBackend } from "./openaiCompatible.js";

const DEFAULT_QWEN_CODING_PLAN_BASE_URL = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
const DEFAULT_HEALTH_MODEL = "qwen3.6-plus";

/**
 * Qwen Coding Plan backend.
 *
 * Coding Plan keys use a dedicated token-plan key family and endpoint.
 * They are OpenAI-compatible for chat completions, but the endpoint does not
 * expose the generic `/models` probe used by the normal OpenAI-compatible
 * adapter. Keep this adapter separate so legacy DashScope/Qwen behavior remains
 * untouched.
 */
export class QwenCodingPlanBackend extends OpenAICompatibleBackend {
  constructor(config = {}) {
    super({
      ...config,
      id: config.id ?? "qwen-coding-plan",
      baseUrl: config.baseUrl ?? DEFAULT_QWEN_CODING_PLAN_BASE_URL,
      messageFormat: config.messageFormat ?? "openai_chat_completions",
      streamStrategy: config.streamStrategy ?? "native_with_usage",
      includeStreamUsage: config.includeStreamUsage ?? true,
      preserveReasoningContent: config.preserveReasoningContent ?? true,
    });
    this.healthModel = config.healthModel ?? DEFAULT_HEALTH_MODEL;
  }

  async health() {
    const start = Date.now();
    try {
      const response = await this._fetch("/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: this.healthModel,
          messages: [{ role: "user", content: "ok" }],
          max_tokens: 1,
          stream: false,
        }),
      });
      const latencyMs = Date.now() - start;
      return { ok: response.ok, latencyMs, details: { status: response.status, probe: "chat_completions" } };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        details: { error: error.message, probe: "chat_completions" },
      };
    }
  }
}
