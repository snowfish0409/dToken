import {
  normalizeMessagesToDToken,
  renderMessagesForProvider,
  normalizeAssistantOutput,
} from "../services/multimodal.js";

export const CLIENT_FORMATS = Object.freeze({
  OPENAI_CHAT: "openai_chat_completions",
  OPENAI_RESPONSES: "openai_responses",
  ANTHROPIC_MESSAGES: "anthropic_messages",
});

export const UPSTREAM_FORMATS = Object.freeze({
  OPENAI_CHAT: "openai_chat_completions",
  OPENAI_RESPONSES: "openai_responses",
  ANTHROPIC_MESSAGES: "anthropic_messages",
  GEMINI_GENERATE_CONTENT: "gemini_generate_content",
  XAI_RESPONSES: "xai_responses",
});

export function normalizeClientFormat(value) {
  const text = normalizeToken(value);
  if (["openai", "openai_chat", "openai_chat_completion", "openai_chat_completions", "chat_completions"].includes(text)) {
    return CLIENT_FORMATS.OPENAI_CHAT;
  }
  if (["responses", "openai_responses", "openai_response"].includes(text)) {
    return CLIENT_FORMATS.OPENAI_RESPONSES;
  }
  if (["anthropic", "anthropic_messages", "claude", "messages"].includes(text)) {
    return CLIENT_FORMATS.ANTHROPIC_MESSAGES;
  }
  return CLIENT_FORMATS.OPENAI_CHAT;
}

export function normalizeUpstreamFormat(value, providerFamily = "") {
  const text = normalizeToken(value);
  if (["gemini", "google", "google_gemini", "gemini_generate_content"].includes(text)) {
    return UPSTREAM_FORMATS.GEMINI_GENERATE_CONTENT;
  }
  if (["anthropic", "claude", "anthropic_messages", "messages"].includes(text)) {
    return UPSTREAM_FORMATS.ANTHROPIC_MESSAGES;
  }
  if (["responses", "openai_responses"].includes(text)) return UPSTREAM_FORMATS.OPENAI_RESPONSES;
  if (["xai_responses", "grok_responses"].includes(text)) return UPSTREAM_FORMATS.XAI_RESPONSES;
  if (["openai", "openai_chat", "openai_compatible", "openai_chat_completions", "deepseek", "kimi", "qwen", "glm", "grok", "mistral", "openrouter", "llama", "meta"].includes(text)) {
    return UPSTREAM_FORMATS.OPENAI_CHAT;
  }
  return inferUpstreamFormat({ providerFamily });
}

export function inferUpstreamFormat(profileOrDToken = {}) {
  const dtoken = profileOrDToken.dtoken ?? profileOrDToken;
  const explicit = dtoken.upstreamFormat ?? dtoken.upstream_format ?? dtoken.messageFormat ?? dtoken.message_format;
  if (explicit) return normalizeUpstreamFormat(explicit, dtoken.providerFamily ?? dtoken.provider_family);
  const family = normalizeToken(dtoken.providerFamily ?? dtoken.provider_family ?? dtoken.company ?? "");
  if (family === "gemini" || family === "google" || family === "google_gemini") return UPSTREAM_FORMATS.GEMINI_GENERATE_CONTENT;
  if (family === "anthropic" || family === "claude") return UPSTREAM_FORMATS.ANTHROPIC_MESSAGES;
  if (family === "openai_responses") return UPSTREAM_FORMATS.OPENAI_RESPONSES;
  if (family === "xai_responses") return UPSTREAM_FORMATS.XAI_RESPONSES;
  const model = normalizeToken(dtoken.model ?? dtoken.upstreamModel ?? dtoken.upstream_model ?? "");
  if (model.includes("gemini")) return UPSTREAM_FORMATS.GEMINI_GENERATE_CONTENT;
  if (model.includes("claude") || model.includes("anthropic")) return UPSTREAM_FORMATS.ANTHROPIC_MESSAGES;
  if (model.includes("grok") && model.includes("response")) return UPSTREAM_FORMATS.XAI_RESPONSES;
  return UPSTREAM_FORMATS.OPENAI_CHAT;
}

