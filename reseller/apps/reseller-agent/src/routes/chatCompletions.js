/**
 * POST /v1/chat/completions — 核心请求处理流水线
 *
 * 完整流程：
 * 1. 鉴权
 * 2. 参数校验 + 模型路由解析
 * 3. 预算预检查
 * 4. 速率限制检查
 * 5. 上游转发
 * 6. 计费（基于上游真实 usage）
 * 7. 预算后检查
 * 8. 生成等待 User 签名的 dToken credential + Hash Chain
 * 9. User 签名后才成为唯一可结算凭证
 * 10. 更新状态
 * 11. 返回响应
 */

import { readJson, sendError, sendJson, maskKey } from "../http.js";
import { calculateRoundCost, checkBudget, estimateMinimumRoundCost } from "../services/billing.js";
import {
  createUserCredential,
  hashMeteringEvidence,
  ZERO_HASH,
} from "../services/credentials.js";
import { providerSettleWithLatestCredential } from "../services/settlement.js";
import { prepareMessagesForModel } from "../services/messageCapabilities.js";
import { ethers } from "ethers";

export async function handleChatCompletions({
  config,
  keyStore,
  upstreamRouter,
  contractClient,
  rateLimiter,
  ledger,
  persistSessions,
  request,
  response,
}) {
  // ========== 1. 鉴权 ==========
  const session = keyStore.authenticate(request.headers.authorization);
  if (!session) {
    sendError(response, 401, "invalid_api_key", "Invalid or missing dToken API key");
    return;
  }
  if (!session.active) {
    sendError(response, 403, "session_closed", "This dToken session has been closed");
    return;
  }

  // ========== 2. 读请求体 + 参数校验 ==========
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

  const streaming = body.stream === true;

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    sendError(response, 400, "invalid_request", "messages must be a non-empty array");
    return;
  }

  const requestedModel = typeof body.model === "string" ? body.model.trim() : "";
  if (!requestedModel) {
    sendError(response, 400, "model_required", "model is required");
    return;
  }

  const isDTokenHandshakeSession = !!session.handshakeId && session.handshakeId !== "demo_handshake";
  if (isDTokenHandshakeSession && !session.modelScope) {
    sendError(response, 403, "unscoped_model_session",
      "This dToken API key is not bound to a model. Re-request the API key for this handshake.");
    return;
  }

  if (session.modelScope && session.modelScope !== requestedModel) {
    sendError(response, 403, "model_not_allowed",
      `Model "${requestedModel}" is not in your allowed scope. Allowed: ${session.modelScope}`);
    return;
  }

  // The upstream route is derived from the locked session scope whenever present.
  // The user-supplied body.model is only accepted if it exactly matches that scope.
  const effectiveModel = session.modelScope ?? requestedModel;

  // ========== 3. 模型路由 ==========
  const route = upstreamRouter.resolveModel(effectiveModel);
  if (!route) {
    sendError(response, 404, "model_not_found",
      `Model "${effectiveModel}" is not available. Use GET /v1/models to list available models.`);
    return;
  }

  const messagePlan = prepareMessagesForModel(body.messages, route);
  if (!messagePlan.ok) {
    sendError(response, messagePlan.statusCode ?? 400, messagePlan.code ?? "unsupported_message_content", messagePlan.message);
    return;
  }
  const forwardedMessages = messagePlan.messages;
  const extraParams = extractExtraParams(body);
  const requestMaxTokens = body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens
    ?? defaultMaxTokensForRoute(route, messagePlan);

  // ========== 3.5 同步链上 handshake 状态（mainnet 模式） ==========
  let chainState = null;
  if (contractClient.mode === "mainnet" && session.handshakeId) {
    try {
      chainState = await contractClient.getHandshake(session.handshakeId);
      if (!chainState.isOpen) {
        keyStore.deactivateSession(session.apiKey);
        persistSessions?.();
        sendError(response, 403, "session_closed",
          `Handshake is ${chainState.statusName} on chain`);
        return;
      }
      keyStore.syncSessionFromChain(session, chainState);
    } catch (error) {
      sendError(response, 502, "chain_sync_failed",
        `Could not verify on-chain dToken state: ${error.message}`);
      return;
    }
  }

  if (BigInt(session.cumulativeSpent ?? "0") > BigInt(session.credentialChain?.lastConfirmedCumulativeSpent ?? "0")) {
    sendError(response, 409, "previous_user_credential_missing",
      "Previous dToken credential has not been signed by the user; service is paused to protect the hash chain.");
    return;
  }

  // ========== 4. 预算预检查 ==========
  const minCost = estimateMinimumRoundCost(route.pricing.inputTokenPrice);
  if (session.cumulativeSpent + minCost > session.escrowAmount) {
    const settlement = await settleExhaustedSession({ contractClient, keyStore, session, persistSessions });
    sendError(response, 402, "insufficient_budget",
      `Insufficient dToken budget. Remaining: ${(session.escrowAmount - session.cumulativeSpent).toString()}, estimated min cost: ${minCost.toString()}. ${settlementMessage(settlement)}`);
    return;
  }

  // ========== 5. 速率限制 ==========
  if (rateLimiter) {
    const estimatedTokens = 10; // 预估值，后续用实际值修正
    if (!rateLimiter.check(session.apiKey, route.rateLimit, estimatedTokens, response)) {
      return;
    }
  }

  // ========== 6. 上游转发 ==========
  const startTime = Date.now();
  let upstreamResponse;
  const streamReplayEvents = [];
  try {
    if (streaming) {
      startSse(response);
      const pushLiveStreamDelta = (event) => {
        streamReplayEvents.push(event);
        if (!response.writableEnded && !response.destroyed) {
          writeOpenAIStreamDelta(response, {
            id: event.id,
            created: event.created,
            model: effectiveModel,
            delta: event.delta,
          });
        }
      };
      upstreamResponse = await upstreamRouter.forwardStream(route.upstreamId, {
        upstreamModel: route.upstreamModel,
        messages: forwardedMessages,
        maxTokens: requestMaxTokens,
        temperature: body.temperature,
        extra: extraParams,
        onDelta: (content, chunk) => pushLiveStreamDelta({
          delta: { content },
          id: chunk.id,
          created: chunk.created,
        }),
        onReasoningDelta: (reasoningContent, chunk) => pushLiveStreamDelta({
          delta: { reasoning_content: reasoningContent },
          id: chunk.id,
          created: chunk.created,
        }),
        onToolCallDelta: (toolCalls, chunk) => pushLiveStreamDelta({
          delta: { tool_calls: toolCalls },
          id: chunk.id,
          created: chunk.created,
        }),
      });
    } else {
      upstreamResponse = await upstreamRouter.forward(route.upstreamId, {
        upstreamModel: route.upstreamModel,
        messages: forwardedMessages,
        maxTokens: requestMaxTokens,
        temperature: body.temperature,
        extra: extraParams,
      });
    }
  } catch (error) {
    const statusCode = error.statusCode ?? 502;
    if (streaming) streamError(response, error.code ?? "upstream_error", error.message);
    else sendError(response, statusCode, error.code ?? "upstream_error", error.message);
    return;
  }
  const upstreamLatencyMs = Date.now() - startTime;
  const usage = upstreamResponse.usage;

  if (!hasStrictUsage(usage)) {
    if (streaming) streamError(response, "usage_missing",
      "Upstream response did not include measurable token usage; dToken credential cannot be produced");
    else sendError(response, 502, "usage_missing",
      "Upstream response did not include measurable token usage; dToken credential cannot be produced");
    return;
  }

  // 用上游返回的真实 token 数修正速率限制追踪
  if (rateLimiter) {
    rateLimiter.recordTokens(session.apiKey, usage.totalTokens);
  }

  // ========== 7. 计费 ==========
  const { roundCost, cumulativeSpent } = calculateRoundCost({
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    inputTokenPrice: route.pricing.inputTokenPrice,
    outputTokenPrice: route.pricing.outputTokenPrice,
    currentCumulativeSpent: session.cumulativeSpent,
  });

  // ========== 8. 预算后检查 ==========
  const budgetResult = checkBudget(cumulativeSpent, session.escrowAmount);
  if (!budgetResult.sufficient) {
    const settlement = await settleExhaustedSession({ contractClient, keyStore, session, persistSessions });
    if (streaming) streamError(response, "insufficient_budget",
      `This request exceeded the dToken escrow budget; the session has been stopped at the latest user-signed credential. ${settlementMessage(settlement)}`);
    else sendError(response, 402, "insufficient_budget",
      `This request exceeded the dToken escrow budget; the session has been stopped at the latest user-signed credential. ${settlementMessage(settlement)}`);
    return;
  }
  const remaining = budgetResult.remaining;

  // ========== 9. 生成等待 User 签名的 dToken credential ==========
  const previousHash = session.credentialChain.latestCredentialHash || ZERO_HASH;
  const credentialRound = Number(session.latestCredentialRound ?? session.credentialChain.latestCredentialRound ?? 0) + 1;
  const requestHash = hashMeteringEvidence({
    type: "openai-chat-request",
    model: effectiveModel,
    upstream_model: route.upstreamModel,
    messages: normalizeMessagesForHash(forwardedMessages),
    params: {
      max_tokens: requestMaxTokens ?? null,
      temperature: body.temperature ?? null,
      extra: extraParams,
    },
    message_handling: messageHandlingForMetering(messagePlan),
  });
  const responseHash = hashMeteringEvidence({
    type: "openai-chat-response",
    id: upstreamResponse.id,
    model: upstreamResponse.model,
    choices: upstreamResponse.choices,
    usage: usageForMetering(usage),
  });
  const meteringEvidence = {
    type: "dtoken-metering-v1",
    handshake_id: session.handshakeId,
    round: credentialRound,
    model: effectiveModel,
    upstream_id: route.upstreamId,
    upstream_model: route.upstreamModel,
    upstream_request_id: upstreamResponse.id,
    request_hash: requestHash,
    response_hash: responseHash,
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
    raw_completion_tokens: usage.rawCompletionTokens,
    reasoning_tokens: usage.reasoningTokens,
    hidden_output_tokens: usage.hiddenOutputTokens,
    prompt_cache_hit_tokens: usage.promptCacheHitTokens,
    prompt_cache_miss_tokens: usage.promptCacheMissTokens,
    billable_output_source: usage.billableOutputSource,
    multimodal_input: multimodalInputForMetering(messagePlan),
    message_handling: messageHandlingForMetering(messagePlan),
    input_token_price: route.pricing.inputTokenPrice.toString(),
    output_token_price: route.pricing.outputTokenPrice.toString(),
    round_cost: roundCost.toString(),
    cumulative_spent: cumulativeSpent.toString(),
    previous_credential_hash: previousHash,
  };
  const meteringHash = hashMeteringEvidence(meteringEvidence);
  const { credential, credentialHash: localCredentialHash } = createUserCredential({
    protocolVersion: contractClient.protocolVersion ?? "6",
    handshakeId: session.handshakeId,
    round: credentialRound,
    model: effectiveModel,
    modelHash: chainState?.modelHash ?? ethers.keccak256(ethers.toUtf8Bytes(effectiveModel)),
    pricingPolicyHash: chainState?.pricingPolicyHash ?? session.pricingPolicyHash,
    tokenizerHash: chainState?.tokenizerHash ?? session.tokenizerHash,
    providerWallet: session.providerWallet,
    userWallet: session.userWallet,
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    inputTokenPrice: chainState?.inputTokenPrice ?? route.pricing.inputTokenPrice,
    outputTokenPrice: chainState?.outputTokenPrice ?? route.pricing.outputTokenPrice,
    roundCost,
    cumulativeSpent,
    previousCredentialHash: previousHash,
    meteringHash,
    chainId: config.contract.chainId,
    contractAddress: contractClient.contractAddress ?? config.contract.contractAddress,
    timestamp: Math.max(Math.floor(Date.now() / 1000), Number(chainState?.openedAt ?? 0)),
  });

  // ========== 10. 计算 credential hash ==========
  // 关键设计：聊天调用默认不写链。只有 User/session signer 签过的 dToken credential
  // 才能用于 provider 结算、用户退出或挑战。
  let credentialHash = localCredentialHash;
  let chainRecorded = false;
  let recordTxHash = null;
  try {
    if (contractClient.mode === "mainnet") {
      credentialHash = await contractClient.userCredentialDigest(credential);
    }
  } catch (error) {
    if (streaming) streamError(response, "credential_hash_failed",
      `Could not prepare dToken user credential: ${error.message}`);
    else sendError(response, 502, "credential_hash_failed",
      `Could not prepare dToken user credential: ${error.message}`);
    return;
  }

  // ========== 11. 更新状态 ==========
  keyStore.updateSpent(session, cumulativeSpent, credentialHash, credential.round, { credential });
  persistSessions?.();

  // ========== 12. 写入账本 ==========
  ledger.record({
    handshakeId: session.handshakeId,
    apiKey: maskKey(session.apiKey),
    userWallet: session.userWallet,
    requestModel: effectiveModel,
    upstreamId: route.upstreamId,
    upstreamModel: route.upstreamModel,
    requestMessages: forwardedMessages,
    requestMessageHandling: messageHandlingForMetering(messagePlan),
    upstreamPromptTokens: usage.promptTokens,
    upstreamCompletionTokens: usage.completionTokens,
    upstreamTotalTokens: usage.totalTokens,
    upstreamRawCompletionTokens: usage.rawCompletionTokens,
    upstreamReasoningTokens: usage.reasoningTokens,
    upstreamHiddenOutputTokens: usage.hiddenOutputTokens,
    upstreamPromptCacheHitTokens: usage.promptCacheHitTokens,
    upstreamPromptCacheMissTokens: usage.promptCacheMissTokens,
    upstreamBillableOutputSource: usage.billableOutputSource,
    upstreamMultimodalInput: multimodalInputForMetering(messagePlan),
    upstreamLatencyMs,
    upstreamRequestId: upstreamResponse.id,
    inputTokenPrice: route.pricing.inputTokenPrice.toString(),
    outputTokenPrice: route.pricing.outputTokenPrice.toString(),
    roundCost: roundCost.toString(),
    cumulativeSpent: cumulativeSpent.toString(),
    remaining: remaining.toString(),
    credentialRound: credential.round,
    credentialHash,
    previousCredentialHash: previousHash,
    meteringHash,
    requestHash,
    responseHash,
    pricingPolicyHash: credential.pricing_policy_hash,
    tokenizerHash: credential.tokenizer_hash,
    autoConfirmedPrevious: false,
    confirmedCumulativeSpent: session.credentialChain.lastConfirmedCumulativeSpent.toString(),
    chainRecorded,
    recordTxHash,
  });

  // ========== 13. 返回响应 ==========
  const responseBody = {
    id: upstreamResponse.id,
    object: upstreamResponse.object,
    created: upstreamResponse.created,
    model: effectiveModel, // 返回 User 看到的 displayName，而非上游模型名
    choices: upstreamResponse.choices,
    usage: buildOpenAIUsage(usage),
    dtoken: {
      handshake_id: session.handshakeId,
      provider_operator_wallet: session.providerWallet,
      user_wallet: session.userWallet,
      round_cost: roundCost.toString(),
      cumulative_spent: cumulativeSpent.toString(),
      remaining: remaining.toString(),
      confirmed_cumulative_spent: session.credentialChain.lastConfirmedCumulativeSpent.toString(),
      chain_recorded: chainRecorded,
      settlement_mode: "user_signed_credential",
      user_credential_endpoint: "/v1/dtoken/credential-signature",
      credential: {
        protocol_version: credential.protocol_version,
        handshake_id: credential.handshake_id,
        round: credential.round,
        model: credential.model,
        model_hash: credential.model_hash,
        pricing_policy_hash: credential.pricing_policy_hash,
        tokenizer_hash: credential.tokenizer_hash,
        input_token_count: credential.input_token_count,
        output_token_count: credential.output_token_count,
        input_token_price: credential.input_token_price,
        output_token_price: credential.output_token_price,
        round_cost: credential.round_cost,
        cumulative_spent: credential.cumulative_spent,
        previous_credential_hash: credential.previous_credential_hash,
        metering_hash: credential.metering_hash,
        signed_at: credential.signed_at,
        chain_id: credential.chain_id,
        contract_address: credential.contract_address,
        credential_hash: credentialHash,
        chain_recorded: chainRecorded,
        record_tx_hash: recordTxHash,
      },
      metering: {
        hash: meteringHash,
        algorithm: "sha256-stable-json",
        request_hash: requestHash,
        response_hash: responseHash,
        usage: usageForMetering(usage),
      },
      message_handling: {
        model_supports_images: messagePlan.supportsImages,
        multimodal_policy: messagePlan.multimodalPolicy,
        downgraded_to_text: messagePlan.downgradedToText,
        ignored_image_parts: messagePlan.ignoredImageParts,
        ignored_non_text_parts: messagePlan.ignoredNonTextParts,
        accepted_image_parts: messagePlan.acceptedImageParts,
        accepted_image_bytes: messagePlan.acceptedImageBytes,
        accepted_video_parts: messagePlan.acceptedVideoParts,
        accepted_video_bytes: messagePlan.acceptedVideoBytes,
        accepted_audio_parts: messagePlan.acceptedAudioParts,
        accepted_audio_bytes: messagePlan.acceptedAudioBytes,
        accepted_file_parts: messagePlan.acceptedFileParts,
        accepted_file_bytes: messagePlan.acceptedFileBytes,
        ignored_video_parts: messagePlan.ignoredVideoParts,
        ignored_video_bytes: messagePlan.ignoredVideoBytes,
        ignored_audio_parts: messagePlan.ignoredAudioParts,
        ignored_audio_bytes: messagePlan.ignoredAudioBytes,
        ignored_file_parts: messagePlan.ignoredFileParts,
        ignored_file_bytes: messagePlan.ignoredFileBytes,
        text_chars: messagePlan.textChars,
        token_accounting: "upstream_usage",
      },
    },
  };

  const mmLog = messagePlan.acceptedImageParts
    ? ` | images=${messagePlan.acceptedImageParts} bytes=${messagePlan.acceptedImageBytes}`
    : (messagePlan.downgradedToText ? ` | text-only ignored images=${messagePlan.ignoredImageParts}` : "");
  console.log(`[dtoken] ${effectiveModel} | tokens: ${usage.promptTokens}/${usage.completionTokens} | cost: ${roundCost} | total: ${cumulativeSpent} | remaining: ${remaining} | ${upstreamLatencyMs}ms${mmLog}`);

  if (streaming) {
    finishLiveStream(response, {
      events: streamReplayEvents,
      upstreamResponse,
      model: effectiveModel,
    });
    writeSse(response, "dtoken", responseBody);
    response.write("data: [DONE]\n\n");
    response.end();
  } else {
    sendJson(response, 200, responseBody);
  }
}

