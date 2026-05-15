import { nowUnix, parseBearer, readJson, sendError, sendJson } from "../http.js";
import { forwardChatCompletion } from "../core/providerClient.js";
import { signAndSubmitUserCredential } from "../core/userCredential.js";
import {
  CLIENT_FORMATS,
  normalizeAgentRequest,
  normalizeClientFormat,
  shapeClientResponse,
  openAIToolCallsToAnthropic,
  mapAnthropicStopReason,
  dtokenThinkingSignature,
} from "../core/formatBridge.js";

const rateLimitCooldowns = new Map();
const MAX_RATE_LIMIT_RETRIES = 3;

export function handleModels({ profileStore, ledger, response }) {
  const profiles = profileStore.list();
  if (!profiles.length) {
    sendJson(response, 200, { object: "list", data: [] });
    return;
  }
  sendJson(response, 200, {
    object: "list",
    data: profiles.map((profile) => ({
      id: profile.dtoken.model,
      object: "model",
      created: nowUnix(),
      owned_by: "dtoken-user",
      context_length: profile.dtoken.contextLength ?? 0,
      capabilities: profile.dtoken.capabilities ?? [],
      input_modes: profile.dtoken.inputModes ?? ["text"],
      output_modes: profile.dtoken.outputModes ?? ["text"],
      dtoken_gateway: {
        phase: "phase2-format-bridge",
        endpoint: "local",
        handshake_id: profile.dtoken.handshakeId,
        client_format: profile.agent.clientFormat ?? CLIENT_FORMATS.OPENAI_CHAT,
        upstream_format: profile.dtoken.upstreamFormat ?? "openai_chat_completions",
        message_format: profile.dtoken.messageFormat ?? "dtoken.multimodal.v1",
        provider_family: profile.dtoken.providerFamily ?? "",
        context_length: profile.dtoken.contextLength ?? 0,
        input_modes: profile.dtoken.inputModes ?? ["text"],
        output_modes: profile.dtoken.outputModes ?? ["text"],
        input_token_price: profile.dtoken.inputTokenPrice ?? "0",
        output_token_price: profile.dtoken.outputTokenPrice ?? "0",
        multimodal_policy: profile.dtoken.multimodalPolicy ?? "strip_unsupported_media_with_text",
        agent_gateway_formats: profile.dtoken.agentGatewayFormats ?? ["openai_chat_completions", "openai_responses", "anthropic_messages"],
        cumulative_spent: ledger.handshakeSummary(profile.dtoken.handshakeId).cumulativeSpent,
        latest_receipt_round: ledger.handshakeSummary(profile.dtoken.handshakeId).latestReceiptRound,
      },
    })),
  });
}

export async function handleChatCompletions({
  config,
  profileStore,
  queue,
  ledger,
  request,
  response,
  clientFormat = CLIENT_FORMATS.OPENAI_CHAT,
}) {
  const profile = authenticateAgent(profileStore, request);
  if (!profile) {
    sendError(response, 401, "invalid_agent_key", "Invalid or missing local dToken Agent API key");
    return;
  }
  if (profile.agent.disabled) {
    sendError(response, 403, "profile_disabled", profile.agent.disabledReason
      ? `This dToken Agent Profile is disabled: ${profile.agent.disabledReason}`
      : "This dToken Agent Profile is disabled");
    return;
  }

  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    sendError(response, error.statusCode ?? 400, error.code ?? "invalid_request", error.message);
    return;
  }
  if (!body || typeof body !== "object") {
    sendError(response, 400, "invalid_request", "Request body must be valid JSON");
    return;
  }
  const effectiveClientFormat = normalizeClientFormat(clientFormat);
  try {
    body = normalizeAgentRequest({ body, clientFormat: effectiveClientFormat, profile });
  } catch (error) {
    sendError(response, 400, "invalid_request", error.message);
    return;
  }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    sendError(response, 400, "invalid_request", "messages must be a non-empty array");
    return;
  }
  body = forceProfileModel(body, profile);

  await queue.enqueue(profile.dtoken.handshakeId, async () => {
    if (budgetExceeded(profile, ledger)) {
      sendError(response, 402, "gateway_budget_exhausted",
        "The local Agent Gateway budget limit has been reached for this profile");
      return;
    }
    const preflight = budgetPreflight(profile, ledger, body);
    if (!preflight.ok) {
      ledger.record({
        ok: false,
        mode: body.stream === true ? "chat.completions.stream" : "chat.completions",
        handshakeId: profile.dtoken.handshakeId,
        model: profile.dtoken.model,
        error: preflight.message,
      });
      sendError(response, 402, preflight.code, preflight.message, preflight.extra);
      return;
    }
    if (body.stream === true) {
      await handleStreaming({ config, profileStore, profile, ledger, body, request, response, clientFormat: effectiveClientFormat });
    } else {
      await handleNonStreaming({ config, profileStore, profile, ledger, body, request, response, clientFormat: effectiveClientFormat });
    }
  });
}