export function normalizeAgentRequest({ body, clientFormat, profile }) {
  const format = normalizeClientFormat(clientFormat ?? profile?.agent?.clientFormat);
  if (format === CLIENT_FORMATS.OPENAI_RESPONSES) return responsesToChatBody(body, profile);
  if (format === CLIENT_FORMATS.ANTHROPIC_MESSAGES) return anthropicToChatBody(body, profile);
  return openAIChatBody(body, profile);
}

export function shapeClientResponse({ payload, ackMeta, exposeDTokenMetadata, clientFormat, profile }) {
  const format = normalizeClientFormat(clientFormat);
  if (format === CLIENT_FORMATS.OPENAI_RESPONSES) {
    return shapeOpenAIResponses(payload, ackMeta, exposeDTokenMetadata);
  }
  if (format === CLIENT_FORMATS.ANTHROPIC_MESSAGES) {
    return shapeAnthropicMessages(payload, ackMeta, exposeDTokenMetadata, {
      emitThinking: shouldEmitAnthropicThinking(profile),
    });
  }
  return shapeOpenAIChat(payload, ackMeta, exposeDTokenMetadata);
}

export function clientFormatSupportsOpenAIStream(clientFormat) {
  return normalizeClientFormat(clientFormat) === CLIENT_FORMATS.OPENAI_CHAT;
}

export function formatHeaders(profile, clientFormat) {
  return {
    "X-dToken-Client-Format": normalizeClientFormat(clientFormat ?? profile?.agent?.clientFormat),
    "X-dToken-Upstream-Format": inferUpstreamFormat(profile),
    "X-dToken-Message-Format": "dtoken.multimodal.v1",
  };
}

export function renderCanonicalForUpstream(messages, upstreamFormat) {
  return renderMessagesForProvider(normalizeMessagesToDToken(messages), {
    format: normalizeUpstreamFormat(upstreamFormat),
  });
}

function openAIChatBody(body = {}, profile) {
  const out = {
    ...body,
    requested_model: body.model ?? null,
    model: profile?.dtoken?.model ?? body.model,
    messages: normalizeMessagesToDToken(body.messages ?? []),
  };
  if (out.max_tokens == null && body.max_completion_tokens != null) out.max_tokens = body.max_completion_tokens;
  if (out.max_tokens == null && body.max_output_tokens != null) out.max_tokens = body.max_output_tokens;
  if (body.tools != null) out.tools = normalizeToolsForUpstream(body.tools, inferUpstreamFormat(profile), CLIENT_FORMATS.OPENAI_CHAT);
  if (body.tool_choice != null) out.tool_choice = normalizeToolChoiceForUpstream(body.tool_choice, inferUpstreamFormat(profile), CLIENT_FORMATS.OPENAI_CHAT);
  return out;
}

function responsesToChatBody(body = {}, profile) {
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: String(body.instructions) });
  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item?.type === "message" && item.role) {
        messages.push({ role: item.role, content: item.content ?? "" });
      } else if (item?.role) {
        messages.push({ role: item.role, content: item.content ?? "" });
      } else if (typeof item === "string") {
        messages.push({ role: "user", content: item });
      }
    }
  }
  const out = {
    requested_model: body.model ?? null,
    model: profile?.dtoken?.model ?? body.model,
    messages: normalizeMessagesToDToken(messages),
    stream: body.stream === true,
  };
  if (body.max_output_tokens != null) out.max_tokens = body.max_output_tokens;
  if (out.max_tokens == null && body.max_completion_tokens != null) out.max_tokens = body.max_completion_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.tools != null) out.tools = normalizeToolsForUpstream(body.tools, inferUpstreamFormat(profile), CLIENT_FORMATS.OPENAI_RESPONSES);
  if (body.tool_choice != null) out.tool_choice = normalizeToolChoiceForUpstream(body.tool_choice, inferUpstreamFormat(profile), CLIENT_FORMATS.OPENAI_RESPONSES);
  // Client-side metadata is useful to Anthropic/OpenAI clients, but it is not
  // part of dToken metering and several OpenAI-compatible upstreams reject it.
  return out;
}