function normalizeCredentialHash(value) {
  if (!value || value === "0x0") return ZERO_HASH;
  return value;
}

function sameAddress(a, b) {
  try {
    return ethers.getAddress(a) === ethers.getAddress(b);
  } catch {
    return false;
  }
}

function hasStrictUsage(usage) {
  return Number.isSafeInteger(usage?.promptTokens)
    && Number.isSafeInteger(usage?.completionTokens)
    && Number.isSafeInteger(usage?.totalTokens)
    && usage.promptTokens >= 0
    && usage.completionTokens >= 0
    && usage.totalTokens >= usage.promptTokens + usage.completionTokens
    && (usage.promptTokens + usage.completionTokens) > 0;
}

function normalizeMessagesForHash(messages) {
  return messages.map(({ role, content, name, tool_call_id, tool_calls, reasoning_content }) => ({
    role,
    content,
    name: name ?? null,
    tool_call_id: tool_call_id ?? null,
    tool_calls: tool_calls ?? null,
    reasoning_content: reasoning_content ?? null,
  }));
}

function messageHandlingForMetering(plan) {
  return {
    model_supports_images: !!plan.supportsImages,
    multimodal_policy: plan.multimodalPolicy ?? "strip_unsupported_media_with_text",
    downgraded_to_text: !!plan.downgradedToText,
    ignored_image_parts: Number(plan.ignoredImageParts ?? 0),
    ignored_image_bytes: Number(plan.ignoredImageBytes ?? 0),
    ignored_non_text_parts: Number(plan.ignoredNonTextParts ?? 0),
    accepted_image_parts: Number(plan.acceptedImageParts ?? 0),
    accepted_image_bytes: Number(plan.acceptedImageBytes ?? 0),
    accepted_video_parts: Number(plan.acceptedVideoParts ?? 0),
    accepted_video_bytes: Number(plan.acceptedVideoBytes ?? 0),
    accepted_audio_parts: Number(plan.acceptedAudioParts ?? 0),
    accepted_audio_bytes: Number(plan.acceptedAudioBytes ?? 0),
    accepted_file_parts: Number(plan.acceptedFileParts ?? 0),
    accepted_file_bytes: Number(plan.acceptedFileBytes ?? 0),
    ignored_video_parts: Number(plan.ignoredVideoParts ?? 0),
    ignored_video_bytes: Number(plan.ignoredVideoBytes ?? 0),
    ignored_audio_parts: Number(plan.ignoredAudioParts ?? 0),
    ignored_audio_bytes: Number(plan.ignoredAudioBytes ?? 0),
    ignored_file_parts: Number(plan.ignoredFileParts ?? 0),
    ignored_file_bytes: Number(plan.ignoredFileBytes ?? 0),
    text_chars: Number(plan.textChars ?? 0),
    token_accounting: "upstream_usage",
  };
}