function forceProfileModel(body, profile) {
  // Agent-facing model names are compatibility hints only. Claude Desktop,
  // OpenClaw, Hermes, and similar clients may require provider-shaped model
  // IDs that do not match the real dToken model. The local API key selects the
  // exact dToken profile, so the gateway always routes and meters by profile.
  return {
    ...body,
    requested_model: body.model ?? null,
    model: profile.dtoken.model,
  };
}

function budgetExceeded(profile, ledger) {
  const limit = profile.agent.budgetLimitDToken;
  if (limit == null || limit === "") return false;
  try {
    const current = maxBigInt(
      BigInt(ledger.handshakeSummary(profile.dtoken.handshakeId).cumulativeSpent ?? "0"),
      BigInt(profile.dtoken.startingCumulativeSpent ?? "0"),
    );
    const starting = BigInt(profile.dtoken.startingCumulativeSpent ?? "0");
    const spentInProfile = current > starting ? current - starting : 0n;
    return spentInProfile >= BigInt(String(limit));
  } catch {
    return false;
  }
}

function maxBigInt(a, b) {
  return a > b ? a : b;
}

function budgetPreflight(profile, ledger, body) {
  const prices = tokenPrices(profile, ledger);
  if (prices.input <= 0n && prices.output <= 0n) return { ok: true };
  const remaining = remainingBudget(profile, ledger);
  if (remaining == null) return { ok: true };
  if (remaining <= 0n) {
    return {
      ok: false,
      code: "gateway_budget_exhausted",
      message: "The dToken budget for this Agent Gateway profile has already been exhausted. Refresh the API key or bind a new handshake before continuing.",
      extra: { remaining: "0" },
    };
  }

  const inputTokens = estimateInputTokens(body);
  const outputReserve = estimateOutputReserve(body);
  const estimatedCost = (BigInt(inputTokens) * prices.input) + (BigInt(outputReserve) * prices.output);
  if (estimatedCost <= remaining) return { ok: true };
  if (!shouldHardBlockBudgetPreflight(profile)) return { ok: true };

  return {
    ok: false,
    code: "gateway_budget_too_small_for_request",
    message: `This agent request is likely to exceed the remaining dToken budget before it reaches the model. Estimated input ${inputTokens} tokens plus output reserve ${outputReserve} tokens costs about ${estimatedCost.toString()} raw dToken units, but only ${remaining.toString()} remain. Use a larger escrow, lower the agent context window, or reduce max output tokens.`,
    extra: {
      estimated_input_tokens: inputTokens,
      output_token_reserve: outputReserve,
      estimated_raw_cost: estimatedCost.toString(),
      remaining_raw_budget: remaining.toString(),
    },
  };
}

function tokenPrices(profile, ledger) {
  const summary = ledger.handshakeSummary(profile.dtoken.handshakeId);
  const receipt = summary.latestReceipt ?? {};
  const profileInput = parseBigIntLike(
    profile.dtoken.inputTokenPrice ??
    profile.dtoken.input_token_price ??
    profile.dtoken.runtime?.inputTokenPrice ??
    profile.dtoken.runtime?.input_token_price ??
    "0"
  );
  const profileOutput = parseBigIntLike(
    profile.dtoken.outputTokenPrice ??
    profile.dtoken.output_token_price ??
    profile.dtoken.runtime?.outputTokenPrice ??
    profile.dtoken.runtime?.output_token_price ??
    "0"
  );
  const receiptInput = parseBigIntLike(receipt.input_token_price ?? receipt.inputTokenPrice ?? "0");
  const receiptOutput = parseBigIntLike(receipt.output_token_price ?? receipt.outputTokenPrice ?? "0");
  return {
    input: receiptInput > 0n ? receiptInput : profileInput,
    output: receiptOutput > 0n ? receiptOutput : profileOutput,
  };
}

function shouldHardBlockBudgetPreflight(profile) {
  const value =
    profile?.agent?.strictBudgetPreflight ??
    profile?.agent?.strict_budget_preflight ??
    profile?.dtoken?.runtime?.strictBudgetPreflight ??
    profile?.dtoken?.runtime?.strict_budget_preflight ??
    false;
  return value === true || value === "true" || value === 1 || value === "1";
}

function remainingBudget(profile, ledger) {
  const current = currentCumulativeSpent(profile, ledger);
  const escrow = parseBigIntLike(profile.dtoken.escrowAmount);
  const remainingEscrow = escrow > current ? escrow - current : 0n;
  const limit = profile.agent.budgetLimitDToken;
  if (limit == null || limit === "") return remainingEscrow;
  const starting = parseBigIntLike(profile.dtoken.startingCumulativeSpent);
  const spentInProfile = current > starting ? current - starting : 0n;
  const rawLimit = parseBigIntLike(limit);
  const remainingLimit = rawLimit > spentInProfile ? rawLimit - spentInProfile : 0n;
  return remainingLimit < remainingEscrow ? remainingLimit : remainingEscrow;
}