function anthropicToChatBody(body = {}, profile) {
  const messages = [];
  const system = body.system;
  const preserveThinking = isAnthropicUpstream(profile);
  if (typeof system === "string" && system) messages.push({ role: "system", content: system });
  else if (Array.isArray(system) && system.length) messages.push({ role: "system", content: system });
  messages.push(...anthropicMessagesToOpenAI(body.messages ?? [], { preserveThinking }));
  const out = {
    requested_model: body.model ?? null,
    model: profile?.dtoken?.model ?? body.model,
    messages: normalizeMessagesToDToken(messages),
    stream: body.stream === true,
  };
  if (body.max_tokens != null) out.max_tokens = body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;
  // Do not forward client metadata into the reseller/upstream request. Claude
  // Code sends Anthropic metadata that GLM rejects as an invalid API parameter.
  if (body.tools != null) out.tools = anthropicToolsToOpenAI(body.tools);
  if (body.tool_choice != null) out.tool_choice = anthropicToolChoiceToOpenAI(body.tool_choice);
  if (body.thinking != null && preserveThinking) out.thinking = body.thinking;
  return out;
}

function isAnthropicUpstream(profile) {
  const dtoken = profile?.dtoken ?? {};
  const providerFamily = dtoken.providerFamily ?? dtoken.provider_family;
  const upstream = normalizeUpstreamFormat(
    dtoken.upstreamFormat ?? dtoken.upstream_format ?? dtoken.messageFormat ?? dtoken.message_format,
    providerFamily
  );
  const family = normalizeToken(providerFamily ?? "");
  return upstream === UPSTREAM_FORMATS.ANTHROPIC_MESSAGES || family === "anthropic" || family === "claude";
}

export function shouldEmitAnthropicThinking(profile) {
  return isAnthropicUpstream(profile);
}

function anthropicMessagesToOpenAI(messages = [], { preserveThinking = true } = {}) {
  const out = [];
  for (const message of messages) {
    const role = String(message?.role ?? "user");
    const content = Array.isArray(message?.content) ? message.content : [{ type: "text", text: String(message?.content ?? "") }];
    if (role === "assistant") {
      const textParts = [];
      const reasoningParts = [];
      let reasoningSignature = "";
      const toolCalls = [];
      for (const part of content) {
        if (part?.type === "tool_use") {
          toolCalls.push({
            id: String(part.id ?? `toolu_${toolCalls.length}`),
            type: "function",
            function: {
              name: String(part.name ?? "tool"),
              arguments: JSON.stringify(part.input ?? {}),
            },
          });
        } else if (part?.type === "thinking" || part?.type === "reasoning" || part?.type === "reasoning_content") {
          if (!preserveThinking) continue;
          const thinking = part.thinking ?? part.reasoning ?? part.reasoning_content ?? part.text ?? "";
          if (thinking) reasoningParts.push(String(thinking));
          if (!reasoningSignature && part.signature) reasoningSignature = String(part.signature);
        } else if (part?.type === "redacted_thinking") {
          continue;
        } else {
          textParts.push(part);
        }
      }
      const assistant = { role: "assistant", content: textParts };
      if (toolCalls.length) assistant.tool_calls = toolCalls;
      if (reasoningParts.length) assistant.reasoning_content = reasoningParts.join("\n");
      if (reasoningSignature) assistant.reasoning_signature = reasoningSignature;
      out.push(assistant);
      continue;
    }

    const userParts = [];
    for (const part of content) {
      if (part?.type === "tool_result") {
        if (userParts.length) {
          out.push({ role: "user", content: [...userParts] });
          userParts.length = 0;
        }
        out.push({
          role: "tool",
          tool_call_id: String(part.tool_use_id ?? part.id ?? ""),
          content: anthropicToolResultText(part.content),
        });
      } else {
        userParts.push(part);
      }
    }
    if (userParts.length || !content.length) out.push({ role: "user", content: userParts });
  }
  return out;
}

function anthropicToolResultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part?.type === "text") return part.text ?? "";
    return JSON.stringify(part);
  }).filter(Boolean).join("\n");
}

function anthropicToolsToOpenAI(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    if (tool?.type === "function" && tool.function) return tool;
    return {
      type: "function",
      function: {
        name: String(tool?.name ?? ""),
        description: tool?.description ?? "",
        parameters: tool?.input_schema ?? tool?.parameters ?? { type: "object", properties: {} },
      },
    };
  }).filter((tool) => tool.function.name);
}

