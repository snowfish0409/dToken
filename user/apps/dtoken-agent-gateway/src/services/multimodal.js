/**
 * dToken canonical multimodal message format.
 *
 * User-facing clients should send one stable internal shape:
 *
 * {
 *   role: "system" | "user" | "assistant" | "tool",
 *   content: [
 *     { type: "text", text: "..." },
 *     { type: "image", source: { type: "data_url"|"url"|"base64"|"file_id", url?, data?, media_type?, file_id? }, detail? },
 *     { type: "video", source: { type: "data_url"|"url"|"base64"|"file_id", url?, data?, media_type?, file_id? } },
 *     { type: "audio", source: { type: "data_url"|"url"|"base64"|"file_id", url?, data?, media_type?, file_id? } },
 *     { type: "file",  source: { type: "data_url"|"url"|"base64"|"file_id", url?, data?, media_type?, file_id? }, name? }
 *   ]
 * }
 *
 * Relay backends are responsible for converting this shape to OpenAI Chat,
 * OpenAI Responses, Anthropic Messages, Gemini generateContent, or other
 * provider-native schemas. Legacy OpenAI-style content is accepted and
 * normalized into this canonical form.
 */

export const DTOKEN_MULTIMODAL_VERSION = "dtoken.multimodal.v1";

export function normalizeMessagesToDToken(messages = []) {
  return (messages ?? []).map((message) => {
    const reasoning = extractReasoningInfo(message?.content);
    const reasoningContent = message?.reasoning_content ?? message?.reasoningContent ?? reasoning.content;
    const out = {
      role: normalizeRole(message?.role),
      content: normalizeContentParts(message?.content),
    };
    if (message?.name != null) out.name = message.name;
    if (message?.tool_call_id != null) out.tool_call_id = message.tool_call_id;
    if (message?.tool_calls != null) out.tool_calls = message.tool_calls;
    if (reasoningContent) out.reasoning_content = String(reasoningContent);
    const reasoningSignature = message?.reasoning_signature ?? message?.thinking_signature ?? reasoning.signature;
    if (reasoningSignature) out.reasoning_signature = String(reasoningSignature);
    return out;
  });
}

function extractReasoningInfo(content) {
  if (!Array.isArray(content)) return { content: "", signature: "" };
  const chunks = [];
  let signature = "";
  for (const part of content) {
    const type = String(part?.type ?? "").toLowerCase();
    if (type !== "thinking" && type !== "reasoning" && type !== "reasoning_content") continue;
    const text = part.thinking ?? part.reasoning ?? part.reasoning_content ?? part.text ?? "";
    if (text) chunks.push(String(text));
    if (!signature && part.signature) signature = String(part.signature);
  }
  return { content: chunks.join("\n"), signature };
}

export function summarizeCanonicalMessages(messages = []) {
  const total = emptySummary();
  for (const message of messages ?? []) {
    addSummary(total, summarizeCanonicalContent(message?.content));
  }
  return total;
}

export function summarizeCanonicalContent(content = []) {
  const total = emptySummary();
  for (const part of normalizeContentParts(content)) {
    if (part.type === "text") {
      total.textChars += String(part.text ?? "").length;
    } else if (part.type === "image") {
      total.imageParts++;
      total.imageBytes += sourceBytes(part.source);
    } else if (part.type === "video") {
      total.videoParts++;
      total.videoBytes += sourceBytes(part.source);
    } else if (part.type === "audio") {
      total.audioParts++;
      total.audioBytes += sourceBytes(part.source);
    } else if (part.type === "file") {
      total.fileParts++;
      total.fileBytes += sourceBytes(part.source);
    } else {
      total.nonTextParts++;
    }
  }
  return total;
}