function multimodalInputForMetering(plan) {
  return {
    accepted_image_parts: Number(plan.acceptedImageParts ?? 0),
    accepted_image_bytes: Number(plan.acceptedImageBytes ?? 0),
    accepted_video_parts: Number(plan.acceptedVideoParts ?? 0),
    accepted_video_bytes: Number(plan.acceptedVideoBytes ?? 0),
    accepted_audio_parts: Number(plan.acceptedAudioParts ?? 0),
    accepted_audio_bytes: Number(plan.acceptedAudioBytes ?? 0),
    accepted_file_parts: Number(plan.acceptedFileParts ?? 0),
    accepted_file_bytes: Number(plan.acceptedFileBytes ?? 0),
    ignored_image_parts: Number(plan.ignoredImageParts ?? 0),
    ignored_image_bytes: Number(plan.ignoredImageBytes ?? 0),
    ignored_video_parts: Number(plan.ignoredVideoParts ?? 0),
    ignored_video_bytes: Number(plan.ignoredVideoBytes ?? 0),
    ignored_audio_parts: Number(plan.ignoredAudioParts ?? 0),
    ignored_audio_bytes: Number(plan.ignoredAudioBytes ?? 0),
    ignored_file_parts: Number(plan.ignoredFileParts ?? 0),
    ignored_file_bytes: Number(plan.ignoredFileBytes ?? 0),
  };
}