function anthropicToolChoiceToOpenAI(choice) {
  if (!choice || typeof choice !== "object") return choice;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "tool" && choice.name) return { type: "function", function: { name: choice.name } };
  return choice;
}

function normalizeToolsForUpstream(tools, upstreamFormat, sourceFormat) {
  const upstream = normalizeUpstreamFormat(upstreamFormat);
  const source = normalizeClientFormat(sourceFormat);
  if (source === CLIENT_FORMATS.OPENAI_RESPONSES) {
    if (upstream === UPSTREAM_FORMATS.OPENAI_RESPONSES || upstream === UPSTREAM_FORMATS.XAI_RESPONSES) {
      return normalizeResponsesTools(tools);
    }
    return responsesToolsToOpenAIChat(tools);
  }
  if (source === CLIENT_FORMATS.OPENAI_CHAT) {
    if (upstream === UPSTREAM_FORMATS.OPENAI_RESPONSES || upstream === UPSTREAM_FORMATS.XAI_RESPONSES) {
      return openAIChatToolsToResponses(tools);
    }
    return tools;
  }
  return tools;
}

function normalizeToolChoiceForUpstream(choice, upstreamFormat, sourceFormat) {
  const upstream = normalizeUpstreamFormat(upstreamFormat);
  const source = normalizeClientFormat(sourceFormat);
  if (source === CLIENT_FORMATS.OPENAI_RESPONSES &&
    upstream !== UPSTREAM_FORMATS.OPENAI_RESPONSES &&
    upstream !== UPSTREAM_FORMATS.XAI_RESPONSES) {
    if (choice?.type === "function" && choice.name) return { type: "function", function: { name: choice.name } };
    return choice;
  }
  if (source === CLIENT_FORMATS.OPENAI_CHAT &&
    (upstream === UPSTREAM_FORMATS.OPENAI_RESPONSES || upstream === UPSTREAM_FORMATS.XAI_RESPONSES)) {
    if (choice?.type === "function" && choice.function?.name) return { type: "function", name: choice.function.name };
    return choice;
  }
  return choice;
}

function responsesToolsToOpenAIChat(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    if (!tool || typeof tool !== "object") return null;
    if (tool.type === "function" && tool.function) return tool;
    if (tool.type !== "function") return tool;
    const name = String(tool.name ?? "");
    if (!name) return null;
    return {
      type: "function",
      function: {
        name,
        description: tool.description ?? "",
        parameters: tool.parameters ?? tool.input_schema ?? { type: "object", properties: {} },
      },
      ...(tool.strict != null ? { strict: tool.strict } : {}),
    };
  }).filter(Boolean);
}

