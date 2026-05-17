/**
 * Google Gemini native generateContent backend.
 *
 * Accepts dToken canonical multimodal messages and renders them to Gemini
 * contents/parts. Usage is normalized from usageMetadata so dToken metering
 * remains based on upstream-reported tokens.
 */

import { UpstreamBackendError } from "./interface.js";
import { DEFAULT_UPSTREAM_TIMEOUT_MS, readTimedStreamChunk, timedFetch } from "./timedFetch.js";
import { normalizeAssistantOutput, renderMessagesForProvider } from "../services/multimodal.js";

export class GeminiBackend {
  constructor(config) {
    this.id = config.id;
    this.baseUrl = (config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
    this.logTimings = config.logTimings ?? true;
    this.defaultHeaders = config.defaultHeaders ?? {};
    this.thoughtSignatureCache = new Map();
    this.maxThoughtSignatureCacheEntries = config.maxThoughtSignatureCacheEntries ?? 2000;
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
    const data = await this._fetchJson("/models", { method: "GET" });
    return (data?.models ?? []).map((m) => ({
      id: String(m.name ?? "").replace(/^models\//, ""),
      displayName: m.displayName ?? String(m.name ?? "").replace(/^models\//, ""),
      contextLength: m.inputTokenLimit ?? 1048576,
      capabilities: [],
    }));
  }

  async chatCompletion({ upstreamModel, messages, maxTokens, temperature, extra = {} }) {
    const body = this._buildBody({ upstreamModel, messages, maxTokens, temperature, extra, stream: false });
    const modelPath = geminiModelPath(upstreamModel);
    const raw = await this._fetchJson(`/${modelPath}:generateContent`, {
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
    const body = this._buildBody({ upstreamModel, messages, maxTokens, temperature, extra, stream: true });
    const modelPath = geminiModelPath(upstreamModel);
    const response = await this._fetch(`/${modelPath}:streamGenerateContent?alt=sse`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await safeReadText(response);
      const data = safeJson(text);
      const errMsg = data?.error?.message ?? text.slice(0, 200) ?? `HTTP ${response.status}`;
      throw new UpstreamBackendError(
        `Upstream ${this.id} returned error: ${errMsg}`,
        { statusCode: 502, code: "upstream_error", upstreamRequestId: data?.error?.status },
      );
    }
    if (!response.body) {
      throw new UpstreamBackendError(`Upstream ${this.id} returned no stream body`, { code: "upstream_stream_missing" });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let lastChunk = null;
    const toolCalls = [];
    const seenToolCallIds = new Set();
    const rawChunks = [];
    let reasoningContent = "";

    const handleChunk = (chunk) => {
      rawChunks.push(chunk);
      lastChunk = chunk;
      const thoughtDelta = geminiThinkingText(chunk);
      if (thoughtDelta) {
        reasoningContent += thoughtDelta;
        onReasoningDelta(thoughtDelta, {
          id: chunk.responseId,
          created: Math.floor(Date.now() / 1000),
          model: upstreamModel,
        });
      }
      const delta = geminiText(chunk);
      if (delta) {
        text += delta;
        onDelta(delta, { id: chunk.responseId, created: Math.floor(Date.now() / 1000), model: upstreamModel });
      }
      const nextToolCalls = geminiFunctionCalls(chunk)
        .map((call, index) => this._geminiFunctionCallToOpenAI(call, index))
        .filter((call) => !seenToolCallIds.has(call.id));
      if (nextToolCalls.length) {
        for (const call of nextToolCalls) {
          seenToolCallIds.add(call.id);
          toolCalls.push(call);
        }
        onToolCallDelta(nextToolCalls, { id: chunk.responseId, created: Math.floor(Date.now() / 1000), model: upstreamModel });
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
        if (!payload?.data) continue;
        handleChunk(JSON.parse(payload.data));
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const payload = parseSseFrame(buffer);
      if (payload?.data) handleChunk(JSON.parse(payload.data));
    }

    const usage = normalizeGeminiUsage(lastChunk?.usageMetadata, {
      upstreamId: this.id,
      upstreamModel,
      upstreamRequestId: lastChunk?.responseId,
    });

    const output = normalizeAssistantOutput(geminiVisibleParts(lastChunk));
    const message = { role: "assistant", content: output.text || text };
    const finalReasoning = reasoningContent || geminiThinkingText(lastChunk);
    if (finalReasoning) message.reasoning_content = finalReasoning;
    if (output.parts.length) message.content_parts = output.parts;
    if (output.attachments.length) message.attachments = output.attachments;
    if (toolCalls.length) message.tool_calls = toolCalls;
    return {
      id: lastChunk?.responseId ?? `gemini_${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: upstreamModel,
      choices: [{ index: 0, message, finish_reason: mapFinishReason(lastChunk) }],
      usage,
      raw: { stream: true, chunks: rawChunks },
    };
  }

  _buildBody({ messages, maxTokens, temperature, extra, stream }) {
    const rendered = renderMessagesForProvider(messages, {
      format: "gemini_generate_content",
      geminiThoughtSignatureResolver: (toolCall) => this._resolveThoughtSignature(toolCall),
    });
    const generationConfig = { ...(extra.generationConfig ?? {}) };
    if (maxTokens != null) generationConfig.maxOutputTokens = maxTokens;
    if (temperature != null) generationConfig.temperature = temperature;
    if (extra.top_p != null && generationConfig.topP == null) generationConfig.topP = extra.top_p;
    if (extra.top_k != null && generationConfig.topK == null) generationConfig.topK = extra.top_k;
    if (extra.stop != null && generationConfig.stopSequences == null) {
      generationConfig.stopSequences = Array.isArray(extra.stop) ? extra.stop.map(String) : [String(extra.stop)];
    }
    const geminiExtra = buildGeminiExtra(extra);
    const body = {
      contents: rendered.contents,
      ...geminiExtra,
    };
    if (rendered.system_instruction) body.systemInstruction = rendered.system_instruction;
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
    return body;
  }

  _normalizeResponse(raw, upstreamModel) {
    const output = normalizeAssistantOutput(geminiVisibleParts(raw));
    const message = { role: "assistant", content: output.text || geminiText(raw) };
    const reasoning = geminiThinkingText(raw);
    if (reasoning) message.reasoning_content = reasoning;
    if (output.parts.length) message.content_parts = output.parts;
    if (output.attachments.length) message.attachments = output.attachments;
    const toolCalls = geminiFunctionCalls(raw).map((call, index) => this._geminiFunctionCallToOpenAI(call, index));
    if (toolCalls.length) message.tool_calls = toolCalls;
    return {
      id: raw.responseId ?? `gemini_${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: upstreamModel,
      choices: [{ index: 0, message, finish_reason: mapFinishReason(raw) }],
      usage: normalizeGeminiUsage(raw.usageMetadata, {
        upstreamId: this.id,
        upstreamModel,
        upstreamRequestId: raw.responseId,
      }),
      raw,
    };
  }

  _geminiFunctionCallToOpenAI(call, index = 0) {
    const openAICall = geminiFunctionCallToOpenAI(call, index);
    if (call.thoughtSignature) {
      const encodedId = encodeThoughtSignatureInToolCallId(openAICall.id, call.thoughtSignature);
      openAICall.id = encodedId;
      this._rememberThoughtSignature({
        rawId: call.id,
        openAIId: encodedId,
        name: call.name,
        args: call.args ?? {},
        thoughtSignature: call.thoughtSignature,
      });
    }
    return openAICall;
  }

  _rememberThoughtSignature({ rawId, openAIId, name, args, thoughtSignature }) {
    if (!thoughtSignature) return;
    const entries = [
      rawId ? [`id:${rawId}`, thoughtSignature] : null,
      openAIId ? [`id:${openAIId}`, thoughtSignature] : null,
      name ? [`fn:${name}:${stableJson(args ?? {})}`, thoughtSignature] : null,
    ].filter(Boolean);
    for (const [key, value] of entries) this.thoughtSignatureCache.set(key, value);
    while (this.thoughtSignatureCache.size > this.maxThoughtSignatureCacheEntries) {
      const firstKey = this.thoughtSignatureCache.keys().next().value;
      this.thoughtSignatureCache.delete(firstKey);
    }
  }

  _resolveThoughtSignature(toolCall) {
    const decoded = decodeThoughtSignatureFromToolCallId(toolCall.id);
    if (decoded.thoughtSignature) return decoded.thoughtSignature;
    const idHit = toolCall.id ? this.thoughtSignatureCache.get(`id:${toolCall.id}`) : null;
    if (idHit) return idHit;
    const originalIdHit = decoded.originalId ? this.thoughtSignatureCache.get(`id:${decoded.originalId}`) : null;
    if (originalIdHit) return originalIdHit;
    return toolCall.name ? this.thoughtSignatureCache.get(`fn:${toolCall.name}:${stableJson(toolCall.args ?? {})}`) : null;
  }

  async _fetch(path, options = {}) {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${this.baseUrl}${path}${sep}key=${encodeURIComponent(this.apiKey)}`;
    return timedFetch({
      upstreamId: this.id,
      url,
      timeoutMs: this.timeoutMs,
      logTimings: this.logTimings,
      options: {
        ...options,
        headers: {
          "Content-Type": "application/json",
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
      throw new UpstreamBackendError(
        `Upstream ${this.id} returned error: ${data?.error?.message ?? `HTTP ${response.status}`}`,
        { statusCode: 502, code: "upstream_error", upstreamRequestId: data?.error?.status },
      );
    }
    return data;
  }
}

function normalizeGeminiUsage(rawUsage, context) {
  if (!rawUsage || typeof rawUsage !== "object") {
    throw new UpstreamBackendError(
      `Upstream ${context.upstreamId} did not return usage; dToken credential cannot be produced`,
      { code: "upstream_usage_missing", upstreamRequestId: context.upstreamRequestId },
    );
  }
  const promptTokens = readToken(rawUsage.promptTokenCount, "usageMetadata.promptTokenCount", context, true);
  const rawOutput = readToken(rawUsage.candidatesTokenCount, "usageMetadata.candidatesTokenCount", context, false) ?? 0;
  const thoughts = readToken(rawUsage.thoughtsTokenCount, "usageMetadata.thoughtsTokenCount", context, false) ?? 0;
  const totalTokens = readToken(rawUsage.totalTokenCount, "usageMetadata.totalTokenCount", context, false)
    ?? (promptTokens + rawOutput + thoughts);
  const completionTokens = Math.max(0, totalTokens - promptTokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    rawCompletionTokens: rawOutput,
    reasoningTokens: thoughts || null,
    hiddenOutputTokens: Math.max(0, completionTokens - rawOutput),
    promptCacheHitTokens: null,
    promptCacheMissTokens: null,
    billableOutputSource: "total_tokens_minus_prompt_tokens",
    raw: rawUsage,
  };
}

function geminiModelPath(model) {
  const clean = String(model ?? "").replace(/^\/+/, "");
  return clean.startsWith("models/") ? clean : `models/${encodeURIComponent(clean)}`;
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

function geminiText(raw) {
  return geminiParts(raw)
    .filter((part) => part?.thought !== true)
    .map((part) => part.text ?? "")
    .join("");
}

function geminiThinkingText(raw) {
  return geminiParts(raw)
    .filter((part) => part?.thought === true)
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("");
}

function geminiParts(raw) {
  return raw?.candidates?.[0]?.content?.parts ?? [];
}

function geminiVisibleParts(raw) {
  return geminiParts(raw).filter((part) => part?.thought !== true);
}

function mapFinishReason(raw) {
  if (geminiFunctionCalls(raw).length) return "tool_calls";
  const reason = raw?.candidates?.[0]?.finishReason;
  if (!reason || reason === "STOP") return "stop";
  if (reason === "MAX_TOKENS") return "length";
  if (reason === "SAFETY" || reason === "BLOCKLIST" || reason === "PROHIBITED_CONTENT") return "content_filter";
  return "stop";
}

function buildGeminiExtra(extra = {}) {
  const out = filterGeminiExtra(extra);
  const convertedTools = convertToolsToGemini(extra.tools);
  if (convertedTools.length) out.tools = convertedTools;
  const convertedToolConfig = convertToolChoiceToGemini(extra.tool_choice);
  if (convertedToolConfig) out.toolConfig = convertedToolConfig;
  return out;
}

function filterGeminiExtra(extra = {}) {
  const allowed = new Set(["safetySettings", "toolConfig", "cachedContent"]);
  const out = {};
  for (const [key, value] of Object.entries(extra)) {
    if (allowed.has(key) && value != null) out[key] = value;
  }
  return out;
}

function convertToolsToGemini(tools) {
  if (!Array.isArray(tools) || !tools.length) return [];
  const nativeTools = [];
  const functionDeclarations = [];

  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    if (Array.isArray(tool.functionDeclarations) || Array.isArray(tool.function_declarations)) {
      const declarations = tool.functionDeclarations ?? tool.function_declarations;
      nativeTools.push({ ...tool, functionDeclarations: declarations.map(convertFunctionDeclaration).filter(Boolean) });
      continue;
    }
    if (tool.googleSearch || tool.codeExecution) {
      nativeTools.push(tool);
      continue;
    }
    if (tool.type === "function" && tool.function) {
      const declaration = convertFunctionDeclaration(tool.function);
      if (declaration) functionDeclarations.push(declaration);
      continue;
    }
    if (tool.name) {
      const declaration = convertFunctionDeclaration(tool);
      if (declaration) functionDeclarations.push(declaration);
    }
  }

  if (functionDeclarations.length) nativeTools.push({ functionDeclarations });
  return nativeTools;
}

function convertFunctionDeclaration(fn) {
  if (!fn || typeof fn !== "object" || !fn.name) return null;
  const declaration = {
    name: String(fn.name),
  };
  if (fn.description != null) declaration.description = String(fn.description);
  declaration.parameters = sanitizeGeminiSchema(fn.parameters ?? { type: "object", properties: {} });
  return declaration;
}

function sanitizeGeminiSchema(schema) {
  if (!schema || typeof schema !== "object") return { type: "OBJECT", properties: {} };
  const out = {};
  const rawType = Array.isArray(schema.type)
    ? schema.type.find((item) => item && item !== "null")
    : schema.type;
  const type = normalizeGeminiSchemaType(rawType);
  if (type) out.type = type;
  if (schema.description != null) out.description = String(schema.description);
  if (schema.format != null) out.format = String(schema.format);
  if (Array.isArray(schema.enum)) out.enum = schema.enum.map((value) => String(value));
  if (schema.nullable === true || (Array.isArray(schema.type) && schema.type.includes("null"))) out.nullable = true;
  if (Number.isFinite(Number(schema.minimum))) out.minimum = Number(schema.minimum);
  if (Number.isFinite(Number(schema.maximum))) out.maximum = Number(schema.maximum);
  if (Number.isSafeInteger(Number(schema.minItems))) out.minItems = Number(schema.minItems);
  if (Number.isSafeInteger(Number(schema.maxItems))) out.maxItems = Number(schema.maxItems);
  if (schema.items && typeof schema.items === "object") out.items = sanitizeGeminiSchema(schema.items);
  if (schema.properties && typeof schema.properties === "object") {
    out.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      out.properties[key] = sanitizeGeminiSchema(value);
    }
  }
  if (Array.isArray(schema.required)) out.required = schema.required.map(String);
  if (!out.type) out.type = out.properties ? "OBJECT" : "STRING";
  if (out.type === "OBJECT" && !out.properties) out.properties = {};
  return out;
}

function normalizeGeminiSchemaType(type) {
  const text = String(type ?? "").toLowerCase();
  if (text === "object") return "OBJECT";
  if (text === "array") return "ARRAY";
  if (text === "string") return "STRING";
  if (text === "number") return "NUMBER";
  if (text === "integer") return "INTEGER";
  if (text === "boolean") return "BOOLEAN";
  return "";
}

function convertToolChoiceToGemini(toolChoice) {
  if (toolChoice == null) return null;
  if (typeof toolChoice === "string") {
    const mode = {
      auto: "AUTO",
      none: "NONE",
      required: "ANY",
    }[toolChoice];
    return mode ? { functionCallingConfig: { mode } } : null;
  }
  const name = toolChoice?.function?.name ?? toolChoice?.name;
  if (name) {
    return {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [String(name)],
      },
    };
  }
  return null;
}

function geminiFunctionCalls(raw) {
  return geminiParts(raw)
    .map((part) => {
      const call = part?.functionCall ?? part?.function_call;
      if (!call?.name) return null;
      return {
        id: call.id ?? part.id,
        name: call.name,
        args: call.args ?? {},
        thoughtSignature: part.thoughtSignature ?? part.thought_signature,
      };
    })
    .filter(Boolean);
}

function geminiFunctionCallToOpenAI(call, index = 0) {
  const id = String(call.id || `gemini_call_${index}_${hashSmall(`${call.name}:${JSON.stringify(call.args ?? {})}`)}`);
  const functionCall = {
    name: String(call.name),
    arguments: JSON.stringify(call.args ?? {}),
  };
  if (call.thoughtSignature) functionCall.thought_signature = call.thoughtSignature;
  const out = {
    id,
    type: "function",
    function: functionCall,
  };
  if (call.thoughtSignature) out.gemini_thought_signature = call.thoughtSignature;
  return out;
}

function hashSmall(value) {
  let hash = 0;
  for (const ch of String(value)) {
    hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  }
  return Math.abs(hash).toString(36);
}

const THOUGHT_SIGNATURE_ID_SEPARATOR = "__gts__";

function encodeThoughtSignatureInToolCallId(id, thoughtSignature) {
  if (!thoughtSignature) return id;
  if (String(id).includes(THOUGHT_SIGNATURE_ID_SEPARATOR)) return id;
  const encoded = base64UrlEncode(String(thoughtSignature));
  return `${id}${THOUGHT_SIGNATURE_ID_SEPARATOR}${encoded}`;
}

function decodeThoughtSignatureFromToolCallId(id) {
  const text = String(id ?? "");
  const index = text.lastIndexOf(THOUGHT_SIGNATURE_ID_SEPARATOR);
  if (index < 0) return { originalId: text, thoughtSignature: "" };
  const originalId = text.slice(0, index);
  const encoded = text.slice(index + THOUGHT_SIGNATURE_ID_SEPARATOR.length);
  return { originalId, thoughtSignature: base64UrlDecode(encoded) };
}

function base64UrlEncode(value) {
  return Buffer.from(String(value), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  try {
    const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseSseFrame(frame) {
  const lines = String(frame || "").split(/\r?\n/);
  const data = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  return { data: data.join("\n") };
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