export function filterCanonicalMessagesForCapabilities(messages, capabilities = {}) {
  const allow = {
    image: !!capabilities.image,
    video: !!capabilities.video,
    audio: !!capabilities.audio,
    file: !!capabilities.file,
  };
  const normalized = normalizeMessagesToDToken(messages);
  const originalSummary = summarizeCanonicalMessages(normalized);
  const output = [];
  let ignoredImageParts = 0;
  let ignoredImageBytes = 0;
  let ignoredVideoParts = 0;
  let ignoredVideoBytes = 0;
  let ignoredAudioParts = 0;
  let ignoredAudioBytes = 0;
  let ignoredFileParts = 0;
  let ignoredFileBytes = 0;
  let ignoredNonTextParts = 0;

  for (const message of normalized) {
    const nextParts = [];
    for (const part of message.content) {
      if (part.type === "text") {
        if (String(part.text ?? "")) nextParts.push(part);
        continue;
      }
      if (part.type === "image") {
        if (allow.image) nextParts.push(part);
        else { ignoredImageParts++; ignoredImageBytes += sourceBytes(part.source); }
        continue;
      }
      if (part.type === "video") {
        if (allow.video) nextParts.push(part);
        else { ignoredVideoParts++; ignoredVideoBytes += sourceBytes(part.source); }
        continue;
      }
      if (part.type === "audio") {
        if (allow.audio) nextParts.push(part);
        else { ignoredAudioParts++; ignoredAudioBytes += sourceBytes(part.source); }
        continue;
      }
      if (part.type === "file") {
        if (allow.file) nextParts.push(part);
        else { ignoredFileParts++; ignoredFileBytes += sourceBytes(part.source); }
        continue;
      }
      ignoredNonTextParts++;
    }
    if (nextParts.length || preservesToolTurn(message)) {
      output.push({ ...message, content: nextParts });
    }
  }

  return {
    messages: output,
    originalSummary,
    summary: summarizeCanonicalMessages(output),
    ignoredImageParts,
    ignoredImageBytes,
    ignoredVideoParts,
    ignoredVideoBytes,
    ignoredAudioParts,
    ignoredAudioBytes,
    ignoredFileParts,
    ignoredFileBytes,
    ignoredNonTextParts,
  };
}

function preservesToolTurn(message) {
  return message?.role === "tool" || message?.tool_call_id != null || message?.tool_calls != null;
}

export function renderMessagesForProvider(messages, options = {}) {
  const {
    format = "openai_chat_completions",
    geminiThoughtSignatureResolver = null,
    preserveReasoningContent = false,
    emitAnthropicThinking = true,
  } = options;
  const canonical = normalizeMessagesToDToken(messages);
  if (format === "anthropic_messages") return renderAnthropicMessages(canonical, { emitThinking: emitAnthropicThinking });
  if (format === "gemini_generate_content") {
    return renderGeminiContents(canonical, { geminiThoughtSignatureResolver });
  }
  if (format === "openai_responses") return renderOpenAIResponsesInput(canonical);
  if (format === "xai_responses") return renderOpenAIResponsesInput(canonical);
  if (format === "openai_chat_completions" || format === "openai_compatible") {
    return canonical.map((message) => {
      const out = {
        role: message.role,
        content: renderOpenAIChatContent(message.content),
      };
      if (message.name != null) out.name = message.name;
      if (message.tool_call_id != null) out.tool_call_id = message.tool_call_id;
      if (message.tool_calls != null) out.tool_calls = message.tool_calls;
      if (preserveReasoningContent && message.reasoning_content != null) out.reasoning_content = message.reasoning_content;
      return out;
    });
  }
  return canonical.map((message) => {
    const out = {
      role: message.role,
      content: renderOpenAIChatContent(message.content),
    };
    if (message.name != null) out.name = message.name;
    if (message.tool_call_id != null) out.tool_call_id = message.tool_call_id;
    if (message.tool_calls != null) out.tool_calls = message.tool_calls;
    if (preserveReasoningContent && message.reasoning_content != null) out.reasoning_content = message.reasoning_content;
    return out;
  });
}

export function normalizeAssistantOutput(value) {
  const parts = normalizeOutputParts(value);
  const text = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("");
  const attachments = parts
    .filter((part) => ["image", "video", "audio", "file"].includes(part.type))
    .map(outputPartToAttachment)
    .filter(Boolean);
  return { text, parts, attachments };
}

export function normalizeOutputParts(value) {
  if (typeof value === "string") return value ? [{ type: "text", text: value }] : [];
  if (!Array.isArray(value)) return value == null ? [] : normalizeOutputParts([value]);
  const parts = [];
  for (const raw of value) {
    const part = normalizeOutputPart(raw);
    if (part) parts.push(part);
  }
  return mergeAdjacentText(parts);
}