function currentCumulativeSpent(profile, ledger) {
  return maxBigInt(
    parseBigIntLike(ledger.handshakeSummary(profile.dtoken.handshakeId).cumulativeSpent),
    parseBigIntLike(profile.dtoken.startingCumulativeSpent),
  );
}

function parseBigIntLike(value) {
  try {
    if (value == null || value === "") return 0n;
    return BigInt(String(value));
  } catch {
    return 0n;
  }
}

function estimateInputTokens(body) {
  const messages = body.messages ?? [];
  const tools = body.tools ?? [];
  const messagesChars = JSON.stringify(sanitizeForTokenEstimate(messages)).length;
  const toolsChars = JSON.stringify(sanitizeForTokenEstimate(tools)).length;
  const extraChars = JSON.stringify({
    tool_choice: body.tool_choice ?? null,
    response_format: body.response_format ?? null,
    stop: body.stop ?? null,
  }).length;
  const media = estimateMediaTokens(body.messages ?? []);
  return Math.max(1, Math.ceil((messagesChars + extraChars) / 3.4) + Math.ceil(toolsChars / 4.2) + media);
}

function sanitizeForTokenEstimate(value, key = "") {
  if (typeof value === "string") {
    const dataUrl = parseDataUrl(value);
    if (dataUrl) return `[media:${dataUrl.mime};${dataUrl.bytes} bytes]`;
    if (isLikelyEncodedMediaKey(key) && looksLikeEncodedBlob(value)) {
      return `[encoded-media:${value.length} chars]`;
    }
    return value;
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeForTokenEstimate(item, key));
  const out = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    out[childKey] = sanitizeForTokenEstimate(childValue, childKey);
  }
  return out;
}

function parseDataUrl(value) {
  const match = String(value).match(/^data:([^;,]+)(?:;[^,]*)?,([\s\S]*)$/i);
  if (!match) return null;
  const encoded = String(match[2] || "").replace(/\s/g, "");
  return {
    mime: match[1] || "application/octet-stream",
    bytes: Math.ceil((encoded.length * 3) / 4),
  };
}

function isLikelyEncodedMediaKey(key) {
  return /^(data|base64|image|image_data|audio|video|bytes|file_data)$/i.test(String(key || ""));
}

function looksLikeEncodedBlob(value) {
  if (value.length < 1200) return false;
  const sample = value.slice(0, 1200);
  return /^[A-Za-z0-9+/=_-]+$/.test(sample);
}

function estimateOutputReserve(body) {
  const raw = body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens;
  const value = Number(raw);
  if (Number.isFinite(value) && value > 0) return Math.ceil(value);
  return 4096;
}

function estimateMediaTokens(messages) {
  let total = 0;
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const type = String(value.type ?? "").toLowerCase();
    if (type === "image" || type === "image_url") total += 768;
    else if (type === "video") total += 1800;
    else if (type === "audio") total += 1200;
    else if (type === "file") total += 1000;
    for (const item of Object.values(value)) walk(item);
  };
  walk(messages);
  return total;
}

async function forwardWithRateLimitRetry(profile, body, { stream, clientFormat }) {
  const key = rateLimitKey(profile);
  let last = null;
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    await waitForRateLimitCooldown(key);
    const upstream = await forwardChatCompletion(profile, body, { stream, clientFormat });
    const contentType = upstream.headers.get("content-type") || "";
    if (stream && contentType.includes("text/event-stream")) {
      return { upstream, payload: null };
    }

    const payload = await upstream.json().catch(() => null);
    last = { upstream, payload };
    const retryMs = retryAfterMs(upstream, payload);
    if (!retryMs || attempt >= MAX_RATE_LIMIT_RETRIES) return last;

    const waitMs = setRateLimitCooldown(key, retryMs);
    await sleep(waitMs);
  }
  return last;
}

function rateLimitKey(profile) {
  return [
    profile?.dtoken?.endpoint || "",
    profile?.dtoken?.model || "",
    profile?.dtoken?.apiKey ? profile.dtoken.apiKey.slice(-8) : "",
  ].join("|");
}

async function waitForRateLimitCooldown(key) {
  const until = Number(rateLimitCooldowns.get(key) || 0);
  const waitMs = until - Date.now();
  if (waitMs > 0) await sleep(waitMs);
}

function setRateLimitCooldown(key, retryMs) {
  const waitMs = Math.min(Math.max(Number(retryMs) || 0, 1000), 70000);
  rateLimitCooldowns.set(key, Date.now() + waitMs);
  return waitMs;
}

