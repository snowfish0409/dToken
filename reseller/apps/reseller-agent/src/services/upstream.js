/**
 * 上游路由服务
 *
 * 负责：
 * 1. 管理多个上游后端实例
 * 2. 根据请求的 displayName 路由到正确的后端和模型
 * 3. 执行转发并返回标准化响应
 */

import { OpenAICompatibleBackend } from "../backends/openaiCompatible.js";
import { OpenAIResponsesBackend } from "../backends/openaiResponses.js";
import { AnthropicBackend } from "../backends/anthropic.js";
import { GeminiBackend } from "../backends/gemini.js";
import { QwenCodingPlanBackend } from "../backends/qwenCodingPlan.js";
import { formatDTokenAmount, modelPricing } from "./dtokenUnits.js";
import { normalizeCapabilities } from "./messageCapabilities.js";
import { inferModelCapabilities, normalizeProviderFamily } from "./providerProfiles.js";

export function createUpstreamRouter(config) {
  // 构建上游后端实例池
  const backends = new Map();
  for (const upstreamCfg of config.upstreams) {
    if (upstreamCfg.type === "openai_compatible") {
      backends.set(upstreamCfg.id, new OpenAICompatibleBackend(upstreamCfg));
    } else if (upstreamCfg.type === "qwen_coding_plan") {
      backends.set(upstreamCfg.id, new QwenCodingPlanBackend(upstreamCfg));
    } else if (upstreamCfg.type === "openai_responses" || upstreamCfg.type === "xai_responses") {
      backends.set(upstreamCfg.id, new OpenAIResponsesBackend(upstreamCfg));
    } else if (upstreamCfg.type === "anthropic" || upstreamCfg.type === "anthropic_messages") {
      backends.set(upstreamCfg.id, new AnthropicBackend(upstreamCfg));
    } else if (upstreamCfg.type === "gemini" || upstreamCfg.type === "google_gemini") {
      backends.set(upstreamCfg.id, new GeminiBackend(upstreamCfg));
    }
    if (!backends.has(upstreamCfg.id)) {
      throw new Error(`Unsupported upstream type "${upstreamCfg.type}" for upstream "${upstreamCfg.id}"`);
    }
  }

  // 构建模型路由表：displayName → { upstreamId, upstreamModel, pricing, rateLimit }
  const modelRoutes = new Map();
  for (const modelCfg of config.models) {
    if (modelRoutes.has(modelCfg.displayName)) {
      throw new Error(`Duplicate model displayName: ${modelCfg.displayName}`);
    }
    if (!backends.has(modelCfg.upstreamId)) {
      throw new Error(
        `Model "${modelCfg.displayName}" references unknown upstream "${modelCfg.upstreamId}"`,
      );
    }
    const upstreamCfg = config.upstreams.find((u) => u.id === modelCfg.upstreamId) ?? {};
    const providerFamily = normalizeProviderFamily(modelCfg.providerFamily ?? upstreamCfg.providerFamily ?? upstreamCfg.id);
    const upstreamFormat = modelCfg.messageFormat ?? modelCfg.upstreamFormat ?? upstreamCfg.messageFormat ?? messageFormatForUpstreamType(upstreamCfg.type);
    const pricing = modelPricing(modelCfg);
    const capabilities = normalizeCapabilities(modelCfg.capabilities ?? inferModelCapabilities({
      providerFamily,
      upstreamModel: modelCfg.upstreamModel,
      displayName: modelCfg.displayName,
    }));
    modelRoutes.set(modelCfg.displayName, {
      upstreamId: modelCfg.upstreamId,
      upstreamModel: modelCfg.upstreamModel,
      providerFamily,
      upstreamFormat,
      pricing,
      displayPricing: {
        inputTokenPrice: formatDTokenAmount(pricing.inputTokenPrice),
        outputTokenPrice: formatDTokenAmount(pricing.outputTokenPrice),
        unit: "dToken_per_llm_token",
      },
      rateLimit: {
        requestsPerMinute: modelCfg.rateLimit?.requestsPerMinute ?? null,
        tokensPerMinute: modelCfg.rateLimit?.tokensPerMinute ?? null,
      },
      contextLength: modelCfg.contextLength,
      capabilities,
      multimodalPolicy: modelCfg.multimodalPolicy ?? upstreamCfg.multimodalPolicy ?? "strip_unsupported_media_with_text",
      providerWallet: modelCfg.providerWallet ?? modelCfg.providerOperator ?? config.provider.wallet,
    });
  }

  return {
    backends,
    modelRoutes,

    /**
     * 解析模型名 → 路由信息
     * @param {string} displayName
     * @returns {{upstreamId: string, upstreamModel: string, pricing, rateLimit, contextLength, capabilities}|null}
     */
    resolveModel(displayName) {
      return modelRoutes.get(displayName) ?? null;
    },

    /**
     * 获取所有可用模型列表
     */
    listModels() {
      return Array.from(modelRoutes.entries()).map(([displayName, route]) => ({
        id: displayName,
        contextLength: route.contextLength,
        capabilities: route.capabilities,
        multimodalPolicy: route.multimodalPolicy,
        providerFamily: route.providerFamily,
        upstreamFormat: route.upstreamFormat,
        messageFormat: "dtoken.multimodal.v1",
        providerWallet: route.providerWallet,
        pricing: {
          inputTokenPrice: route.pricing.inputTokenPrice.toString(),
          outputTokenPrice: route.pricing.outputTokenPrice.toString(),
          displayInputTokenPrice: route.displayPricing.inputTokenPrice,
          displayOutputTokenPrice: route.displayPricing.outputTokenPrice,
          displayUnit: route.displayPricing.unit,
        },
      }));
    },

    /**
     * 执行上游转发
     * @param {string} upstreamId
     * @param {Object} params - { upstreamModel, messages, maxTokens, temperature, extra }
     * @returns {Promise<Object>} 标准化的响应
     */
    async forward(upstreamId, params) {
      const backend = backends.get(upstreamId);
      if (!backend) {
        throw new Error(`Upstream backend "${upstreamId}" not found`);
      }
      return backend.chatCompletion(params);
    },

    async forwardStream(upstreamId, params) {
      const backend = backends.get(upstreamId);
      if (!backend) {
        throw new Error(`Upstream backend "${upstreamId}" not found`);
      }
      const upstreamCfg = config.upstreams.find((u) => u.id === upstreamId) ?? {};
      if (upstreamCfg.streamStrategy === "non_stream_replay") {
        const result = await backend.chatCompletion(params);
        const reasoning = result?.choices?.[0]?.message?.reasoning_content ?? "";
        if (reasoning && params.onReasoningDelta) {
          params.onReasoningDelta(reasoning, {
            id: result.id,
            created: result.created,
            model: result.model,
          });
        }
        const text = result?.choices?.[0]?.message?.content ?? "";
        if (text && params.onDelta) {
          params.onDelta(text, {
            id: result.id,
            created: result.created,
            model: result.model,
          });
        }
        return result;
      }
      if (!backend.chatCompletionStream) {
        throw new Error(`Upstream backend "${upstreamId}" does not support streaming`);
      }
      return backend.chatCompletionStream(params);
    },

    /**
     * 获取所有上游后端的健康状态
     */
    async healthAll() {
      const results = {};
      for (const [id, backend] of backends) {
        results[id] = await backend.health();
      }
      return results;
    },

    /**
     * 获取单个上游的健康状态
     */
    async healthOne(upstreamId) {
      const backend = backends.get(upstreamId);
      if (!backend) return { ok: false, latencyMs: 0, details: { error: "not_found" } };
      return backend.health();
    },
  };
}

function messageFormatForUpstreamType(type = "") {
  if (type === "gemini" || type === "google_gemini") return "gemini_generate_content";
  if (type === "anthropic" || type === "anthropic_messages") return "anthropic_messages";
  if (type === "openai_responses") return "openai_responses";
  if (type === "xai_responses") return "xai_responses";
  if (type === "qwen_coding_plan") return "openai_chat_completions";
  return "openai_chat_completions";
}
