/**
 * GET /v1/models — 返回可用模型列表
 */

import { sendJson, nowUnix } from "../http.js";

export function handleModels({ config, upstreamRouter, response }) {
  const models = upstreamRouter.listModels();

  const data = models.map((m) => {
    const capabilities = Array.isArray(m.capabilities) ? m.capabilities : [];
    const inputModes = inputModesFromCapabilities(capabilities);
    const outputModes = outputModesFromCapabilities(capabilities);
    const agentGatewayFormats = ["openai_chat_completions", "openai_responses", "anthropic_messages"];
    return {
      id: m.id,
      object: "model",
      created: nowUnix(),
      owned_by: m.providerWallet ?? config.provider.wallet,
      context_length: m.contextLength,
      capabilities,
      input_modes: inputModes,
      output_modes: outputModes,
      dtoken: {
        runtime_protocol: "dtoken.runtime.v1",
        provider_name: config.provider.name,
        provider_operator_wallet: m.providerWallet ?? config.provider.wallet,
        service_signer: config.provider.serviceSignerAddress,
        public_base_url: config.publicBaseUrl,
        provider_family: m.providerFamily,
        upstream_message_format: m.upstreamFormat,
        message_format: "dtoken.multimodal.v1",
        context_length: m.contextLength,
        capabilities,
        input_modes: inputModes,
        output_modes: outputModes,
        multimodal_policy: m.multimodalPolicy,
        incompatible_media: m.multimodalPolicy === "reject_unsupported_media"
          ? "reject_before_upstream"
          : "strip_if_text_remains_else_reject",
        agent_gateway_formats: agentGatewayFormats,
        input_token_price: m.pricing.inputTokenPrice,
        output_token_price: m.pricing.outputTokenPrice,
        input_token_price_dtoken: m.pricing.displayInputTokenPrice,
        output_token_price_dtoken: m.pricing.displayOutputTokenPrice,
        price_unit: m.pricing.displayUnit,
        tokenizer: "upstream",
        token_accounting: "strict_upstream_usage",
      },
    };
  });

  sendJson(response, 200, {
    object: "list",
    data,
  });
}

function inputModesFromCapabilities(capabilities) {
  const modes = new Set(["text"]);
  for (const cap of normalizeCapabilities(capabilities)) {
    if (["vision", "image", "images", "image_url", "visual", "omni"].includes(cap)) modes.add("image");
    if (["audio", "audio_input", "speech", "voice", "omni"].includes(cap)) modes.add("audio");
    if (["video", "video_url", "video_input", "omni"].includes(cap)) modes.add("video");
    if (["file", "files", "document", "pdf", "document_input", "omni"].includes(cap)) modes.add("file");
  }
  return [...modes];
}

function outputModesFromCapabilities(capabilities) {
  const modes = new Set(["text"]);
  for (const cap of normalizeCapabilities(capabilities)) {
    if (["image_output", "image_generation", "omni"].includes(cap)) modes.add("image");
    if (["audio_output", "speech_output", "voice_output", "omni"].includes(cap)) modes.add("audio");
    if (["video_output", "video_generation", "omni"].includes(cap)) modes.add("video");
    if (["file_output", "document_output"].includes(cap)) modes.add("file");
  }
  return [...modes];
}

function normalizeCapabilities(capabilities) {
  if (Array.isArray(capabilities)) {
    return [...new Set(capabilities.map((item) => String(item ?? "").trim().toLowerCase()).filter(Boolean))];
  }
  if (typeof capabilities === "string") return normalizeCapabilities(capabilities.split(/[,\s]+/u));
  return [];
}