function retryAfterMs(upstream, payload) {
  const message = String(payload?.error?.message || payload?.message || "");
  const status = Number(upstream?.status || 0);
  const looksLimited = status === 429 ||
    /rate\s*limit|tokens\/min|too many requests|retry after/i.test(message);
  if (!looksLimited) return 0;

  const header = upstream?.headers?.get?.("retry-after");
  const headerSeconds = Number(header);
  if (Number.isFinite(headerSeconds) && headerSeconds > 0) return Math.ceil(headerSeconds * 1000) + 750;

  const ms = Number(payload?.error?.retry_after_ms ?? payload?.retry_after_ms);
  if (Number.isFinite(ms) && ms > 0) return ms + 750;

  const seconds = Number(payload?.error?.retry_after ?? payload?.retry_after);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000) + 750;

  const m = message.match(/retry\s*after\s*(\d+(?:\.\d+)?)\s*s/i) ||
    message.match(/retry\s*after\s*(\d+(?:\.\d+)?)\s*seconds?/i);
  if (m) return Math.ceil(Number(m[1]) * 1000) + 750;

  return 5000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function handleNonStreaming({ config, profileStore, profile, ledger, body, request, response, clientFormat }) {
  let upstream;
  let upstreamPayload;
  try {
    const result = await forwardWithRateLimitRetry(profile, body, { stream: false, clientFormat });
    upstream = result.upstream;
    upstreamPayload = result.payload;
  } catch (error) {
    ledger.record({ ok: false, mode: "chat.completions", handshakeId: profile.dtoken.handshakeId, model: profile.dtoken.model, error: error.message });
    sendError(response, 502, "provider_unreachable", error.message);
    return;
  }
  const payload = upstreamPayload ?? await upstream.json().catch(() => null);
  if (!upstream.ok || payload?.error) {
    const err = payload?.error ?? {};
    ledger.record({ ok: false, mode: "chat.completions", handshakeId: profile.dtoken.handshakeId, model: profile.dtoken.model, error: err.message || `HTTP ${upstream.status}` });
    disableTerminalProfile(profileStore, profile, err);
    sendJson(response, upstream.status || 502, payload ?? {
      error: { type: "provider_error", code: "provider_error", message: `Provider returned HTTP ${upstream.status}` },
    });
    return;
  }

  const ackMeta = await acknowledgeAndRecord({ profile, ledger, dtoken: payload.dtoken, mode: "chat.completions" });
  sendJson(response, 200, shapeAgentResponse(payload, ackMeta, shouldExposeDTokenMetadata(config, request), clientFormat));
}

