/**
 * Provider/model capability defaults.
 *
 * These are routing hints, not billing truth. Real dToken billing must still use
 * strict upstream usage returned by the adapter. Configured model capabilities
 * override these defaults.
 */

import { COMPANY_SPECS } from "../companies/index.js";

const TEXT = ["chat"];
const VISION = ["chat", "vision", "image"];
const OMNI = ["chat", "vision", "image", "audio", "video", "file", "multimodal", "omni"];

export function normalizeProviderFamily(value = "") {
  const text = String(value || "").toLowerCase();
  if (text.includes("deepseek")) return "deepseek";
  if (text.includes("moonshot") || text.includes("kimi")) return "kimi";
  if (text.includes("bigmodel") || text.includes("zhipu") || text.includes("glm")) return "glm";
  if (text.includes("anthropic") || text.includes("claude")) return "anthropic";
  if (text.includes("openai") || text.includes("chatgpt") || text.includes("gpt")) return "openai";
  if (text.includes("gemini") || text.includes("google")) return "gemini";
  if (text.includes("xai") || text.includes("grok")) return "grok";
  if (text.includes("dashscope") || text.includes("qwen") || text.includes("aliyun") || text.includes("alibaba")) return "qwen";
  if (text.includes("mistral") || text.includes("magistral") || text.includes("pixtral")) return "mistral";
  if (text.includes("openrouter")) return "openrouter";
  if (text.includes("llama") || text.includes("meta")) return "llama";
  return text || "generic";
}

export function inferModelCapabilities({ providerFamily, upstreamModel = "", displayName = "" }) {
  const provider = normalizeProviderFamily(providerFamily);
  const model = `${upstreamModel} ${displayName}`.toLowerCase();

  if (provider === "deepseek") return TEXT;

  if (provider === "kimi") {
    if (/(vision|vl|moonshot-v1-\d+k-vision|k2-vision)/u.test(model)) return VISION;
    return TEXT;
  }

  if (provider === "glm") {
    if (/(glm-4\.5v|glm-4v|vision|vl|visual)/u.test(model)) return VISION;
    return TEXT;
  }

  if (provider === "anthropic") return /claude|sonnet|opus|haiku/u.test(model) ? VISION : TEXT;

  if (provider === "openai") {
    if (/(gpt-4o|gpt-4\.1|gpt-5|o3|o4|vision|realtime|audio)/u.test(model)) return VISION;
    return TEXT;
  }

  if (provider === "gemini") {
    if (/(gemini|imagen|veo)/u.test(model)) return OMNI;
    return VISION;
  }

  if (provider === "grok") {
    if (/(vision|grok-2-vision|grok-4|grok-3)/u.test(model)) return VISION;
    return TEXT;
  }

  if (provider === "qwen") {
    if (/(omni|audio|qwen-audio)/u.test(model)) return OMNI;
    if (/(vl|vision|qwen-vl|qwen2\.5-vl|qwen3-vl|qvq)/u.test(model)) return VISION;
    return TEXT;
  }

  if (provider === "mistral") {
    if (/(pixtral|vision|vl|image)/u.test(model)) return VISION;
    return TEXT;
  }

  if (provider === "openrouter" || provider === "llama") {
    if (/(vision|vl|maverick|scout|llama-4)/u.test(model)) return VISION;
    return TEXT;
  }

  return TEXT;
}

export const PROVIDER_ADAPTER_MATRIX = Object.fromEntries(
  Object.entries(COMPANY_SPECS).map(([name, spec]) => [
    name,
    {
      defaultType: spec.upstream.type,
      messageFormat: spec.upstream.messageFormat,
      responsesType: spec.upstream.responsesType,
      defaultCapabilities: spec.capabilities,
    },
  ]),
);