function openAIChatToolsToResponses(tools) {
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

function normalizeResponsesTools(tools) {
  return openAIChatToolsToResponses(responsesToolsToOpenAIChat(tools));
}

function shapeOpenAIChat(payload, ackMeta, exposeDTokenMetadata) {
  const out = { ...payload };
  if (!exposeDTokenMetadata) delete out.dtoken;
  out.dtoken_gateway = gatewayAck(ackMeta);
  return out;
}

function shapeOpenAIResponses(payload, ackMeta, exposeDTokenMetadata) {
  const message = payload?.choices?.[0]?.message ?? {};
  const output = normalizeAssistantOutput(message.content_parts ?? message.content ?? "");
  const text = output.text || String(message.content ?? "");
  const content = responsesOutputContent(output.parts, text);
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((call, index) => {
      const fn = call?.function ?? {};
      const name = String(fn.name ?? call?.name ?? "");
      if (!name) return null;
      return {
        type: "function_call",
        id: String(call?.id ?? `call_${index}`),
        call_id: String(call?.id ?? call?.tool_call_id ?? `call_${index}`),
        name,
        arguments: typeof fn.arguments === "string"
          ? fn.arguments
          : JSON.stringify(fn.arguments ?? call?.arguments ?? {}),
      };
    }).filter(Boolean)
    : [];
  const out = {
    id: payload.id,
    object: "response",
    created_at: payload.created,
    model: payload.model,
    status: "completed",
    output: [{
      type: "message",
      role: "assistant",
      content,
    }, ...toolCalls],
    output_text: text,
    usage: {
      input_tokens: payload.usage?.prompt_tokens ?? 0,
      output_tokens: payload.usage?.completion_tokens ?? 0,
      total_tokens: payload.usage?.total_tokens ?? 0,
    },
    dtoken_gateway: gatewayAck(ackMeta),
  };
  if (exposeDTokenMetadata) out.dtoken = payload.dtoken;
  return out;
}

function responsesOutputContent(parts, text) {
  if (!Array.isArray(parts) || !parts.length) return [{ type: "output_text", text }];
  const content = parts.map((part) => {
    if (part.type === "text") return { type: "output_text", text: part.text ?? "" };
    if (part.type === "image") return { type: "output_image", image_url: part.source?.url ?? part.source?.file_id ?? "" };
    if (part.type === "audio") return { type: "output_audio", audio_url: part.source?.url ?? part.source?.file_id ?? "" };
    if (part.type === "video") return { type: "output_video", video_url: part.source?.url ?? part.source?.file_id ?? "" };
    if (part.type === "file") return { type: "output_file", file_url: part.source?.url ?? part.source?.file_id ?? "", filename: part.name };
    return null;
  }).filter(Boolean);
  return content.length ? content : [{ type: "output_text", text }];
}

function shapeAnthropicMessages(payload, ackMeta, exposeDTokenMetadata, { emitThinking = true } = {}) {
  const message = payload?.choices?.[0]?.message ?? {};
  const output = normalizeAssistantOutput(message.content_parts ?? message.content ?? "");
  const text = output.text || String(message.content ?? "");
  const toolCalls = openAIToolCallsToAnthropic(message.tool_calls);
  const content = [];
  const reasoningContent = String(message.reasoning_content ?? "");
  if (emitThinking && reasoningContent) {
    content.push({
      type: "thinking",
      thinking: reasoningContent,
      signature: message.reasoning_signature ?? dtokenThinkingSignature(reasoningContent, payload?.id),
    });
  }
  const textFallback = !emitThinking && !text && !output.parts.length ? reasoningContent : "";
  if (output.parts.length) {
    content.push(...(renderMessagesForProvider([{ role: "assistant", content: output.parts }], { format: "anthropic_messages" }).messages[0]?.content ?? []));
  } else if (text || textFallback) {
    content.push({ type: "text", text: text || textFallback });
  }
  content.push(...toolCalls);
  const out = {
    id: payload.id,
    type: "message",
    role: "assistant",
    model: payload.model,
    content: content.length ? content : [{ type: "text", text: "" }],
    stop_reason: toolCalls.length ? "tool_use" : mapAnthropicStopReason(payload.choices?.[0]?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: payload.usage?.prompt_tokens ?? 0,
      output_tokens: payload.usage?.completion_tokens ?? 0,
    },
    dtoken_gateway: gatewayAck(ackMeta),
  };
  if (exposeDTokenMetadata) out.dtoken = payload.dtoken;
  return out;
}

export function openAIToolCallsToAnthropic(toolCalls = []) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((call, index) => {
    const fn = call?.function ?? {};
    return {
      type: "tool_use",
      id: String(call?.id ?? `toolu_${index}`),
      name: String(fn.name ?? call?.name ?? "tool"),
      input: parseToolArguments(fn.arguments),
    };
  });
}

export function mapAnthropicStopReason(reason) {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  return "end_turn";
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

function gatewayAck(ackMeta) {
  return {
    acknowledged: true,
    credential_round: ackMeta.credentialRound,
    acknowledged_spent: ackMeta.cumulativeSpent,
    user_credential_signature: ackMeta.signature,
  };
}

export function dtokenThinkingSignature(text, id = "") {
  const payload = `${id || "dtoken"}:${String(text ?? "").length}:${String(text ?? "").slice(0, 128)}`;
  let hash = 0;
  for (let i = 0; i < payload.length; i++) {
    hash = ((hash << 5) - hash + payload.charCodeAt(i)) >>> 0;
  }
  return `dtoken-thought-${hash.toString(16).padStart(8, "0")}`;
}

function normalizeToken(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