async function handleStreaming({ config, profileStore, profile, ledger, body, request, response, clientFormat }) {
  let upstream;
  let upstreamPayload;
  let streamStarted = false;
  let anthropicStarted = false;
  let heartbeat = null;
  const ensureStreamStarted = () => {
    if (streamStarted) return;
    startSse(response);
    streamStarted = true;
    anthropicStarted = clientFormat === CLIENT_FORMATS.ANTHROPIC_MESSAGES;
    if (anthropicStarted) {
      writeAnthropicMessageStart(response, {
        id: `msg_dtoken_${Date.now()}`,
        model: profile.dtoken.model,
        inputTokens: 0,
      });
    }
    heartbeat = startStreamingHeartbeat(response, clientFormat);
  };

  try {
    const result = await forwardWithRateLimitRetry(profile, body, { stream: true, clientFormat });
    upstream = result.upstream;
    upstreamPayload = result.payload;
  } catch (error) {
    ledger.record({ ok: false, mode: "chat.completions.stream", handshakeId: profile.dtoken.handshakeId, model: profile.dtoken.model, error: error.message });
    if (streamStarted) {
      stopStreamingHeartbeat(heartbeat);
      writeClientStreamError(response, clientFormat, { error: { type: "provider_unreachable", code: "provider_unreachable", message: error.message } });
      response.write("data: [DONE]\n\n");
      response.end();
      return;
    }
    sendError(response, 502, "provider_unreachable", error.message);
    return;
  }

  const contentType = upstream.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    const payload = upstreamPayload ?? await upstream.json().catch(() => null);
    ledger.record({ ok: false, mode: "chat.completions.stream", handshakeId: profile.dtoken.handshakeId, model: profile.dtoken.model, error: payload?.error?.message || `HTTP ${upstream.status}` });
    if (streamStarted) {
      stopStreamingHeartbeat(heartbeat);
      writeClientStreamError(response, clientFormat, payload ?? {
        error: { type: "provider_error", code: "provider_error", message: `Provider returned HTTP ${upstream.status}` },
      });
      response.write("data: [DONE]\n\n");
      response.end();
      return;
    }
    sendJson(response, upstream.status || 502, payload ?? {
      error: { type: "provider_error", code: "provider_error", message: `Provider returned HTTP ${upstream.status}` },
    });
    return;
  }

  ensureStreamStarted();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalDToken = null;
  let providerError = null;
  const bufferedFrames = [];
  const liveOpenAIChat = clientFormat === CLIENT_FORMATS.OPENAI_CHAT;
  const liveAnthropic = clientFormat === CLIENT_FORMATS.ANTHROPIC_MESSAGES;
  const anthropicLive = liveAnthropic ? createAnthropicLiveState(response) : null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\n\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const event = parseSseEvent(part);
        if (!event) continue;
        if (event.data === "[DONE]") continue;
        if (event.event === "dtoken") {
          finalDToken = JSON.parse(event.data);
          continue;
        }
        if (event.event === "error") {
          providerError = safeJson(event.data);
          continue;
        }
        if (liveOpenAIChat) writeRawSse(response, event.raw);
        else {
          bufferedFrames.push(event.raw);
          if (liveAnthropic) writeLiveAnthropicFromOpenAI(anthropicLive, event.raw);
        }
      }
    }

    if (buffer.trim()) {
      const event = parseSseEvent(buffer);
      if (event?.event === "dtoken") finalDToken = JSON.parse(event.data);
      else if (event?.event === "error") providerError = safeJson(event.data);
      else if (event?.data && event.data !== "[DONE]") {
        if (liveOpenAIChat) writeRawSse(response, event.raw);
        else {
          bufferedFrames.push(event.raw);
          if (liveAnthropic) writeLiveAnthropicFromOpenAI(anthropicLive, event.raw);
        }
      }
    }

    if (providerError) {
      stopStreamingHeartbeat(heartbeat);
      ledger.record({ ok: false, mode: "chat.completions.stream", handshakeId: profile.dtoken.handshakeId, model: profile.dtoken.model, error: providerError?.error?.message || "provider stream error" });
      disableTerminalProfile(profileStore, profile, providerError?.error ?? providerError);
      writeClientStreamError(response, clientFormat, providerError);
    } else {
      const ackMeta = await acknowledgeAndRecord({ profile, ledger, dtoken: finalDToken?.dtoken, mode: "chat.completions.stream" });
      stopStreamingHeartbeat(heartbeat);
      if (clientFormat === CLIENT_FORMATS.ANTHROPIC_MESSAGES) {
        if (liveAnthropic) finalizeLiveAnthropicStream(anthropicLive, { frames: bufferedFrames, finalPayload: finalDToken });
        else replayBufferedAnthropicStream(response, { frames: bufferedFrames, finalPayload: finalDToken, includeStart: !anthropicStarted });
        response.end();
        return;
      }
      if (clientFormat === CLIENT_FORMATS.OPENAI_RESPONSES) {
        replayBufferedResponsesStream(response, {
          frames: bufferedFrames,
          finalPayload: finalDToken,
          ackMeta,
          exposeDTokenMetadata: shouldExposeDTokenMetadata(config, request),
        });
        response.write("data: [DONE]\n\n");
        response.end();
        return;
      }
      if (!liveOpenAIChat) {
        for (const frame of bufferedFrames) writeRawSse(response, frame);
      }
      if (shouldExposeDTokenMetadata(config, request)) {
        writeSse(response, "dtoken", shapeAgentResponse(finalDToken, ackMeta, true, clientFormat));
      }
    }
    response.write("data: [DONE]\n\n");
    response.end();
  } catch (error) {
    stopStreamingHeartbeat(heartbeat);
    ledger.record({ ok: false, mode: "chat.completions.stream", handshakeId: profile.dtoken.handshakeId, model: profile.dtoken.model, error: error.message });
    writeClientStreamError(response, clientFormat, { error: { type: error.code || "gateway_error", code: error.code || "gateway_error", message: error.message } });
    response.write("data: [DONE]\n\n");
    response.end();
  }
}

async function acknowledgeAndRecord({ profile, ledger, dtoken, mode }) {
  if (!dtoken?.credential) {
    const error = new Error("Provider response did not include dToken settlement metadata");
    error.code = "dtoken_missing";
    throw error;
  }
  const credentialMeta = await signAndSubmitUserCredential(profile, dtoken);
  ledger.record({
    ok: true,
    mode,
    model: profile.dtoken.model,
    handshakeId: profile.dtoken.handshakeId,
    credentialRound: dtoken.credential.round,
    credentialHash: dtoken.credential.credential_hash,
    credential: dtoken.credential,
    userCredentialSignature: credentialMeta.signature,
    receiptRound: dtoken.credential.round,
    receiptHash: dtoken.credential.credential_hash,
    roundCost: dtoken.round_cost,
    cumulativeSpent: dtoken.cumulative_spent,
    remaining: dtoken.remaining,
    acknowledgedSpent: credentialMeta.credential.cumulative_spent,
  });
  return credentialMeta;
}

