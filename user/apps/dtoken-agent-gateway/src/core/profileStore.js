import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ethers } from "ethers";
import { maskSecret } from "../http.js";
import { normalizeClientFormat, inferUpstreamFormat, normalizeUpstreamFormat } from "./formatBridge.js";

export function createProfileStore(config) {
  const defaultProfilePath = path.join(config.dataPath, "agent-profile.json");
  const profilePath = config.profilePath || defaultProfilePath;
  const profilesPath = path.join(config.dataPath, "agent-profiles.json");
  let profiles = new Map();
  let activeHandshakeId = "";
  let loadedFrom = "";

  function load() {
    profiles = new Map();
    if (fs.existsSync(profilesPath)) {
      const body = JSON.parse(fs.readFileSync(profilesPath, "utf8"));
      const list = Array.isArray(body) ? body : (body.profiles ?? []);
      for (const item of list) upsert(normalizeProfile(item));
      activeHandshakeId = normalizeHandshakeId(body.activeHandshakeId || activeHandshakeId);
      loadedFrom = profilesPath;
    }
    if (fs.existsSync(profilePath)) {
      upsert(normalizeProfile(JSON.parse(fs.readFileSync(profilePath, "utf8"))));
      if (!loadedFrom) loadedFrom = profilePath;
    }
    return get();
  }

  function save(nextProfile) {
    const profile = normalizeProfile(nextProfile);
    upsert(profile);
    activeHandshakeId = profile.dtoken.handshakeId;
    persist();
    loadedFrom = profilesPath;
    return profile;
  }

  function remove(handshakeId) {
    const id = normalizeHandshakeId(handshakeId);
    if (!id || !profiles.has(id)) return false;
    profiles.delete(id);
    if (activeHandshakeId === id) activeHandshakeId = list()[0]?.dtoken?.handshakeId ?? "";
    persist();
    loadedFrom = profilesPath;
    return true;
  }

  function disable(handshakeId, reason = "") {
    const id = normalizeHandshakeId(handshakeId);
    const profile = profiles.get(id);
    if (!profile) return false;
    profiles.set(id, {
      ...profile,
      updatedAt: Date.now(),
      agent: {
        ...profile.agent,
        disabled: true,
        disabledReason: String(reason || "disabled"),
      },
    });
    persist();
    loadedFrom = profilesPath;
    return true;
  }

  function get() {
    if (activeHandshakeId && profiles.has(activeHandshakeId)) return profiles.get(activeHandshakeId);
    return list()[0] ?? null;
  }

  function requireProfile() {
    const profile = get();
    if (!profile) {
      const error = new Error("No dToken Agent Profile is loaded");
      error.code = "profile_missing";
      error.statusCode = 409;
      throw error;
    }
    return profile;
  }

  function getPath() {
    return profilesPath;
  }

  function source() {
    return loadedFrom;
  }

  function list() {
    return Array.from(profiles.values()).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  }

  function exportData() {
    return { activeHandshakeId, profiles: list() };
  }

  function importData(data = {}) {
    profiles = new Map();
    const sourceList = Array.isArray(data) ? data : (Array.isArray(data.profiles) ? data.profiles : []);
    for (const item of sourceList) upsert(normalizeProfile(item));
    activeHandshakeId = normalizeHandshakeId(data.activeHandshakeId || activeHandshakeId);
    if (activeHandshakeId && !profiles.has(activeHandshakeId)) activeHandshakeId = list()[0]?.dtoken?.handshakeId ?? "";
    persist();
    loadedFrom = profilesPath;
    return exportData();
  }

  function getByApiKey(apiKey) {
    const token = String(apiKey ?? "");
    if (!token) return null;
    return list().find((profile) => profile.agent.apiKey === token) ?? null;
  }

  function getByHandshakeId(handshakeId) {
    return profiles.get(normalizeHandshakeId(handshakeId)) ?? null;
  }

  function upsert(profile) {
    profiles.set(profile.dtoken.handshakeId, profile);
    if (!activeHandshakeId) activeHandshakeId = profile.dtoken.handshakeId;
  }

  function persist() {
    fs.mkdirSync(config.dataPath, { recursive: true });
    const body = { activeHandshakeId, profiles: list() };
    fs.writeFileSync(profilesPath, JSON.stringify(body, null, 2), "utf8");
    if (get()) fs.writeFileSync(profilePath, JSON.stringify(get(), null, 2), "utf8");
    else if (fs.existsSync(profilePath)) fs.unlinkSync(profilePath);
  }

  load();

  return { load, save, remove, disable, get, requireProfile, getPath, source, list, exportData, importData, getByApiKey, getByHandshakeId };
}

