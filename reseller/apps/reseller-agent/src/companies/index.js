import { anthropicCompany } from "./anthropic.js";
import { deepseekCompany } from "./deepseek.js";
import { geminiCompany } from "./gemini.js";
import { glmCompany } from "./glm.js";
import { grokCompany } from "./grok.js";
import { kimiCompany } from "./kimi.js";
import { mistralCompany } from "./mistral.js";
import { openaiCompany } from "./openai.js";
import { openrouterCompany } from "./openrouter.js";
import { qwenCompany } from "./qwen.js";

export const COMPANY_SPECS = Object.freeze({
  anthropic: anthropicCompany,
  deepseek: deepseekCompany,
  gemini: geminiCompany,
  glm: glmCompany,
  grok: grokCompany,
  kimi: kimiCompany,
  mistral: mistralCompany,
  openai: openaiCompany,
  openrouter: openrouterCompany,
  qwen: qwenCompany,
});

const aliasToName = new Map();
for (const spec of Object.values(COMPANY_SPECS)) {
  aliasToName.set(spec.name, spec.name);
  for (const alias of spec.aliases ?? []) aliasToName.set(normalizeToken(alias), spec.name);
}

export function normalizeCompanyName(value = "") {
  const token = normalizeToken(value);
  if (!token) return "";
  return aliasToName.get(token) ?? token;
}

export function getCompanySpec(value = "") {
  return COMPANY_SPECS[normalizeCompanyName(value)] ?? null;
}

export function applyCompanyDefaults(config) {
  const upstreams = (config.upstreams ?? []).map((upstream) => {
    const company = normalizeCompanyName(upstream.company ?? upstream.providerFamily ?? upstream.family ?? "");
    const spec = getCompanySpec(company);
    if (!spec) return { ...upstream };

    const apiFlavor = normalizeToken(upstream.apiFlavor ?? upstream.flavor ?? upstream.protocol ?? "");
    const defaultType = apiFlavor === "responses" && spec.upstream.responsesType
      ? spec.upstream.responsesType
      : spec.upstream.type;
    const defaultMessageFormat = defaultType === "openai_responses"
      ? "openai_responses"
      : (defaultType === "xai_responses" ? "xai_responses" : spec.upstream.messageFormat);

    return {
      ...spec.upstream,
      ...upstream,
      company: spec.name,
      providerFamily: upstream.providerFamily ?? spec.upstream.providerFamily ?? spec.name,
      type: upstream.type ?? defaultType,
      messageFormat: upstream.messageFormat ?? defaultMessageFormat,
      baseUrl: upstream.baseUrl ?? spec.upstream.baseUrl,
      multimodalPolicy: upstream.multimodalPolicy ?? spec.upstream.multimodalPolicy,
      streamStrategy: upstream.streamStrategy ?? spec.upstream.streamStrategy,
      includeStreamUsage: upstream.includeStreamUsage ?? spec.upstream.includeStreamUsage,
      preserveReasoningContent: upstream.preserveReasoningContent ?? spec.upstream.preserveReasoningContent,
    };
  });

  const upstreamById = new Map(upstreams.map((upstream) => [upstream.id, upstream]));
  const models = (config.models ?? []).map((model) => {
    const upstream = upstreamById.get(model.upstreamId) ?? {};
    const company = normalizeCompanyName(model.company ?? model.providerFamily ?? upstream.company ?? upstream.providerFamily ?? "");
    return {
      ...model,
      company: model.company ?? (company || undefined),
      providerFamily: model.providerFamily ?? upstream.providerFamily ?? (company || undefined),
      messageFormat: model.messageFormat ?? model.upstreamFormat ?? upstream.messageFormat,
      upstreamFormat: model.upstreamFormat ?? model.messageFormat ?? upstream.messageFormat,
      multimodalPolicy: model.multimodalPolicy ?? upstream.multimodalPolicy,
    };
  });

  return { ...config, upstreams, models };
}

export function supportedCompanyNames() {
  return Object.keys(COMPANY_SPECS);
}

function normalizeToken(value = "") {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