function disableTerminalProfile(profileStore, profile, error) {
  const code = String(error?.code ?? error?.type ?? "").toLowerCase();
  const message = String(error?.message ?? "");
  if (!isTerminalDTokenError(code, message)) return;
  profileStore.disable?.(profile.dtoken.handshakeId, message || code);
}

function isTerminalDTokenError(code, message) {
  return [
    "invalid_api_key",
    "insufficient_budget",
    "gateway_budget_exhausted",
    "session_stopped",
    "session_closed",
    "handshake_closed",
    "handshake_settled",
  ].includes(code) || /exceeded the dToken escrow budget|session has been stopped|invalid or missing dToken API key/i.test(message);
}

function authenticateAgent(profileStore, request) {
  const token = parseBearer(request.headers.authorization) || String(request.headers["x-api-key"] ?? "").trim();
  return token ? profileStore.getByApiKey(token) : null;
}

function shapeAgentResponse(payload, ackMeta, exposeDTokenMetadata, clientFormat) {
  return shapeClientResponse({ payload, ackMeta, exposeDTokenMetadata, clientFormat });
}

function shouldExposeDTokenMetadata(config, request) {
  if (config.gateway.exposeDTokenMetadata) return true;
  const header = String(request.headers["x-dtoken-expose-metadata"] ?? "").toLowerCase();
  return header === "true" || header === "1" || header === "yes";
}

function startSse(response) {
  response.socket?.setNoDelay?.(true);
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version, X-dToken-Expose-Metadata",
  });
  response.flushHeaders?.();
  response.write(": dtoken-user-gateway\n\n");
}

function startStreamingHeartbeat(response, clientFormat) {
  const timer = setInterval(() => {
    if (response.writableEnded || response.destroyed) {
      stopStreamingHeartbeat(timer);
      return;
    }
    try {
      if (clientFormat === CLIENT_FORMATS.ANTHROPIC_MESSAGES) {
        writeSse(response, "ping", { type: "ping" });
      } else {
        response.write(": dtoken-user-gateway-keepalive\n\n");
      }
    } catch {
      stopStreamingHeartbeat(timer);
    }
  }, 5000);
  timer.unref?.();
  return timer;
}

function stopStreamingHeartbeat(timer) {
  if (timer) clearInterval(timer);
}

function writeSse(response, event, data) {
  if (event) response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeClientStreamError(response, clientFormat, payload) {
  const error = payload?.error ?? payload ?? {};
  const type = String(error.type ?? error.code ?? "gateway_error");
  const message = String(error.message ?? "Gateway stream error");
  if (clientFormat === CLIENT_FORMATS.ANTHROPIC_MESSAGES) {
    writeAnthropicTextAndStop(response, `dToken Gateway error (${type}): ${message}`);
    return;
  }
  writeSse(response, "error", {
    error: {
      type,
      code: error.code ?? type,
      message,
    },
  });
}

function writeAnthropicTextAndStop(response, text) {
  writeSse(response, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  writeSse(response, "content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  });
  writeSse(response, "content_block_stop", { type: "content_block_stop", index: 0 });
  writeSse(response, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 0 },
  });
  writeSse(response, "message_stop", { type: "message_stop" });
}

function writeRawSse(response, raw) {
  response.write(raw.endsWith("\n\n") ? raw : `${raw}\n\n`);
}

function replayBufferedResponsesStream(response, { frames, finalPayload, ackMeta, exposeDTokenMetadata }) {
  const collected = collectOpenAIStream(frames, finalPayload);
  const responsePayload = shapeAgentResponse(finalPayload, ackMeta, exposeDTokenMetadata, CLIENT_FORMATS.OPENAI_RESPONSES);
  const id = responsePayload.id ?? collected.id ?? `resp_${Date.now()}`;
  const created = responsePayload.created_at ?? Math.floor(Date.now() / 1000);
  const model = responsePayload.model ?? finalPayload?.model ?? collected.model ?? "dtoken";
  writeSse(response, "response.created", {
    type: "response.created",
    response: {
      id,
      object: "response",
      created_at: created,
      model,
      status: "in_progress",
      output: [],
      usage: null,
    },
  });

  if (collected.reasoning) {
    writeSse(response, "response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      response_id: id,
      output_index: 0,
      delta: collected.reasoning,
    });
  }

  if (collected.text) {
    writeSse(response, "response.output_text.delta", {
      type: "response.output_text.delta",
      response_id: id,
      output_index: 0,
      content_index: 0,
      delta: collected.text,
    });
  }

  for (const [outputIndex, call] of (responsePayload.output ?? []).entries()) {
    if (call?.type !== "function_call") continue;
    writeSse(response, "response.output_item.added", {
      type: "response.output_item.added",
      response_id: id,
      output_index: outputIndex,
      item: call,
    });
    writeSse(response, "response.output_item.done", {
      type: "response.output_item.done",
      response_id: id,
      output_index: outputIndex,
      item: call,
    });
  }

  writeSse(response, "response.completed", {
    type: "response.completed",
    response: responsePayload,
  });
}