export function normalizeProfile(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Agent profile must be a JSON object");
  }
  const dtoken = input.dtoken ?? input.session ?? {};
  const agent = input.agent ?? {};
  const gateway = input.gateway ?? {};
  const sessionSigner = dtoken.sessionSigner ?? dtoken.session_signer ?? input.sessionSigner ?? {};
  const apiKey = dtoken.apiKey ?? input.apiKey;
  const endpoint = dtoken.endpoint ?? input.endpoint;
  const model = dtoken.model ?? input.model;
  const handshakeId = normalizeHandshakeId(dtoken.handshakeId ?? dtoken.handshake_id ?? input.handshakeId);

  if (!apiKey || !endpoint || !model || !handshakeId) {
    throw new Error("Agent profile requires dtoken.apiKey, endpoint, model, and handshakeId");
  }
  if (!sessionSigner.privateKey) {
    throw new Error("Agent profile requires dtoken.sessionSigner.privateKey for automatic User credential signing");
  }

  const wallet = new ethers.Wallet(sessionSigner.privateKey);
  const signerAddress = ethers.getAddress(sessionSigner.address ?? wallet.address);
  if (ethers.getAddress(wallet.address) !== signerAddress) {
    throw new Error("sessionSigner.privateKey does not match sessionSigner.address");
  }

  const localApiKey = agent.apiKey || agent.localApiKey || `dtok_agent_${crypto.randomBytes(16).toString("hex")}`;
  const aliases = Array.from(new Set([
    ...(Array.isArray(agent.aliases) ? agent.aliases : []),
    model,
    `dtoken/${model}`,
    `openai/${model}`,
  ].filter(Boolean)));

  const capabilities = normalizeStringArray(dtoken.capabilities);
  const contextLength = Number(dtoken.contextLength ?? dtoken.context_length ?? dtoken.runtime?.contextLength ?? dtoken.runtime?.context_length ?? 0);
  const inputModes = normalizeStringArray(dtoken.inputModes ?? dtoken.input_modes ?? dtoken.runtime?.inputModes ?? dtoken.runtime?.input_modes);
  const outputModes = normalizeStringArray(dtoken.outputModes ?? dtoken.output_modes ?? dtoken.runtime?.outputModes ?? dtoken.runtime?.output_modes);
  const agentGatewayFormats = normalizeStringArray(
    dtoken.agentGatewayFormats ?? dtoken.agent_gateway_formats ?? dtoken.runtime?.agentGatewayFormats ?? dtoken.runtime?.agent_gateway_formats,
  );

  return {
    protocol: input.protocol || "dtoken.agent.profile.v1",
    name: input.name || `${model} agent`,
    createdAt: Number(input.createdAt ?? Date.now()),
    updatedAt: Date.now(),
    gateway: {
      localBaseUrl: gateway.localBaseUrl || "http://127.0.0.1:8789",
      phase: gateway.phase || "phase2-format-bridge",
    },
    agent: {
      apiKey: localApiKey,
      aliases,
      clientFormat: normalizeClientFormat(agent.clientFormat ?? agent.client_format ?? "openai_chat_completions"),
      budgetLimitDToken: agent.budgetLimitDToken ?? agent.budget_limit_dtoken ?? null,
      disabled: agent.disabled === true,
      disabledReason: agent.disabledReason ?? agent.disabled_reason ?? "",
    },
    dtoken: {
      apiKey,
      endpoint: normalizeEndpoint(endpoint),
      model,
      handshakeId,
      contractAddress: dtoken.contractAddress ?? dtoken.contract_address ?? "",
      tokenAddress: dtoken.tokenAddress ?? dtoken.token_address ?? "",
      chainId: Number(dtoken.chainId ?? dtoken.chain_id ?? 1),
      signingVersion: String(dtoken.signingVersion ?? dtoken.signing_version ?? "0"),
      userWallet: normalizeAddress(dtoken.userWallet ?? dtoken.user_wallet),
      providerWallet: normalizeAddress(dtoken.providerWallet ?? dtoken.provider_wallet),
      escrowAmount: String(dtoken.escrowAmount ?? dtoken.escrow_amount ?? "0"),
      startingCumulativeSpent: String(dtoken.startingCumulativeSpent ?? dtoken.starting_cumulative_spent ?? "0"),
      inputTokenPrice: String(dtoken.inputTokenPrice ?? dtoken.input_token_price ?? dtoken.runtime?.inputTokenPrice ?? dtoken.runtime?.input_token_price ?? "0"),
      outputTokenPrice: String(dtoken.outputTokenPrice ?? dtoken.output_token_price ?? dtoken.runtime?.outputTokenPrice ?? dtoken.runtime?.output_token_price ?? "0"),
      capabilities,
      providerFamily: dtoken.providerFamily ?? dtoken.provider_family ?? dtoken.company ?? "",
      upstreamFormat: normalizeUpstreamFormat(
        dtoken.upstreamFormat ?? dtoken.upstream_format ?? dtoken.messageFormat ?? dtoken.message_format ?? inferUpstreamFormat(dtoken),
        dtoken.providerFamily ?? dtoken.provider_family ?? dtoken.company,
      ),
      messageFormat: dtoken.messageFormat ?? dtoken.message_format ?? "dtoken.multimodal.v1",
      contextLength,
      multimodalPolicy: dtoken.multimodalPolicy ?? dtoken.multimodal_policy ?? dtoken.runtime?.multimodalPolicy ?? dtoken.runtime?.multimodal_policy ?? "strip_unsupported_media_with_text",
      inputModes: inputModes.length ? inputModes : inputModesFromCapabilities(capabilities),
      outputModes: outputModes.length ? outputModes : outputModesFromCapabilities(capabilities),
      agentGatewayFormats: agentGatewayFormats.length
        ? agentGatewayFormats
        : ["openai_chat_completions", "openai_responses", "anthropic_messages"],
      runtime: dtoken.runtime && typeof dtoken.runtime === "object" ? dtoken.runtime : null,
      sessionSigner: {
        address: signerAddress,
        privateKey: sessionSigner.privateKey,
      },
    },
  };
}