export function normalizeContentParts(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return content == null ? [] : [{ type: "text", text: String(content) }];
  const parts = [];
  for (const raw of content) {
    const part = normalizePart(raw);
    if (part) parts.push(part);
  }
  return mergeAdjacentText(parts);
}

export function outputPartToAttachment(part) {
  if (!part || !["image", "video", "audio", "file"].includes(part.type)) return null;
  const url = sourceToDataUrl(part.source) || part.source?.url || part.source?.file_id || "";
  if (!url) return null;
  const mime = part.source?.media_type ?? part.source?.mime_type ?? defaultMimeForPart(part.type);
  return {
    type: part.type,
    name: part.name || defaultNameForPart(part.type, mime),
    mime,
    size: sourceBytes(part.source),
    dataUrl: url,
    url,
  };
}

export function dataUrlToSource(value, fallbackMediaType = "") {
  const text = String(value ?? "");
  const match = text.match(/^data:([^;,]+);base64,(.+)$/i);
  if (match) {
    return {
      type: "data_url",
      media_type: match[1],
      data: match[2],
      url: text,
    };
  }
  if (/^https?:\/\//i.test(text)) return { type: "url", url: text, media_type: fallbackMediaType || undefined };
  if (text) return { type: "base64", data: text, media_type: fallbackMediaType || undefined };
  return { type: "unknown" };
}

export function sourceToDataUrl(source) {
  if (!source) return "";
  if (source.url && source.type === "data_url") return source.url;
  if (source.url && /^data:/i.test(source.url)) return source.url;
  if (source.type === "base64" || source.data) {
    const mediaType = source.media_type ?? source.mime_type ?? "application/octet-stream";
    return `data:${mediaType};base64,${source.data ?? ""}`;
  }
  return source.url ?? "";
}

export function sourceBytes(source) {
  if (!source) return 0;
  if (source.size != null) return Number(source.size) || 0;
  const data = source.data ?? "";
  if (data) return estimateBase64Bytes(data);
  const url = source.url ?? "";
  const match = String(url).match(/^data:[^,]*;base64,([a-z0-9+/=\s]+)$/i);
  if (match) return estimateBase64Bytes(match[1]);
  return 0;
}

function normalizePart(part) {
  if (typeof part === "string") return part ? { type: "text", text: part } : null;
  if (!part || typeof part !== "object") return null;
  const type = String(part.type ?? "").toLowerCase();
  if (type === "text" || type === "input_text" || type === "output_text") {
    return { type: "text", text: String(part.text ?? part.value ?? "") };
  }
  if (type === "thinking" || type === "reasoning" || type === "reasoning_content" || type === "redacted_thinking") {
    return null;
  }
  if (type === "image" || type === "image_url" || type === "input_image") {
    return mediaPart("image", part, part.image_url ?? part.image ?? part.source ?? part.url, part.detail);
  }
  if (type === "video" || type === "video_url" || type === "input_video") {
    return mediaPart("video", part, part.video_url ?? part.video ?? part.source ?? part.url);
  }
  if (type === "audio" || type === "audio_url" || type === "input_audio") {
    return mediaPart("audio", part, part.audio_url ?? part.input_audio ?? part.audio ?? part.source ?? part.url);
  }
  if (type === "file" || type === "file_url" || type === "input_file" || type === "document") {
    return mediaPart("file", part, part.file_url ?? part.file ?? part.source ?? part.url);
  }
  return { type: "unknown", raw: part };
}

function normalizeOutputPart(part) {
  if (typeof part === "string") return part ? { type: "text", text: part } : null;
  if (!part || typeof part !== "object") return null;
  const type = String(part.type ?? "").toLowerCase();
  if (type === "text" || type === "output_text" || type === "summary_text") {
    return { type: "text", text: String(part.text ?? part.value ?? "") };
  }
  if (part.text && !part.inlineData && !part.inline_data && !part.fileData && !part.file_data) {
    return { type: "text", text: String(part.text) };
  }
  if (type === "image" || type === "output_image" || type === "image_url" || type === "input_image") {
    return mediaPart("image", part, part.image_url ?? part.image ?? part.source ?? part.url ?? part.b64_json ?? part.data, part.detail);
  }
  if (type === "image_generation_call" && (part.result || part.b64_json || part.image_url)) {
    return mediaPart("image", { ...part, media_type: part.media_type ?? "image/png", name: part.name ?? "generated-image.png" }, part.result ?? part.b64_json ?? part.image_url);
  }
  if (type === "video" || type === "output_video" || type === "video_url" || type === "input_video") {
    return mediaPart("video", part, part.video_url ?? part.video ?? part.source ?? part.url ?? part.data);
  }
  if (type === "audio" || type === "output_audio" || type === "audio_url" || type === "input_audio") {
    return mediaPart("audio", part, part.audio_url ?? part.input_audio ?? part.audio ?? part.source ?? part.url ?? part.data);
  }
  if (type === "file" || type === "output_file" || type === "file_url" || type === "input_file" || type === "document") {
    return mediaPart("file", part, part.file_url ?? part.file ?? part.source ?? part.url ?? part.data ?? part.file_id);
  }
  const inline = part.inlineData ?? part.inline_data;
  if (inline?.data) {
    return mediaPart(kindForMime(inline.mimeType ?? inline.mime_type), part, {
      type: "base64",
      data: inline.data,
      media_type: inline.mimeType ?? inline.mime_type,
    });
  }
  const fileData = part.fileData ?? part.file_data;
  if (fileData?.fileUri || fileData?.file_uri) {
    return mediaPart(kindForMime(fileData.mimeType ?? fileData.mime_type), part, {
      type: "url",
      url: fileData.fileUri ?? fileData.file_uri,
      media_type: fileData.mimeType ?? fileData.mime_type,
    });
  }
  return null;
}

function mediaPart(kind, original, value, detail) {
  const source = normalizeSource(value, original);
  const out = { type: kind, source };
  if (detail ?? original.detail) out.detail = detail ?? original.detail;
  if (original.name) out.name = original.name;
  if (original.size != null) out.source.size = original.size;
  return out;
}

function normalizeSource(value, original = {}) {
  if (typeof value === "string") return dataUrlToSource(value, original.media_type ?? original.mime_type ?? "");
  if (!value || typeof value !== "object") return dataUrlToSource(original.url ?? "", original.media_type ?? original.mime_type ?? "");
  if (value.type === "base64") return { type: "base64", media_type: value.media_type ?? value.mime_type, data: value.data };
  if (value.type === "url") return { type: "url", url: value.url, media_type: value.media_type ?? value.mime_type };
  if (value.type === "file_id") return { type: "file_id", file_id: value.file_id ?? value.id, media_type: value.media_type ?? value.mime_type };
  if (value.type === "data_url") return dataUrlToSource(value.url ?? value.data ?? "", value.media_type ?? value.mime_type ?? "");
  if (value.url) return dataUrlToSource(value.url, value.media_type ?? value.mime_type ?? "");
  if (value.data) return { type: "base64", media_type: value.media_type ?? value.mime_type, data: value.data };
  if (value.file_id || value.id) return { type: "file_id", file_id: value.file_id ?? value.id, media_type: value.media_type ?? value.mime_type };
  return dataUrlToSource(original.url ?? "", original.media_type ?? original.mime_type ?? "");
}

function renderOpenAIChatContent(parts) {
  const normalized = normalizeContentParts(parts);
  if (normalized.every((part) => part.type === "text")) {
    return normalized.map((part) => part.text).join("\n");
  }
  return normalized.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image") {
      const imageUrl = { url: sourceToDataUrl(part.source) || part.source?.url };
      if (part.detail) imageUrl.detail = part.detail;
      return { type: "image_url", image_url: imageUrl };
    }
    if (part.type === "video") return { type: "video_url", video_url: { url: sourceToDataUrl(part.source) || part.source?.url } };
    if (part.type === "audio") {
      const url = sourceToDataUrl(part.source) || part.source?.url;
      return { type: "audio_url", audio_url: { url } };
    }
    if (part.type === "file") return { type: "file_url", file_url: { url: sourceToDataUrl(part.source) || part.source?.url }, name: part.name };
    return { type: "text", text: "" };
  }).filter((part) => part.type !== "text" || part.text);
}