function replayBufferedAnthropicStream(response, { frames, finalPayload, includeStart = true }) {
  const collected = collectOpenAIStream(frames, finalPayload);
  const id = collected.id || `msg_${Date.now()}`;
  const model = finalPayload?.model || collected.model || "dtoken";
  const inputTokens = finalPayload?.usage?.prompt_tokens ?? 0;
  const outputTokens = finalPayload?.usage?.completion_tokens ?? 0;
  let index = 0;

  if (includeStart) writeAnthropicMessageStart(response, { id, model, inputTokens });

  if (collected.reasoning) {
    writeSse(response, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "" },
    });
    writeSse(response, "content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "thinking_delta", thinking: collected.reasoning },
    });
    writeSse(response, "content_block_delta", {
      type: "content_block_delta",
      index,
      delta: {
        type: "signature_delta",
        signature: collected.reasoningSignature || dtokenThinkingSignature(collected.reasoning, id),
      },
    });
    writeSse(response, "content_block_stop", { type: "content_block_stop", index });
    index++;
  }

  if (collected.text) {
    writeSse(response, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    });
    writeSse(response, "content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text: collected.text },
    });
    writeSse(response, "content_block_stop", { type: "content_block_stop", index });
    index++;
  }

  for (const block of openAIToolCallsToAnthropic(collected.toolCalls)) {
    writeSse(response, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
    });
    writeSse(response, "content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
    });
    writeSse(response, "content_block_stop", { type: "content_block_stop", index });
    index++;
  }

  writeSse(response, "message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: collected.toolCalls.length ? "tool_use" : mapAnthropicStopReason(collected.finishReason),
      stop_sequence: null,
    },
    usage: { output_tokens: outputTokens },
  });
  writeSse(response, "message_stop", { type: "message_stop" });
}

function createAnthropicLiveState(response) {
  return {
    response,
    index: 0,
    openBlock: null,
    reasoning: "",
    textStarted: false,
    reasoningStarted: false,
    toolCalls: [],
    finishReason: "stop",
  };
}

function writeLiveAnthropicFromOpenAI(state, frame) {
  if (!state) return;
  const event = parseSseEvent(frame);
  if (!event?.data || event.data === "[DONE]") return;
  const chunk = safeJson(event.data);
  const choice = chunk.choices?.[0] ?? {};
  if (choice.finish_reason) state.finishReason = choice.finish_reason;
  const delta = choice.delta ?? {};
  const reasoningDelta = delta.reasoning_content ?? delta.reasoning;

  if (typeof reasoningDelta === "string" && reasoningDelta) {
    if (!state.reasoningStarted) {
      writeSse(state.response, "content_block_start", {
        type: "content_block_start",
        index: state.index,
        content_block: { type: "thinking", thinking: "" },
      });
      state.openBlock = "thinking";
      state.reasoningStarted = true;
    }
    state.reasoning += reasoningDelta;
    writeSse(state.response, "content_block_delta", {
      type: "content_block_delta",
      index: state.index,
      delta: { type: "thinking_delta", thinking: reasoningDelta },
    });
  }

  if (typeof delta.content === "string" && delta.content) {
    closeLiveAnthropicThinking(state);
    if (!state.textStarted) {
      writeSse(state.response, "content_block_start", {
        type: "content_block_start",
        index: state.index,
        content_block: { type: "text", text: "" },
      });
      state.openBlock = "text";
      state.textStarted = true;
    }
    writeSse(state.response, "content_block_delta", {
      type: "content_block_delta",
      index: state.index,
      delta: { type: "text_delta", text: delta.content },
    });
  }

  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
    mergeToolCallDeltas(state.toolCalls, delta.tool_calls);
  }
}

function closeLiveAnthropicThinking(state) {
  if (!state || state.openBlock !== "thinking") return;
  writeSse(state.response, "content_block_delta", {
    type: "content_block_delta",
    index: state.index,
    delta: {
      type: "signature_delta",
      signature: dtokenThinkingSignature(state.reasoning || "dtoken-thinking", `idx_${state.index}`),
    },
  });
  writeSse(state.response, "content_block_stop", { type: "content_block_stop", index: state.index });
  state.index++;
  state.openBlock = null;
}

function closeLiveAnthropicText(state) {
  if (!state || state.openBlock !== "text") return;
  writeSse(state.response, "content_block_stop", { type: "content_block_stop", index: state.index });
  state.index++;
  state.openBlock = null;
}

