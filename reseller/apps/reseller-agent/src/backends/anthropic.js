/**
 * Anthropic Messages API backend.
 *
 * Exposes Anthropic as an OpenAI-style chat completion backend to the rest of
 * the dToken relay. Token usage is normalized into strict dToken metering
 * fields, including cache creation/read input tokens.
 */

import { UpstreamBackendError } from "./interface.js";
import { DEFAULT_UPSTREAM_TIMEOUT_MS, readTimedStreamChunk, timedFetch } from "./timedFetch.js";
import { normalizeAssistantOutput, renderMessagesForProvider } from "../services/multimodal.js";

export class AnthropicBackend {
  constructor(config) {
    this.id = config.id;
    this.baseUrl = (config.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
    this.logTimings = config.logTimings ?? true;
    this.defaultHeaders = config.defaultHeaders ?? {};
    this.anthropicVersion = config.anthropicVersion ?? "2023-06-01";
    this.defaultMaxTokens = config.defaultMaxTokens ?? 1024;
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
    const models = data?.data ?? [];
    return models.map((m) => ({
      id: m.id,
      displayName: m.display_name ?? m.id,
      contextLength: m.context_length ?? 200000,
      capabilities: [],
    }));
  }

  async chatCompletion({ upstreamModel, messages, maxTokens, temperature, extra = {} }) {
    const body = this._buildMessagesBody({
      upstreamModel,
      messages,
      maxTokens,
      temperature,
      extra,
      stream: false,
    });

    const raw = await this._fetchJson("/messages", {
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
  }) {
    const body = this._buildMessagesBody({
      upstreamModel,
      messages,
      maxTokens,
      temperature,
      extra,
      stream: true,
    });

    const response = await this._fetch("/messages", {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await safeReadText(response);
      const data = safeJson(text);
      const errMsg = data?.error?.message ?? data?.error?.type ?? text.slice(0, 200) ?? `HTTP ${response.status}`;
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
    let id = `anthropic_${Date.now()}`;
    let created = Math.floor(Date.now() / 1000);
    let model = upstreamModel;
    let content = "";
    let reasoningContent = "";
    let reasoningSignature = "";
    let finishReason = "stop";
    let rawUsage = null;
    const rawChunks = [];
    const toolCallBlocks = new Map();

    const handleChunk = (chunk) => {
      rawChunks.push(chunk);
      if (chunk.type === "message_start" && chunk.message) {
        id = chunk.message.id ?? id;
        model = chunk.message.model ?? model;
        rawUsage = mergeUsage(rawUsage, chunk.message.usage);
      } else if (chunk.type === "content_block_start" && chunk.content_block?.type === "tool_use") {
        toolCallBlocks.set(Number(chunk.index ?? toolCallBlocks.size), {
          id: String(chunk.content_block.id ?? `toolu_${toolCallBlocks.size}`),
          type: "function",
          function: {
            name: String(chunk.content_block.name ?? "tool"),
            arguments: "",
          },
        });
      } else if (chunk.type === "content_block_delta") {
        const delta = chunk.delta ?? {};
        const thinking = delta.type === "thinking_delta" ? (delta.thinking ?? "") : "";
        if (thinking) {
          reasoningContent += thinking;
          onReasoningDelta(thinking, chunk);
          return;
        }
        const signature = delta.type === "signature_delta" ? (delta.signature ?? "") : "";
        if (signature) {
          reasoningSignature += signature;
          return;
        }
        if (delta.type === "input_json_delta") {
          const block = toolCallBlocks.get(Number(chunk.index ?? 0));
          if (block) block.function.arguments += delta.partial_json ?? "";
          return;
        }
        const text = delta.text ?? "";
        if (text) {
          content += text;
          onDelta(text, chunk);
        }
      } else if (chunk.type === "message_delta") {
        rawUsage = mergeUsage(rawUsage, chunk.usage);
        finishReason = mapStopReason(chunk.delta?.stop_reason) ?? finishReason;
      } else if (chunk.type === "error") {
        throw new UpstreamBackendError(
          `Upstream ${this.id} stream error: ${chunk.error?.message ?? chunk.error?.type ?? "unknown"}`,
          { statusCode: 502, code: "upstream_stream_error", upstreamRequestId: id },
        );
      }
    };

    while (true) {
      const { value, done } = await readTimedStreamChunk(reader, response, {
        upstreamId: this.id,
        timeoutMs: this.timeoutMs,
        logTimings: this.logTimings,
      });
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const payload = parseSseFrame(frame);
        if (!payload || payload.data === "[DONE]") continue;
        handleChunk(JSON.parse(payload.data));
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      const payload = parseSseFrame(buffer);
      if (payload && payload.data !== "[DONE]") {
        handleChunk(JSON.parse(payload.data));
      }
    }

    const usage = normalizeAnthropicUsage(rawUsage, {
      upstreamId: this.id,
      upstreamModel: model,
      upstreamRequestId: id,
    });
    const toolCalls = Array.from(toolCallBlocks.values());
    for (const call of toolCalls) {
      if (!call.function.arguments) call.function.arguments = "{}";
    }

    return {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
            ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
            ...(reasoningSignature ? { reasoning_signature: reasoningSignature } : {}),
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: toolCalls.length ? "tool_calls" : finishReason,
        },
      ],
      usage,
      raw: { stream: true, chunks: rawChunks },
    };
  }

  _buildMessagesBody({ upstreamModel, messages, maxTokens, temperature, extra, stream }) {
    const converted = renderMessagesForProvider(messages, { format: "anthropic_messages" });
  const body = {
      model: upstreamModel,
      max_tokens: maxTokens ?? extra.max_tokens ?? this.defaultMaxTokens,
      messages: converted.messages,
      ...filterAnthropicExtra(extra),
    };
    if (converted.system) body.system = converted.system;
    if (temperature != null) body.temperature = temperature;
    if (stream) body.stream = true;
    return body;
  }

  _normalizeResponse(raw, upstreamModel) {
    const output = normalizeAssistantOutput(raw.content ?? []);
    const text = output.text;
    const message = { role: "assistant", content: text };
    const reasoning = extractAnthropicThinking(raw.content);
    if (reasoning.content) message.reasoning_content = reasoning.content;
    if (reasoning.signature) message.reasoning_signature = reasoning.signature;
    const toolCalls = extractAnthropicToolCalls(raw.content);
    if (toolCalls.length) message.tool_calls = toolCalls;
    if (output.parts.length) message.content_parts = output.parts;
    if (output.attachments.length) message.attachments = output.attachments;

    return {
      id: raw.id ?? `anthropic_${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: raw.model ?? upstreamModel,
      choices: [
        {
          index: 0,
          message,
          finish_reason: toolCalls.length ? "tool_calls" : (mapStopReason(raw.stop_reason) ?? "stop"),
        },
      ],
      usage: normalizeAnthropicUsage(raw.usage, {
        upstreamId: this.id,
        upstreamModel: raw.model ?? upstreamModel,
        upstreamRequestId: raw.id,
      }),
      raw,
    };
  }

  async _fetch(path, options = {}) {
    const url = `${this.baseUrl}${path}`;
    return timedFetch({
      upstreamId: this.id,
      url,
      timeoutMs: this.timeoutMs,
      logTimings: this.logTimings,
      options: {
        ...options,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": this.anthropicVersion,
          ...this.defaultHeaders,
          ...(options.headers ?? {}),
        },
      },
    });
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
      const errMsg = data?.error?.message ?? data?.error?.type ?? `HTTP ${response.status}`;
      throw new UpstreamBackendError(
        `Upstream ${this.id} returned error: ${errMsg}`,
        { statusCode: 502, code: "upstream_error", upstreamRequestId: data?.id },
      );
    }
    return data;
  }
}

function convertOpenAiMessagesToAnthropic(messages) {
  const systemParts = [];
  const converted = [];

  for (const message of messages ?? []) {
    const role = normalizeAnthropicRole(message.role);
    const content = convertContent(message.content, message.role);
    if (message.role === "system") {
      systemParts.push(contentToText(content));
      continue;
    }

    const previous = converted[converted.length - 1];
    if (previous && previous.role === role) {
      previous.content = mergeContent(previous.content, content);
    } else {
      converted.push({ role, content });
    }
  }

  if (!converted.length) {
    converted.push({ role: "user", content: " " });
  }

  return {
    system: systemParts.filter(Boolean).join("\n\n") || null,
    messages: converted,
  };
}

function normalizeAnthropicRole(role) {
  return role === "assistant" ? "assistant" : "user";
}

function convertContent(content, originalRole) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");

  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text") {
      const text = part.text ?? "";
      if (text) parts.push({ type: "text", text });
      continue;
    }
    if (part.type === "image_url") {
      const block = convertImageUrl(part.image_url?.url ?? part.image_url);
      if (block) parts.push(block);
      continue;
    }
  }

  if (!parts.length) {
    return originalRole === "assistant" ? "" : " ";
  }
  return parts;
}

function convertImageUrl(url) {
  if (!url || typeof url !== "string") return null;
  const dataUrl = url.match(/^data:([^;,]+);base64,(.+)$/);
  if (dataUrl) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: dataUrl[1],
        data: dataUrl[2],
      },
    };
  }
  if (/^https?:\/\//i.test(url)) {
    return {
      type: "image",
      source: {
        type: "url",
        url,
      },
    };
  }
  return null;
}

function mergeContent(a, b) {
  if (typeof a === "string" && typeof b === "string") return `${a}\n\n${b}`;
  const aParts = typeof a === "string" ? [{ type: "text", text: a }] : a;
  const bParts = typeof b === "string" ? [{ type: "text", text: b }] : b;
  return [...aParts, ...bParts];
}

function contentToText(content) {
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function filterAnthropicExtra(extra = {}) {
  const allowed = new Set([
    "metadata",
    "service_tier",
    "stop_sequences",
    "system",
    "thinking",
    "tool_choice",
    "tools",
    "top_k",
    "top_p",
  ]);
  const out = {};
  for (const [key, value] of Object.entries(extra)) {
    if (allowed.has(key) && value != null) out[key] = value;
  }
  if (out.tools) out.tools = convertOpenAIToolsToAnthropic(out.tools);
  if (out.tool_choice) out.tool_choice = convertOpenAIToolChoiceToAnthropic(out.tool_choice);
  if (extra.stop != null && out.stop_sequences == null) {
    out.stop_sequences = Array.isArray(extra.stop) ? extra.stop.map(String) : [String(extra.stop)];
  }
  return out;
}

function convertOpenAIToolsToAnthropic(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    if (!tool || typeof tool !== "object") return null;
    if (tool.name && tool.input_schema) return tool;
    const fn = tool.function ?? tool;
    const name = String(fn.name ?? "");
    if (!name) return null;
    return {
      name,
      description: fn.description ?? "",
      input_schema: fn.parameters ?? fn.input_schema ?? { type: "object", properties: {} },
    };
  }).filter(Boolean);
}

function convertOpenAIToolChoiceToAnthropic(choice) {
  if (!choice || typeof choice !== "object") {
    if (choice === "required") return { type: "any" };
    if (choice === "auto" || choice === "none") return { type: choice };
    return choice;
  }
  if (choice.type === "function" && choice.function?.name) {
    return { type: "tool", name: String(choice.function.name) };
  }
  if (choice.type === "tool" || choice.type === "auto" || choice.type === "any" || choice.type === "none") return choice;
  return choice;
}

function extractAnthropicThinking(content = []) {
  const parts = Array.isArray(content) ? content : [];
  const chunks = [];
  let signature = "";
  for (const part of parts) {
    if (part?.type !== "thinking") continue;
    if (part.thinking) chunks.push(String(part.thinking));
    if (!signature && part.signature) signature = String(part.signature);
  }
  return { content: chunks.join("\n"), signature };
}

function extractAnthropicToolCalls(content = []) {
  const parts = Array.isArray(content) ? content : [];
  return parts.map((part, index) => {
    if (part?.type !== "tool_use") return null;
    return {
      id: String(part.id ?? `toolu_${index}`),
      type: "function",
      function: {
        name: String(part.name ?? "tool"),
        arguments: JSON.stringify(part.input ?? {}),
      },
    };
  }).filter(Boolean);
}

function normalizeAnthropicUsage(rawUsage, context) {
  if (!rawUsage || typeof rawUsage !== "object") {
    throw new UpstreamBackendError(
      `Upstream ${context.upstreamId} did not return usage; dToken credential cannot be produced`,
      { code: "upstream_usage_missing", upstreamRequestId: context.upstreamRequestId },
    );
  }

  const baseInput = readToken(rawUsage.input_tokens, "input_tokens", context, true);
  const cacheCreation = readToken(rawUsage.cache_creation_input_tokens, "cache_creation_input_tokens", context, false) ?? 0;
  const cacheRead = readToken(rawUsage.cache_read_input_tokens, "cache_read_input_tokens", context, false) ?? 0;
  const output = readToken(rawUsage.output_tokens, "output_tokens", context, true);
  const prompt = baseInput + cacheCreation + cacheRead;

  return {
    promptTokens: prompt,
    completionTokens: output,
    totalTokens: prompt + output,
    rawCompletionTokens: output,
    reasoningTokens: null,
    hiddenOutputTokens: null,
    promptCacheHitTokens: cacheRead || null,
    promptCacheMissTokens: baseInput + cacheCreation,
    billableOutputSource: "output_tokens",
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

function mergeUsage(previous, next) {
  if (!next) return previous;
  return { ...(previous ?? {}), ...next };
}

function mapStopReason(reason) {
  if (!reason) return null;
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use") return "tool_calls";
  if (reason === "refusal") return "content_filter";
  return "stop";
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
    throw new UpstreamBackendError(
      `Upstream response could not be read: ${error.message}`,
      { code: "upstream_read_error" },
    );
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