function usageForMetering(usage) {
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
    raw_completion_tokens: usage.rawCompletionTokens,
    reasoning_tokens: usage.reasoningTokens,
    hidden_output_tokens: usage.hiddenOutputTokens,
    prompt_cache_hit_tokens: usage.promptCacheHitTokens,
    prompt_cache_miss_tokens: usage.promptCacheMissTokens,
    billable_output_source: usage.billableOutputSource,
    raw_usage: usage.raw ?? null,
  };
}

function buildOpenAIUsage(usage) {
  const out = {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
  };

  const promptDetails = {};
  if (usage.promptCacheHitTokens != null) promptDetails.cached_tokens = usage.promptCacheHitTokens;
  if (usage.promptCacheMissTokens != null) promptDetails.cache_miss_tokens = usage.promptCacheMissTokens;
  if (Object.keys(promptDetails).length) out.prompt_tokens_details = promptDetails;

  const completionDetails = {};
  if (usage.reasoningTokens != null) completionDetails.reasoning_tokens = usage.reasoningTokens;
  if (usage.rawCompletionTokens != null) completionDetails.raw_completion_tokens = usage.rawCompletionTokens;
  if (usage.hiddenOutputTokens != null) completionDetails.hidden_output_tokens = usage.hiddenOutputTokens;
  if (Object.keys(completionDetails).length) out.completion_tokens_details = completionDetails;

  return out;
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
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-dToken-Expose-Metadata, X-Requested-With",
  });
  response.flushHeaders?.();
  response.write(": dtoken-stream\n\n");
}