function renderOpenAIResponsesInput(messages) {
  const input = [];
  for (const message of normalizeMessagesToDToken(messages)) {
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: String(message.tool_call_id ?? ""),
        output: responseToolOutput(message.content),
      });
      continue;
    }

    const content = message.content
      .map(renderOpenAIResponsesContentPart)
      .filter((part) => part.text || part.image_url || part.audio_url || part.video_url || part.file_url);
    if (content.length) {
      input.push({
        type: "message",
        role: responseMessageRole(message.role),
        content,
      });
    }

    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      input.push(...message.tool_calls.map((call, index) => {
        const fn = call?.function ?? {};
        const name = String(fn.name ?? call?.name ?? "");
        if (!name) return null;
        return {
          type: "function_call",
          call_id: String(call?.id ?? call?.tool_call_id ?? `call_${index}`),
          name,
          arguments: typeof fn.arguments === "string"
            ? fn.arguments
            : JSON.stringify(fn.arguments ?? call?.arguments ?? {}),
        };
      }).filter(Boolean));
    }
  }
  return input.length ? input : [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: " " }],
  }];
}

function responseMessageRole(role) {
  if (role === "assistant") return "assistant";
  if (role === "system" || role === "developer") return role;
  return "user";
}

function renderOpenAIResponsesContentPart(part) {
  if (part.type === "text") return { type: "input_text", text: part.text };
  if (part.type === "image") return { type: "input_image", image_url: sourceToDataUrl(part.source) || part.source?.url, ...(part.detail ? { detail: part.detail } : {}) };
  if (part.type === "audio") return { type: "input_audio", audio_url: sourceToDataUrl(part.source) || part.source?.url };
  if (part.type === "video") return { type: "input_video", video_url: sourceToDataUrl(part.source) || part.source?.url };
  if (part.type === "file") return { type: "input_file", file_url: sourceToDataUrl(part.source) || part.source?.url, filename: part.name };
  return { type: "input_text", text: "" };
}