function finalizeLiveAnthropicStream(state, { frames, finalPayload }) {
  if (!state) return;
  const collected = collectOpenAIStream(frames, finalPayload);
  closeLiveAnthropicThinking(state);
  closeLiveAnthropicText(state);

  if (!state.reasoningStarted && collected.reasoning) {
    writeSse(state.response, "content_block_start", {
      type: "content_block_start",
      index: state.index,
      content_block: { type: "thinking", thinking: "" },
    });
    writeSse(state.response, "content_block_delta", {
      type: "content_block_delta",
      index: state.index,
      delta: { type: "thinking_delta", thinking: collected.reasoning },
    });
    writeSse(state.response, "content_block_delta", {
      type: "content_block_delta",
      index: state.index,
      delta: {
        type: "signature_delta",
        signature: collected.reasoningSignature || dtokenThinkingSignature(collected.reasoning, collected.id || `idx_${state.index}`),
      },
    });
    writeSse(state.response, "content_block_stop", { type: "content_block_stop", index: state.index });
    state.index++;
  }

  if (!state.textStarted && collected.text) {
    writeSse(state.response, "content_block_start", {
      type: "content_block_start",
      index: state.index,
      content_block: { type: "text", text: "" },
    });
    writeSse(state.response, "content_block_delta", {
      type: "content_block_delta",
      index: state.index,
      delta: { type: "text_delta", text: collected.text },
    });
    writeSse(state.response, "content_block_stop", { type: "content_block_stop", index: state.index });
    state.index++;
  }

  const toolCalls = collected.toolCalls.length ? collected.toolCalls : state.toolCalls;
  for (const block of openAIToolCallsToAnthropic(toolCalls)) {
    writeSse(state.response, "content_block_start", {
      type: "content_block_start",
      index: state.index,
      content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
    });
    writeSse(state.response, "content_block_delta", {
      type: "content_block_delta",
      index: state.index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
    });
    writeSse(state.response, "content_block_stop", { type: "content_block_stop", index: state.index });
    state.index++;
  }

  writeSse(state.response, "message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: toolCalls.length ? "tool_use" : mapAnthropicStopReason(collected.finishReason || state.finishReason),
      stop_sequence: null,
    },
    usage: { output_tokens: finalPayload?.usage?.completion_tokens ?? 0 },
  });
  writeSse(state.response, "message_stop", { type: "message_stop" });
}

function writeAnthropicMessageStart(response, { id, model, inputTokens = 0 }) {
  writeSse(response, "message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });
}

function collectOpenAIStream(frames, finalPayload) {
  const out = {
    id: finalPayload?.id ?? "",
    model: finalPayload?.model ?? "",
    text: "",
    reasoning: "",
    reasoningSignature: finalPayload?.choices?.[0]?.message?.reasoning_signature ?? "",
    finishReason: finalPayload?.choices?.[0]?.finish_reason ?? "stop",
    toolCalls: [],
  };
  for (const frame of frames ?? []) {
    const event = parseSseEvent(frame);
    if (!event?.data || event.data === "[DONE]") continue;
    const chunk = safeJson(event.data);
    if (chunk.id) out.id = chunk.id;
    if (chunk.model) out.model = chunk.model;
    const choice = chunk.choices?.[0] ?? {};
    if (choice.finish_reason) out.finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoningDelta === "string" && reasoningDelta) out.reasoning += reasoningDelta;
    if (delta.content) out.text += delta.content;
    if (Array.isArray(delta.tool_calls)) mergeToolCallDeltas(out.toolCalls, delta.tool_calls);
  }
  const finalMessage = finalPayload?.choices?.[0]?.message ?? {};
  if (!out.text && typeof finalMessage.content === "string") out.text = finalMessage.content;
  if (!out.reasoning && typeof finalMessage.reasoning_content === "string") out.reasoning = finalMessage.reasoning_content;
  if (!out.reasoningSignature && typeof finalMessage.reasoning_signature === "string") out.reasoningSignature = finalMessage.reasoning_signature;
  if (!out.toolCalls.length && Array.isArray(finalMessage.tool_calls)) out.toolCalls = finalMessage.tool_calls;
  return out;
}

function mergeToolCallDeltas(target, deltas) {
  for (const delta of deltas ?? []) {
    const index = Number.isInteger(delta.index) ? delta.index : target.length;
    if (!target[index]) target[index] = { id: "", type: "function", function: { name: "", arguments: "" } };
    const current = target[index];
    if (delta.id) current.id = delta.id;
    if (delta.type) current.type = delta.type;
    const fn = delta.function ?? {};
    current.function = current.function ?? { name: "", arguments: "" };
    if (fn.name) current.function.name += fn.name;
    if (fn.arguments) current.function.arguments += fn.arguments;
  }
}

function parseSseEvent(raw) {
  const lines = raw.split(/\r?\n/);
  let event = "";
  const data = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  return { event, data: data.join("\n"), raw: raw.endsWith("\n\n") ? raw : `${raw}\n\n` };
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return { error: { type: "provider_error", code: "provider_error", message: String(value) } };
  }
}
