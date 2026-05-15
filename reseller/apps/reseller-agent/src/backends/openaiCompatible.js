/**
 * OpenAI-compatible 上游后端实现
 *
 * 用于对接任何提供 OpenAI-compatible API 的商业模型服务：
 * OpenAI、Anthropic（通过兼容层）、DeepSeek、Groq、Together AI 等。
 *
 * 核心职责：
 * 1. 用 Provider 服务节点的 API key 替换 User 的 key
 * 2. 将 User 请求的 displayName 映射为上游真实模型名
 * 3. 从上游响应中提取真实 token 用量
 */

import { UpstreamBackendError } from "./interface.js";
import { normalizeAssistantOutput, renderMessagesForProvider } from "../services/multimodal.js";

export class OpenAICompatibleBackend {
  /**
   * @param {Object} config
   * @param {string} config.id - 后端标识
   * @param {string} config.baseUrl - 上游 API base URL
   * @param {string} config.apiKey - Provider 服务节点的模型访问 API key
   * @param {number} [config.timeoutMs=60000] - 请求超时
   * @param {Object} [config.defaultHeaders] - 额外的默认请求头
   */
  constructor(config) {
    this.id = config.id;
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 60000;
    this.defaultHeaders = config.defaultHeaders ?? {};
    this.messageFormat = config.messageFormat ?? "openai_chat_completions";
    this.includeStreamUsage = config.includeStreamUsage !== false;
    this.preserveReasoningContent = config.preserveReasoningContent === true;

    if (this.baseUrl.startsWith("http://") && !this.baseUrl.includes("127.0.0.1") && !this.baseUrl.includes("localhost")) {
      console.warn(`[security] Upstream "${this.id}" uses HTTP — API key will be transmitted in cleartext. Use HTTPS.`);
    }
  }