function responseToolOutput(content) {
  const parts = normalizeContentParts(content);
  const text = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n");
  if (text || parts.every((part) => part.type === "text")) return text || " ";
  return parts.map(renderOpenAIResponsesContentPart)
    .filter((part) => part.text || part.image_url || part.audio_url || part.video_url || part.file_url);
}

function renderAnthropicMessages(messages, { emitThinking = true } = {}) {
  const systemParts = [];
  const converted = [];
  for (const message of normalizeMessagesToDToken(messages)) {
    const content = message.content.map((part) => {
      if (part.type === "text") return part.text ? { type: "text", text: part.text } : null;
      if (part.type === "image") return renderAnthropicImage(part);
      if (part.type === "file") return renderAnthropicDocument(part);
      return null;
    }).filter(Boolean);
    if (emitThinking && message.role === "assistant" && message.reasoning_content) {
      const thinking = { type: "thinking", thinking: message.reasoning_content };
      if (message.reasoning_signature) thinking.signature = message.reasoning_signature;
      content.unshift(thinking);
    }
    if (message.role === "system") {
      systemParts.push(content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
      continue;
    }
    if (message.role === "tool") {
      const toolResult = {
        type: "tool_result",
        tool_use_id: String(message.tool_call_id ?? ""),
        content: content.length ? content : [{ type: "text", text: " " }],
      };
      const previous = converted[converted.length - 1];
      if (previous && previous.role === "user") previous.content.push(toolResult);
      else converted.push({ role: "user", content: [toolResult] });
      continue;
    }
    if (message.role === "assistant") {
      content.push(...renderAnthropicToolUses(message.tool_calls));
    }
    const role = message.role === "assistant" ? "assistant" : "user";
    const safeContent = content.length ? content : [{ type: "text", text: " " }];
    const previous = converted[converted.length - 1];
    if (previous && previous.role === role) previous.content.push(...safeContent);
    else converted.push({ role, content: safeContent });
  }
  if (!converted.length) converted.push({ role: "user", content: [{ type: "text", text: " " }] });
  return { system: systemParts.filter(Boolean).join("\n\n") || null, messages: converted };
}

function renderAnthropicToolUses(toolCalls = []) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((call, index) => {
    const fn = call?.function ?? {};
    const name = String(fn.name ?? call?.name ?? "");
    if (!name) return null;
    return {
      type: "tool_use",
      id: String(call?.id ?? call?.tool_call_id ?? `toolu_${index}`),
      name,
      input: parseToolArguments(fn.arguments ?? call?.arguments),
    };
  }).filter(Boolean);
}

