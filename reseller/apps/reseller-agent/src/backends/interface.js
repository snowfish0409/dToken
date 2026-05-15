/**
 * 上游后端统一接口定义
 *
 * 每个上游后端驱动必须实现此接口。
 * - local：本地模型后端（vLLM / Ollama / LM Studio）
 * - provider service：Provider 模型服务后端（OpenAI / Anthropic / DeepSeek 等）
 * - custom：未来扩展
 */

export class UpstreamBackendError extends Error {
  constructor(message, { statusCode = 502, code = "upstream_error", upstreamRequestId = null } = {}) {
    super(message);
    this.name = "UpstreamBackendError";
    this.statusCode = statusCode;
    this.code = code;
    this.upstreamRequestId = upstreamRequestId;
  }
}

/**
 * @typedef {Object} UpstreamModel
 * @property {string} id - 上游模型名
 * @property {string} [displayName]
 * @property {number} contextLength
 * @property {string[]} capabilities
 */

/**
 * @typedef {Object} UpstreamChatRequest
 * @property {string} model
 * @property {Array<{role: string, content: string|Array}>} messages
 * @property {number} [maxTokens]
 * @property {number} [temperature]
 * @property {Record<string, any>} [extra]
 */

/**
 * @typedef {Object} UpstreamChatResponse
 * @property {string} id
 * @property {string} object
 * @property {number} created
 * @property {string} model
 * @property {Array<{index: number, message: {role: string, content: string}, finish_reason: string}>} choices
 * @property {{promptTokens: number, completionTokens: number, totalTokens: number, rawCompletionTokens?: number|null, reasoningTokens?: number|null, hiddenOutputTokens?: number|null, promptCacheHitTokens?: number|null, promptCacheMissTokens?: number|null, billableOutputSource?: string, raw?: any}} usage
 * @property {any} [raw]
 */

/**
 * @typedef {Object} UpstreamCost
 * @property {string} estimatedDtokenEquivalent
 * @property {number} upstreamPromptTokens
 * @property {number} upstreamCompletionTokens
 * @property {number} [upstreamPricePerInputToken]
 * @property {number} [upstreamPricePerOutputToken]
 * @property {string} [currency]
 */

/**
 * @typedef {Object} UpstreamHealth
 * @property {boolean} ok
 * @property {number} latencyMs
 * @property {Record<string, any>} [details]
 */