function writeSse(response, event, data) {
  if (event) response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeOpenAIStreamDelta(response, { id, created, model, delta }) {
  writeSse(response, null, {
    id: id ?? `chatcmpl_${Date.now()}`,
    object: "chat.completion.chunk",
    created: created ?? Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: null,
      },
    ],
  });
}

function writeOpenAIStreamFinish(response, { id, created, model, finishReason }) {
  writeSse(response, null, {
    id: id ?? `chatcmpl_${Date.now()}`,
    object: "chat.completion.chunk",
    created: created ?? Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason ?? "stop",
      },
    ],
  });
}

function replayBufferedStream(response, { events, upstreamResponse, model }) {
  const replay = [...(events ?? [])];
  const choice = upstreamResponse?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  if (!replay.length && typeof message.content === "string" && message.content) {
    replay.push({
      delta: { content: message.content },
      id: upstreamResponse.id,
      created: upstreamResponse.created,
    });
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length && !replay.some((event) => Array.isArray(event.delta?.tool_calls))) {
    replay.push({
      delta: { tool_calls: streamToolCallDeltas(message.tool_calls) },
      id: upstreamResponse.id,
      created: upstreamResponse.created,
    });
  }
  let lastId = upstreamResponse?.id ?? null;
  let lastCreated = upstreamResponse?.created ?? null;
  for (const event of replay) {
    lastId = event.id ?? lastId;
    lastCreated = event.created ?? lastCreated;
    writeOpenAIStreamDelta(response, {
      id: event.id ?? lastId,
      created: event.created ?? lastCreated,
      model,
      delta: event.delta,
    });
  }
  writeOpenAIStreamFinish(response, {
    id: lastId,
    created: lastCreated,
    model,
    finishReason: choice.finish_reason ?? (message.tool_calls?.length ? "tool_calls" : "stop"),
  });
}