function renderAnthropicImage(part) {
  const source = part.source ?? {};
  if (source.type === "url") return { type: "image", source: { type: "url", url: source.url } };
  const data = source.data || parseDataUrl(source.url)?.data;
  const mediaType = source.media_type || parseDataUrl(source.url)?.mediaType || "image/png";
  if (data) return { type: "image", source: { type: "base64", media_type: mediaType, data } };
  return null;
}

function renderAnthropicDocument(part) {
  const source = part.source ?? {};
  if (source.type === "url") return { type: "document", source: { type: "url", url: source.url } };
  const data = source.data || parseDataUrl(source.url)?.data;
  const mediaType = source.media_type || parseDataUrl(source.url)?.mediaType || "application/pdf";
  if (data) return { type: "document", source: { type: "base64", media_type: mediaType, data }, title: part.name };
  return null;
}

function renderGeminiContents(messages, { geminiThoughtSignatureResolver = null } = {}) {
  const systemText = [];
  const contents = [];
  const toolCallNamesById = new Map();
  for (const message of normalizeMessagesToDToken(messages)) {
    const functionCallParts = renderGeminiFunctionCalls(message.tool_calls, toolCallNamesById, geminiThoughtSignatureResolver);
    const parts = [
      ...message.content.map(renderGeminiPart).filter(Boolean),
      ...functionCallParts,
    ];
    if (message.role === "system") {
      systemText.push(parts.filter((part) => part.text).map((part) => part.text).join("\n"));
      continue;
    }
    if (message.role === "tool") {
      const part = renderGeminiFunctionResponse(message, toolCallNamesById);
      contents.push({
        role: "user",
        parts: [part],
      });
      continue;
    }
    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts: parts.length ? parts : [{ text: " " }],
    });
  }
  return {
    system_instruction: systemText.filter(Boolean).length ? { parts: systemText.filter(Boolean).map((text) => ({ text })) } : null,
    contents: contents.length ? contents : [{ role: "user", parts: [{ text: " " }] }],
  };
}

function renderGeminiFunctionCalls(toolCalls, toolCallNamesById, thoughtSignatureResolver) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return [];
  return toolCalls.map((call, index) => {
    const fn = call?.function ?? {};
    const name = String(fn.name ?? call.name ?? "");
    if (!name) return null;
    const rawId = call.id ?? call.tool_call_id ?? `call_${index}`;
    const decodedId = decodeGeminiThoughtSignatureFromToolCallId(rawId);
    const id = decodedId.originalId || String(rawId);
    const args = parseToolArguments(fn.arguments);
    const directThoughtSignature = call.gemini_thought_signature
      ?? fn.thought_signature
      ?? call.thought_signature
      ?? decodedId.thoughtSignature
      ?? thoughtSignatureResolver?.({ id: String(rawId), originalId: id, name, args, call });
    if (index === 0 && !directThoughtSignature) {
      return {
        text: `[tool call omitted: ${name} ${JSON.stringify(args)}]`,
      };
    }
    toolCallNamesById.set(String(rawId), name);
    toolCallNamesById.set(String(id), name);
    const part = {
      functionCall: {
        name,
        args,
      },
    };
    if (id) part.functionCall.id = String(id);
    const thoughtSignature = directThoughtSignature;
    if (thoughtSignature) part.thoughtSignature = thoughtSignature;
    return part;
  }).filter(Boolean);
}

