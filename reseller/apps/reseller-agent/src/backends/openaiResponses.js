/**
 * OpenAI-compatible Responses API backend.
 *
 * Useful for providers whose multimodal API has moved beyond
 * /chat/completions, for example OpenAI Responses or xAI Responses-style
 * image understanding. It still exposes the same normalized backend interface
 * to dToken.
 */

import { UpstreamBackendError } from "./interface.js";
import { normalizeAssistantOutput, renderMessagesForProvider } from "../services/multimodal.js";

export class OpenAIResponsesBackend {
  constructor(config) {
    this.id = config.id;
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 60000;
    this.defaultHeaders = config.defaultHeaders ?? {};
    this.messageFormat = config.messageFormat ?? "openai_responses";
  }

  async health() {
    const start = Date.now();
    try {
      const response = await this._fetch("/models", { method: "GET" });
      return { ok: response.ok, latencyMs: Date.now() - start, details: { status: response.status } };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - start, details: { error: error.message } };
    }
  }

  async listModels() {
    const data = await this._fetchJson("/models");
    const models = data?.data ?? data?.models ?? [];
    return models.map((m) => ({
      id: m.id,
      displayName: m.id,
      contextLength: m.context_length ?? m.contextLength ?? 128000,
      capabilities: [],
    }));
  }

  async chatCompletion({ upstreamModel, messages, maxTokens, temperature, extra = {} }) {
    const body = this._buildBody({ upstreamModel, messages, maxTokens, temperature, extra, stream: false });
    const raw = await this._fetchJson("/responses", { method: "POST", body: JSON.stringify(body) });
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
  }) {
    const body = this._buildBody({ upstreamModel, messages, maxTokens, temperature, extra, stream: true });
    const response = await this._fetch("/responses", { method: "POST", body: JSON.stringify(body) });
    if (!response.ok) {
      const text = await safeReadText(response);
      const data = safeJson(text);
      const errMsg = data?.error?.message ?? data?.error?.code ?? text.slice(0, 200) ?? `HTTP ${response.status}`;
      throw new UpstreamBackendError(
        `Upstream ${this.id} returned error: ${errMsg}`,
        { statusCode: 502, code: "upstream_error", upstreamRequestId: data?.id },
      );
    }
    if (!response.body) throw new UpstreamBackendError(`Upstream ${this.id} returned no stream body`, { code: "upstream_stream_missing" });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let id = `resp_${Date.now()}`;
    let created = Math.floor(Date.now() / 1000);
    let text = "";
    let reasoningContent = "";
    let final = null;
    const rawChunks = [];

    const handleEvent = (payload) => {
      if (!payload?.data || payload.data === "[DONE]") return;
      const chunk = JSON.parse(payload.data);
      rawChunks.push(chunk);
      if (chunk.response?.id) id = chunk.response.id;
      if (chunk.response?.created_at) created = Math.floor(Number(chunk.response.created_at));
      const delta = chunk.delta ?? "";
      if (chunk.type === "response.output_text.delta" && delta) {
        text += delta;
        onDelta(delta, { id, created, model: upstreamModel });
      }
      if ((chunk.type === "response.reasoning_summary_text.delta" || chunk.type === "response.reasoning_text.delta") && delta) {
        reasoningContent += delta;
        onReasoningDelta(delta, { id, created, model: upstreamModel });
      }
      if (chunk.type === "response.completed" && chunk.response) final = chunk.response;
      if (chunk.type === "response.failed") {
        throw new UpstreamBackendError(
          `Upstream ${this.id} stream failed: ${chunk.response?.error?.message ?? "unknown"}`,
          { statusCode: 502, code: "upstream_stream_error", upstreamRequestId: id },
        );
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) handleEvent(parseSseFrame(frame));
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleEvent(parseSseFrame(buffer));

    if (!final) final = { id, created_at: created, model: upstreamModel, output_text: text, usage: null };
    const normalized = this._normalizeResponse(final, upstreamModel);
    if (!normalized.choices[0].message.content && text) normalized.choices[0].message.content = text;
    if (reasoningContent && !normalized.choices[0].message.reasoning_content) normalized.choices[0].message.reasoning_content = reasoningContent;
    normalized.raw = { stream: true, chunks: rawChunks, final };
    return normalized;
  }

  _buildBody({ upstreamModel, messages, maxTokens, temperature, extra, stream }) {
    const responsesExtra = filterResponsesExtra(extra);
    const body = {
      model: upstreamModel,
      input: renderMessagesForProvider(messages, { format: this.messageFormat }),
      ...responsesExtra,
    };
    if (maxTokens != null) body.max_output_tokens = maxTokens;
    if (temperature != null) body.temperature = temperature;
    if (stream) body.stream = true;
    return body;
  }

  _normalizeResponse(raw, upstreamModel) {
    const output = normalizeAssistantOutput(responseOutputParts(raw));
    const content = output.text || raw.output_text || extractOutputText(raw);
    const toolCalls = extractResponsesToolCalls(raw);
    const message = { role: "assistant", content: content || "" };
    const reasoning = extractResponsesReasoning(raw);
    if (reasoning) message.reasoning_content = reasoning;
    if (toolCalls.length) message.tool_calls = toolCalls;
    if (output.parts.length) message.content_parts = output.parts;
    if (output.attachments.length) message.attachments = output.attachments;
    return {
      id: raw.id ?? `resp_${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(raw.created_at ?? Date.now() / 1000),
      model: raw.model ?? upstreamModel,
      choices: [{ index: 0, message, finish_reason: mapStatus(raw.status, toolCalls) }],
      usage: normalizeResponsesUsage(raw.usage, {
        upstreamId: this.id,
        upstreamModel: raw.model ?? upstreamModel,
        upstreamRequestId: raw.id,
      }),
      raw,
    };
  }

  async _fetch(path, options = {}) {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          ...this.defaultHeaders,
          ...(options.headers ?? {}),
        },
      });
    } catch (error) {
      if (error.name === "AbortError") {
        throw new UpstreamBackendError(`Upstream ${this.id} timed out after ${this.timeoutMs}ms`, { code: "upstream_timeout" });
      }
      throw new UpstreamBackendError(`Upstream ${this.id} request failed: ${error.message}`, { code: "upstream_network_error" });
    } finally {
      clearTimeout(timeout);
    }
  }

  async _fetchJson(path, options = {}) {
    const response = await this._fetch(path, options);
    const text = await safeReadText(response);
    const data = safeJson(text);
    if (!data) {
      throw new UpstreamBackendError(
        `Upstream ${this.id} returned non-JSON response (status ${response.status}): ${text.slice(0, 200)}`,
        { statusCode: 502, code: "upstream_invalid_json" },
      );
    }
    if (!response.ok) {
      throw new UpstreamBackendError(
        `Upstream ${this.id} returned error: ${data?.error?.message ?? data?.error?.code ?? `HTTP ${response.status}`}`,
        { statusCode: 502, code: "upstream_error", upstreamRequestId: data?.id },
      );
    }
    return data;
  }
}

function extractResponsesReasoning(raw) {
  const chunks = [];
  for (const item of raw?.output ?? []) {
    if (!item || typeof item !== "object") continue;
    const type = String(item.type ?? "");
    if (type.includes("reasoning")) {
      if (typeof item.summary === "string") chunks.push(item.summary);
      if (Array.isArray(item.summary)) {
        chunks.push(...item.summary.map((part) => part?.text ?? part?.summary_text ?? "").filter(Boolean));
      }
      if (typeof item.text === "string") chunks.push(item.text);
    }
    for (const part of item.content ?? []) {
      const partType = String(part?.type ?? "");
      if (partType.includes("reasoning") || partType === "summary_text") {
        const text = part.text ?? part.summary_text ?? "";
        if (text) chunks.push(String(text));
      }
    }
  }
  return chunks.filter(Boolean).join("\n");
}

function extractResponsesToolCalls(raw) {
  const calls = [];
  for (const item of raw?.output ?? []) {
    if (!item || typeof item !== "object") continue;
    if (item.type !== "function_call") continue;
    const callId = String(item.call_id ?? item.id ?? `call_${calls.length}`);
    const name = String(item.name ?? "");
    if (!name) continue;
    calls.push({
      id: callId,
      type: "function",
      function: {
        name,
        arguments: typeof item.arguments === "string"
          ? item.arguments
          : JSON.stringify(item.arguments ?? {}),
      },
    });
  }
  return calls;
}

function normalizeResponsesUsage(rawUsage, context) {
  if (!rawUsage || typeof rawUsage !== "object") {
    throw new UpstreamBackendError(
      `Upstream ${context.upstreamId} did not return usage; dToken credential cannot be produced`,
      { code: "upstream_usage_missing", upstreamRequestId: context.upstreamRequestId },
    );
  }
  const promptTokens = readToken(rawUsage.input_tokens ?? rawUsage.prompt_tokens, "input_tokens", context, true);
  const rawOutput = readToken(rawUsage.output_tokens ?? rawUsage.completion_tokens, "output_tokens", context, false);
  const totalTokens = readToken(rawUsage.total_tokens, "total_tokens", context, false)
    ?? (promptTokens + (rawOutput ?? 0));
  const completionTokens = Math.max(0, totalTokens - promptTokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    rawCompletionTokens: rawOutput ?? completionTokens,
    reasoningTokens: readToken(rawUsage.output_tokens_details?.reasoning_tokens, "output_tokens_details.reasoning_tokens", context, false),
    hiddenOutputTokens: rawOutput == null ? null : Math.max(0, completionTokens - rawOutput),
    promptCacheHitTokens: readToken(rawUsage.input_tokens_details?.cached_tokens, "input_tokens_details.cached_tokens", context, false),
    promptCacheMissTokens: null,
    billableOutputSource: "total_tokens_minus_prompt_tokens",
    raw: rawUsage,
  };
}

function readToken(value, fieldName, context, required) {
  if (value == null) {
    if (!required) return null;
    throw new UpstreamBackendError(
      `Upstream ${context.upstreamId} usage missing required ${fieldName}; dToken credential cannot be produced`,
      { code: "upstream_usage_missing", upstreamRequestId: context.upstreamRequestId },
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new UpstreamBackendError(
      `Upstream ${context.upstreamId} usage field ${fieldName} is not a non-negative integer`,
      { code: "upstream_usage_invalid", upstreamRequestId: context.upstreamRequestId },
    );
  }
  return parsed;
}

function extractOutputText(raw) {
  return (raw.output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((part) => part.text ?? "")
    .join("");
}

function responseOutputParts(raw) {
  const out = [];
  for (const item of raw.output ?? []) {
    if (Array.isArray(item.content)) out.push(...item.content);
    else out.push(item);
  }
  if (!out.length && raw.output_text) out.push({ type: "output_text", text: raw.output_text });
  return out;
}

function mapStatus(status, toolCalls = []) {
  if (toolCalls.length) return "tool_calls";
  if (!status || status === "completed") return "stop";
  if (status === "incomplete") return "length";
  return "stop";
}

function filterResponsesExtra(extra = {}) {
  const allowed = new Set([
    "background",
    "include",
    "instructions",
    "max_output_tokens",
    "max_tool_calls",
    "metadata",
    "parallel_tool_calls",
    "previous_response_id",
    "prompt",
    "reasoning",
    "safety_identifier",
    "service_tier",
    "store",
    "text",
    "tool_choice",
    "tools",
    "top_p",
    "truncation",
    "user",
  ]);
  const out = {};
  for (const [key, value] of Object.entries(extra)) {
    if (value == null) continue;
    if (key === "response_format" && out.text == null) {
      const format = responseFormatToResponsesTextFormat(value);
      if (format) out.text = { format };
      continue;
    }
    if (key === "tools") {
      out.tools = normalizeResponsesTools(value);
      continue;
    }
    if (key === "tool_choice") {
      out.tool_choice = normalizeResponsesToolChoice(value);
      continue;
    }
    if ((key === "max_completion_tokens" || key === "max_tokens") && out.max_output_tokens == null) {
      out.max_output_tokens = value;
      continue;
    }
    if (allowed.has(key)) out[key] = value;
  }
  return out;
}

function responseFormatToResponsesTextFormat(value) {
  if (!value || typeof value !== "object") return null;
  if (value.type === "json_schema") {
    const schema = value.json_schema ?? {};
    return {
      type: "json_schema",
      name: schema.name ?? value.name ?? "response",
      schema: schema.schema ?? value.schema ?? { type: "object" },
      ...(schema.description ?? value.description ? { description: schema.description ?? value.description } : {}),
      ...(schema.strict != null || value.strict != null ? { strict: schema.strict ?? value.strict } : {}),
    };
  }
  if (value.type === "json_object") return { type: "json_object" };
  if (value.type === "text") return { type: "text" };
  return null;
}

function normalizeResponsesTools(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    if (!tool || typeof tool !== "object") return null;
    if (tool.type === "function" && !tool.function && tool.name) return tool;
    if (tool.type !== "function" || !tool.function) return tool;
    const fn = tool.function;
    const name = String(fn.name ?? "");
    if (!name) return null;
    return {
      type: "function",
      name,
      description: fn.description ?? "",
      parameters: fn.parameters ?? fn.input_schema ?? { type: "object", properties: {} },
      ...(tool.strict != null || fn.strict != null ? { strict: tool.strict ?? fn.strict } : {}),
    };
  }).filter(Boolean);
}

function normalizeResponsesToolChoice(choice) {
  if (!choice || typeof choice !== "object") return choice;
  if (choice.type === "function" && choice.function?.name) {
    return { type: "function", name: String(choice.function.name) };
  }
  return choice;
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

async function safeReadText(response) {
  try {
    return await response.text();
  } catch (error) {
    throw new UpstreamBackendError(`Upstream response could not be read: ${error.message}`, { code: "upstream_read_error" });
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
