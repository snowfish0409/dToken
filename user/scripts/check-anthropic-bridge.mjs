import assert from "node:assert/strict";
import {
  CLIENT_FORMATS,
  normalizeAgentRequest,
  shapeClientResponse,
  shouldEmitAnthropicThinking,
} from "../apps/dtoken-agent-gateway/src/core/formatBridge.js";
import { renderMessagesForProvider } from "../apps/dtoken-agent-gateway/src/services/multimodal.js";

const qwenProfile = {
  dtoken: {
    model: "qwen3.6-plus",
    providerFamily: "qwen",
    upstreamFormat: "openai_chat_completions",
  },
};

const anthropicProfile = {
  dtoken: {
    model: "claude-sonnet-4-5",
    providerFamily: "anthropic",
    upstreamFormat: "anthropic_messages",
  },
};

const ackMeta = {
  credentialRound: 1,
  cumulativeSpent: "0",
  signature: "0x",
};

assert.equal(shouldEmitAnthropicThinking(qwenProfile), false);
assert.equal(shouldEmitAnthropicThinking(anthropicProfile), true);

const normalized = normalizeAgentRequest({
  clientFormat: CLIENT_FORMATS.ANTHROPIC_MESSAGES,
  profile: qwenProfile,
  body: {
    model: "claude-sonnet-4-5",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private chain-of-thought", signature: "sig" },
          { type: "redacted_thinking", data: "redacted-secret" },
          { type: "text", text: "visible answer" },
        ],
      },
      { role: "user", content: "continue" },
    ],
  },
});

const normalizedJson = JSON.stringify(normalized);
assert.equal(normalizedJson.includes("private chain-of-thought"), false);
assert.equal(normalizedJson.includes("redacted-secret"), false);
assert.equal(normalized.messages[0].content[0].text, "visible answer");

const qwenAnthropicResponse = shapeClientResponse({
  clientFormat: CLIENT_FORMATS.ANTHROPIC_MESSAGES,
  profile: qwenProfile,
  exposeDTokenMetadata: false,
  ackMeta,
  payload: {
    id: "chatcmpl_qwen",
    model: "qwen3.6-plus",
    choices: [
      {
        finish_reason: "stop",
        message: {
          content: "visible answer",
          reasoning_content: "qwen reasoning should stay internal",
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2 },
  },
});

assert.equal(qwenAnthropicResponse.content.some((part) => part.type === "thinking"), false);
assert.deepEqual(qwenAnthropicResponse.content, [{ type: "text", text: "visible answer" }]);

const qwenReasoningOnlyResponse = shapeClientResponse({
  clientFormat: CLIENT_FORMATS.ANTHROPIC_MESSAGES,
  profile: qwenProfile,
  exposeDTokenMetadata: false,
  ackMeta,
  payload: {
    id: "chatcmpl_qwen_reasoning_only",
    model: "qwen3.6-plus",
    choices: [
      {
        finish_reason: "stop",
        message: {
          content: "",
          reasoning_content: "fallback answer from upstream reasoning",
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2 },
  },
});

assert.deepEqual(qwenReasoningOnlyResponse.content, [
  { type: "text", text: "fallback answer from upstream reasoning" },
]);

const anthropicResponse = shapeClientResponse({
  clientFormat: CLIENT_FORMATS.ANTHROPIC_MESSAGES,
  profile: anthropicProfile,
  exposeDTokenMetadata: false,
  ackMeta,
  payload: {
    id: "msg_claude",
    model: "claude-sonnet-4-5",
    choices: [
      {
        finish_reason: "stop",
        message: {
          content: "visible answer",
          reasoning_content: "native anthropic thinking",
          reasoning_signature: "real-signature",
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2 },
  },
});

assert.equal(anthropicResponse.content[0].type, "thinking");
assert.equal(anthropicResponse.content[0].signature, "real-signature");

const rendered = renderMessagesForProvider([
  { role: "assistant", content: "visible answer", reasoning_content: "hidden" },
], {
  format: "anthropic_messages",
  emitAnthropicThinking: false,
});

assert.equal(rendered.messages[0].content.some((part) => part.type === "thinking"), false);

console.log("Anthropic bridge compatibility checks passed");