function renderGeminiFunctionResponse(message, toolCallNamesById) {
  const id = message.tool_call_id != null ? String(message.tool_call_id) : "";
  const decodedId = decodeGeminiThoughtSignatureFromToolCallId(id);
  const originalId = decodedId.originalId || id;
  const knownName = toolCallNamesById.get(id) ?? toolCallNamesById.get(originalId);
  const name = String((message.name ?? knownName ?? originalId) || "tool_response");
  const response = parseToolResponseContent(message.content);
  if (!knownName && !message.name) {
    return { text: `[tool response for ${name}: ${JSON.stringify(response)}]` };
  }
  const functionResponse = { name, response };
  if (originalId) functionResponse.id = originalId;
  return { functionResponse };
}

const GEMINI_THOUGHT_SIGNATURE_ID_SEPARATOR = "__gts__";

function decodeGeminiThoughtSignatureFromToolCallId(id) {
  const text = String(id ?? "");
  const index = text.lastIndexOf(GEMINI_THOUGHT_SIGNATURE_ID_SEPARATOR);
  if (index < 0) return { originalId: text, thoughtSignature: "" };
  const originalId = text.slice(0, index);
  const encoded = text.slice(index + GEMINI_THOUGHT_SIGNATURE_ID_SEPARATOR.length);
  return { originalId, thoughtSignature: base64UrlDecode(encoded) };
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

function parseToolArguments(value) {
  if (value == null || value === "") return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : { value: parsed };
  } catch {
    return { value: String(value) };
  }
}

function parseToolResponseContent(content) {
  const text = normalizeContentParts(content)
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  if (!text) return { result: "" };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed;
    return { result: parsed };
  } catch {
    return { result: text };
  }
}

function renderGeminiPart(part) {
  if (part.type === "text") return part.text ? { text: part.text } : null;
  if (["image", "video", "audio", "file"].includes(part.type)) {
    const source = part.source ?? {};
    const parsed = parseDataUrl(source.url);
    const data = source.data || parsed?.data;
    const mimeType = source.media_type || parsed?.mediaType || defaultMimeForPart(part.type);
    if (data) return { inlineData: { mimeType, data } };
    if (source.url) return { fileData: { mimeType, fileUri: source.url } };
    if (source.file_id) return { fileData: { mimeType, fileUri: source.file_id } };
  }
  return null;
}

function parseDataUrl(value) {
  const match = String(value ?? "").match(/^data:([^;,]+);base64,(.+)$/i);
  return match ? { mediaType: match[1], data: match[2] } : null;
}

function defaultMimeForPart(type) {
  if (type === "image") return "image/png";
  if (type === "video") return "video/mp4";
  if (type === "audio") return "audio/mpeg";
  return "application/octet-stream";
}

function defaultNameForPart(type, mime = "") {
  const ext = mime.includes("/")
    ? mime.split("/").pop().replace(/[^a-z0-9]+/gi, "").slice(0, 8)
    : "";
  if (type === "image") return `image.${ext || "png"}`;
  if (type === "video") return `video.${ext || "mp4"}`;
  if (type === "audio") return `audio.${ext || "mp3"}`;
  return `file${ext ? `.${ext}` : ""}`;
}

function kindForMime(mime = "") {
  const text = String(mime || "").toLowerCase();
  if (text.startsWith("image/")) return "image";
  if (text.startsWith("video/")) return "video";
  if (text.startsWith("audio/")) return "audio";
  return "file";
}

function normalizeRole(role) {
  const r = String(role ?? "user").toLowerCase();
  return ["system", "user", "assistant", "tool"].includes(r) ? r : "user";
}

function mergeAdjacentText(parts) {
  const out = [];
  for (const part of parts) {
    const previous = out[out.length - 1];
    if (part.type === "text" && previous?.type === "text") previous.text += `\n${part.text}`;
    else out.push(part);
  }
  return out;
}

function emptySummary() {
  return {
    textChars: 0,
    imageParts: 0,
    imageBytes: 0,
    videoParts: 0,
    videoBytes: 0,
    audioParts: 0,
    audioBytes: 0,
    fileParts: 0,
    fileBytes: 0,
    nonTextParts: 0,
  };
}

function addSummary(total, next) {
  for (const key of Object.keys(total)) total[key] += Number(next[key] ?? 0);
  return total;
}

function estimateBase64Bytes(value) {
  const clean = String(value ?? "").replace(/\s+/g, "");
  if (!clean) return 0;
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(clean.length * 3 / 4) - padding);
}