  /**
   * 健康检查 —— 探测上游是否可达
   * @returns {Promise<{ok: boolean, latencyMs: number, details?: Record<string, any>}>}
   */
  async health() {
    const start = Date.now();
    try {
      const response = await this._fetch("/models", { method: "GET" });
      const latencyMs = Date.now() - start;
      return { ok: response.ok, latencyMs, details: { status: response.status } };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - start, details: { error: error.message } };
    }
  }

  /**
   * 获取上游可用模型列表
   * @returns {Promise<Array<{id: string, displayName?: string, contextLength: number, capabilities: string[]}>>}
   */
  async listModels() {
    const data = await this._fetchJson("/models");
    const models = data?.data ?? data?.models ?? [];
    return models.map((m) => ({
      id: m.id,
      displayName: m.id,
      contextLength: m.context_length ?? m.contextLength ?? 4096,
      capabilities: [],
    }));
  }

  /**
   * 执行 chat completion 请求
   *
   * @param {Object} params
   * @param {string} params.upstreamModel - 上游实际模型名
   * @param {Array} params.messages - 消息列表
   * @param {number} [params.maxTokens]
   * @param {number} [params.temperature]
   * @param {Record<string, any>} [params.extra] - 透传的额外参数
   * @returns {Promise<Object>} 标准化的 chat completion 响应
   */
  async chatCompletion({ upstreamModel, messages, maxTokens, temperature, extra = {} }) {
    const body = {
      model: upstreamModel,
      messages: renderMessagesForProvider(messages, {
        format: this.messageFormat,
        preserveReasoningContent: this.preserveReasoningContent,
      }),
      ...extra,
    };

    if (maxTokens != null) body.max_tokens = maxTokens;
    if (temperature != null) body.temperature = temperature;

    const raw = await this._fetchJson("/chat/completions", {
      method: "POST",
      body: JSON.stringify(body),
    });

    return this._normalizeResponse(raw, upstreamModel);
  }

  async chatCompletionStream({
    upstreamModel,
    messages,
    maxTokens,
    temperature,
    extra = {},
    onDelta = () => {},
    onReasoningDelta = () => {},
    onToolCallDelta = () => {},
  }) {
    const body = {
      model: upstreamModel,
      messages: renderMessagesForProvider(messages, {
        format: this.messageFormat,
        preserveReasoningContent: this.preserveReasoningContent,
      }),
      ...extra,
      stream: true,
    };
    if (this.includeStreamUsage) {
      body.stream_options = {
        include_usage: true,
        ...(extra.stream_options ?? {}),
      };
    } else if (extra.stream_options) {
      body.stream_options = extra.stream_options;
    }

    if (maxTokens != null) body.max_tokens = maxTokens;
    if (temperature != null) body.temperature = temperature;

    const response = await this._fetch("/chat/completions", {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      let text = "";
      try { text = await response.text(); } catch {}
      let data = null;
      try { data = JSON.parse(text); } catch {}
      const errMsg = data?.error?.message ?? data?.error?.code ?? text.slice(0, 200) ?? `HTTP ${response.status}`;
      throw new UpstreamBackendError(
        `Upstream ${this.id} returned error: ${errMsg}`,
        { statusCode: 502, code: "upstream_error", upstreamRequestId: data?.id },
      );
    }

    if (!response.body) {
      throw new UpstreamBackendError(
        `Upstream ${this.id} returned no stream body`,
        { code: "upstream_stream_missing" },
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let id = `upstream_${Date.now()}`;
    let created = Math.floor(Date.now() / 1000);
    let model = upstreamModel;
    let content = "";
    let reasoningContent = "";
    const toolCalls = [];
    let finishReason = "stop";
    let rawUsage = null;
    const rawChunks = [];

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const payload = parseSseFrame(frame);
        if (!payload || payload.data === "[DONE]") continue;
        let chunk;
        try {
          chunk = JSON.parse(payload.data);
        } catch {
          continue;
        }
        rawChunks.push(chunk);
        if (chunk.id) id = chunk.id;
        if (chunk.created) created = chunk.created;
        if (chunk.model) model = chunk.model;
        if (chunk.usage) rawUsage = chunk.usage;

        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta ?? {};
        if (delta.content) {
          content += delta.content;
          onDelta(delta.content, chunk);
        }
        if (delta.reasoning_content) {
          reasoningContent += delta.reasoning_content;
          onReasoningDelta(delta.reasoning_content, chunk);
        }
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
          mergeToolCallDeltas(toolCalls, delta.tool_calls);
          onToolCallDelta(delta.tool_calls, chunk);
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      const payload = parseSseFrame(buffer);
      if (payload && payload.data !== "[DONE]") {
        try {
          const chunk = JSON.parse(payload.data);
          rawChunks.push(chunk);
          if (chunk.usage) rawUsage = chunk.usage;
        } catch {}
      }
    }

    const usage = normalizeUsage(rawUsage, {
      upstreamId: this.id,
      upstreamModel: model,
      upstreamRequestId: id,
    });

    const message = { role: "assistant", content };
    if (reasoningContent) message.reasoning_content = reasoningContent;
    if (toolCalls.length) message.tool_calls = toolCalls;

    return {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: finishReason,
        },
      ],
      usage,
      raw: { stream: true, chunks: rawChunks },
    };
  }

  // ==================== 私有方法 ====================

  /**
   * 标准化上游响应为内部统一格式
   */
  _normalizeResponse(raw, upstreamModel) {
    const choice = raw.choices?.[0];
    if (!choice) {
      throw new UpstreamBackendError(
        `Upstream returned no choices for model ${upstreamModel}`,
        { code: "upstream_empty_response", upstreamRequestId: raw.id },
      );
    }

    const usage = normalizeUsage(raw.usage, {
      upstreamId: this.id,
      upstreamModel,
      upstreamRequestId: raw.id,
    });

    const output = normalizeAssistantOutput(choice.message?.content ?? "");
    const message = {
      role: choice.message?.role ?? "assistant",
      content: output.text,
    };
    if (output.parts.length) message.content_parts = output.parts;
    if (output.attachments.length) message.attachments = output.attachments;
    if (choice.message?.reasoning_content != null) {
      message.reasoning_content = choice.message.reasoning_content;
    }
    if (choice.message?.tool_calls != null) {
      message.tool_calls = choice.message.tool_calls;
    }

    return {
      id: raw.id ?? `upstream_${Date.now()}`,
      object: raw.object ?? "chat.completion",
      created: raw.created ?? Math.floor(Date.now() / 1000),
      model: upstreamModel,
      choices: [
        {
          index: choice.index ?? 0,
          message,
          finish_reason: choice.finish_reason ?? "stop",
        },
      ],
      usage,
      raw,
    };
  }

  /**
   * 发起 HTTP 请求到上游 API
   */
  async _fetch(path, options = {}) {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          ...this.defaultHeaders,
          ...(options.headers ?? {}),
        },
      });
      return response;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new UpstreamBackendError(
          `Upstream ${this.id} timed out after ${this.timeoutMs}ms`,
          { code: "upstream_timeout" },
        );
      }
      throw new UpstreamBackendError(
        `Upstream ${this.id} request failed: ${error.message}`,
        { code: "upstream_network_error" },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * 发起请求并解析 JSON 响应
   */
  async _fetchJson(path, options = {}) {
    const response = await this._fetch(path, options);

    let text;
    try {
      text = await response.text();
    } catch (error) {
      throw new UpstreamBackendError(
        `Upstream ${this.id} failed to read response: ${error.message}`,
        { code: "upstream_read_error" },
      );
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      const preview = text.slice(0, 200);
      throw new UpstreamBackendError(
        `Upstream ${this.id} returned non-JSON response (status ${response.status}): ${preview}`,
        { statusCode: 502, code: "upstream_invalid_json" },
      );
    }

    if (!response.ok) {
      const errMsg = data?.error?.message ?? data?.error?.code ?? `HTTP ${response.status}`;
      throw new UpstreamBackendError(
        `Upstream ${this.id} returned error: ${errMsg}`,
        { statusCode: 502, code: "upstream_error", upstreamRequestId: data?.id },
      );
    }

    return data;
  }
}