export function redactProfile(profile) {
  if (!profile) return null;
  return {
    ...profile,
    agent: {
      ...profile.agent,
      apiKey: maskSecret(profile.agent.apiKey),
    },
    dtoken: {
      ...profile.dtoken,
      apiKey: maskSecret(profile.dtoken.apiKey),
      sessionSigner: {
        address: profile.dtoken.sessionSigner?.address ?? "",
        privateKey: maskSecret(profile.dtoken.sessionSigner?.privateKey),
      },
    },
  };
}

export function providerPath(profile, suffix) {
  return `${profile.dtoken.endpoint.replace(/\/+$/, "")}${suffix}`;
}

function normalizeEndpoint(endpoint) {
  const out = String(endpoint ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(out)) throw new Error("dtoken.endpoint must be an http(s) URL");
  return out;
}

function normalizeHandshakeId(value) {
  const out = String(value ?? "").trim();
  return /^0x[0-9a-f]{64}$/i.test(out) ? out.toLowerCase() : out;
}

function normalizeAddress(value) {
  if (!value) return "";
  try {
    return ethers.getAddress(value);
  } catch {
    return String(value);
  }
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))];
  }
  if (typeof value === "string") {
    return normalizeStringArray(value.split(/[,\s]+/u));
  }
  return [];
}

function inputModesFromCapabilities(capabilities) {
  const modes = new Set(["text"]);
  for (const cap of normalizeStringArray(capabilities).map((item) => item.toLowerCase())) {
    if (["vision", "image", "images", "image_url", "visual", "omni"].includes(cap)) modes.add("image");
    if (["audio", "audio_input", "speech", "voice", "omni"].includes(cap)) modes.add("audio");
    if (["video", "video_url", "video_input", "omni"].includes(cap)) modes.add("video");
    if (["file", "files", "document", "pdf", "document_input", "omni"].includes(cap)) modes.add("file");
  }
  return [...modes];
}

function outputModesFromCapabilities(capabilities) {
  const modes = new Set(["text"]);
  for (const cap of normalizeStringArray(capabilities).map((item) => item.toLowerCase())) {
    if (["image_output", "image_generation", "omni"].includes(cap)) modes.add("image");
    if (["audio_output", "speech_output", "voice_output", "omni"].includes(cap)) modes.add("audio");
    if (["video_output", "video_generation", "omni"].includes(cap)) modes.add("video");
    if (["file_output", "document_output"].includes(cap)) modes.add("file");
  }
  return [...modes];
}