function finishLiveStream(response, { events, upstreamResponse, model }) {
  const replay = [...(events ?? [])];
  if (!replay.length) {
    replayBufferedStream(response, { events: replay, upstreamResponse, model });
    return;
  }

  const choice = upstreamResponse?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const hasToolDelta = replay.some((event) => Array.isArray(event.delta?.tool_calls));
  if (Array.isArray(message.tool_calls) && message.tool_calls.length && !hasToolDelta) {
    const last = replay[replay.length - 1] ?? {};
    writeOpenAIStreamDelta(response, {
      id: last.id ?? upstreamResponse?.id,
      created: last.created ?? upstreamResponse?.created,
      model,
      delta: { tool_calls: streamToolCallDeltas(message.tool_calls) },
    });
  }

  const lastEvent = replay[replay.length - 1] ?? {};
  writeOpenAIStreamFinish(response, {
    id: lastEvent.id ?? upstreamResponse?.id,
    created: lastEvent.created ?? upstreamResponse?.created,
    model,
    finishReason: choice.finish_reason ?? (message.tool_calls?.length ? "tool_calls" : "stop"),
  });
}

function streamToolCallDeltas(toolCalls = []) {
  return toolCalls.map((call, index) => {
    const fn = call?.function ?? {};
    return {
      index,
      id: String(call?.id ?? `call_${index}`),
      type: call?.type ?? "function",
      function: {
        name: String(fn.name ?? call?.name ?? ""),
        arguments: typeof fn.arguments === "string"
          ? fn.arguments
          : JSON.stringify(fn.arguments ?? call?.arguments ?? {}),
      },
    };
  });
}