function mergeToolCallDeltas(target, deltas) {
  for (const delta of deltas ?? []) {
    const index = Number.isInteger(delta?.index) ? delta.index : target.length;
    const current = target[index] ?? {
      id: "",
      type: "function",
      function: { name: "", arguments: "" },
    };
    if (delta.id) current.id = delta.id;
    if (delta.type) current.type = delta.type;
    if (delta.function) {
      current.function = current.function ?? { name: "", arguments: "" };
      if (delta.function.name) current.function.name = delta.function.name;
      if (delta.function.arguments) {
        current.function.arguments = `${current.function.arguments ?? ""}${delta.function.arguments}`;
      }
    }
    target[index] = current;
  }
}

function parseSseFrame(frame) {
  const lines = String(frame || "").split(/\r?\n/);
  let event = "message";
  const data = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  return { event, data: data.join("\n") };
}

function normalizeUsage(rawUsage, { upstreamId, upstreamModel, upstreamRequestId }) {
  if (!rawUsage || typeof rawUsage !== "object") {
    throw new UpstreamBackendError(
      `Upstream ${upstreamId} did not return usage; dToken credential cannot be produced`,
      { code: "upstream_usage_missing", upstreamRequestId },
    );
  }

  const prompt = readRequiredTokenCount(rawUsage.prompt_tokens ?? rawUsage.input_tokens, "prompt_tokens", {
    upstreamId, upstreamModel, upstreamRequestId,
  });
  const rawCompletion = readOptionalTokenCount(rawUsage.completion_tokens ?? rawUsage.output_tokens, "completion_tokens", {
    upstreamId, upstreamModel, upstreamRequestId,
  });
  const total = readOptionalTokenCount(rawUsage.total_tokens, "total_tokens", {
    upstreamId, upstreamModel, upstreamRequestId,
  });

  const completionDetails = rawUsage.completion_tokens_details ?? rawUsage.output_tokens_details ?? {};
  const promptDetails = rawUsage.prompt_tokens_details ?? rawUsage.input_tokens_details ?? {};
  const reasoningTokens = readOptionalTokenCount(
    completionDetails.reasoning_tokens ?? rawUsage.reasoning_tokens,
    "completion_tokens_details.reasoning_tokens",
    { upstreamId, upstreamModel, upstreamRequestId },
  );
  const promptCacheHitTokens = readOptionalTokenCount(
    rawUsage.prompt_cache_hit_tokens ?? rawUsage.cached_tokens ?? promptDetails.cached_tokens,
    "prompt_cache_hit_tokens",
    { upstreamId, upstreamModel, upstreamRequestId },
  );
  const promptCacheMissTokens = readOptionalTokenCount(
    rawUsage.prompt_cache_miss_tokens,
    "prompt_cache_miss_tokens",
    { upstreamId, upstreamModel, upstreamRequestId },
  );

  if (total != null && total < prompt) {
    throw new UpstreamBackendError(
      `Upstream ${upstreamId} returned inconsistent usage: total_tokens < prompt_tokens`,
      { code: "upstream_usage_inconsistent", upstreamRequestId },
    );
  }
  if (total != null && rawCompletion != null && total < prompt + rawCompletion) {
    throw new UpstreamBackendError(
      `Upstream ${upstreamId} returned inconsistent usage: total_tokens < prompt_tokens + completion_tokens`,
      { code: "upstream_usage_inconsistent", upstreamRequestId },
    );
  }

  let completion;
  let billableOutputSource;
  if (total != null) {
    completion = total - prompt;
    billableOutputSource = "total_tokens_minus_prompt_tokens";
  } else if (rawCompletion != null) {
    completion = rawCompletion;
    billableOutputSource = "completion_tokens";
  } else if (reasoningTokens != null) {
    completion = reasoningTokens;
    billableOutputSource = "reasoning_tokens_only";
  } else {
    throw new UpstreamBackendError(
      `Upstream ${upstreamId} usage did not include completion or total tokens; dToken credential cannot be produced`,
      { code: "upstream_usage_missing", upstreamRequestId },
    );
  }

  const totalTokens = total ?? prompt + completion;
  const hiddenOutputTokens = rawCompletion == null ? null : Math.max(0, completion - rawCompletion);

  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens,
    rawCompletionTokens: rawCompletion,
    reasoningTokens,
    hiddenOutputTokens,
    promptCacheHitTokens,
    promptCacheMissTokens,
    billableOutputSource,
    raw: rawUsage,
  };
}

function readRequiredTokenCount(value, fieldName, context) {
  const parsed = readOptionalTokenCount(value, fieldName, context);
  if (parsed == null) {
    throw new UpstreamBackendError(
      `Upstream ${context.upstreamId} usage missing required ${fieldName}; dToken credential cannot be produced`,
      { code: "upstream_usage_missing", upstreamRequestId: context.upstreamRequestId },
    );
  }
  return parsed;
}

function readOptionalTokenCount(value, fieldName, context) {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new UpstreamBackendError(
      `Upstream ${context.upstreamId} usage field ${fieldName} is not a non-negative integer`,
      { code: "upstream_usage_invalid", upstreamRequestId: context.upstreamRequestId },
    );
  }
  return parsed;
}