function streamError(response, code, message) {
  writeSse(response, "error", {
    error: { type: code, code, message },
  });
  response.write("data: [DONE]\n\n");
  response.end();
}

async function settleExhaustedSession({ contractClient, keyStore, session, persistSessions }) {
  try {
    const result = await providerSettleWithLatestCredential({
      contractClient,
      keyStore,
      session,
      persistSessions,
    });
    if (result.settled) {
      console.log(`[dtoken] budget exhausted; settled ${session.handshakeId} at latest user credential (${result.cumulativeSpent} dToken)`);
      return result;
    } else {
      console.warn(`[dtoken] budget exhausted; could not auto-settle ${session.handshakeId}: ${result.reason}`);
      keyStore.deactivateSession(session.apiKey);
      persistSessions?.();
      return { settled: false, reason: result.reason ?? "missing_latest_user_credential" };
    }
  } catch (error) {
    console.warn(`[dtoken] budget exhausted settlement failed for ${session.handshakeId}: ${error.message}`);
    keyStore.deactivateSession(session.apiKey);
    persistSessions?.();
    return { settled: false, reason: error.message };
  }
}

function settlementMessage(settlement) {
  if (settlement?.settled) {
    return `Provider settled immediately at ${settlement.cumulativeSpent ?? "latest"} dToken.`;
  }
  return `Provider could not settle immediately (${settlement?.reason ?? "unknown"}); the session was stopped.`;
}

/**
 * 提取透传参数（排除已知的 OpenAI 字段）
 */
function extractExtraParams(body) {
  const known = new Set([
    "model",
    "messages",
    "max_tokens",
    "max_completion_tokens",
    "max_output_tokens",
    "temperature",
    "stream",
    "n",
    // Client metadata is not billable model input. Some OpenAI-compatible
    // providers, including GLM, reject it as an invalid request parameter.
    "metadata",
  ]);
  const extra = {};
  for (const [key, value] of Object.entries(body)) {
    if (!known.has(key)) {
      extra[key] = value;
    }
  }
  return extra;
}

function defaultMaxTokensForRoute(route, messagePlan) {
  if ((messagePlan.acceptedImageParts ?? 0) > 0 && route.upstreamId === "kimi") return 2048;
  return null;
}
