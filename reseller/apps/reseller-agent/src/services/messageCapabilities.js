import {
  filterCanonicalMessagesForCapabilities,
  normalizeMessagesToDToken,
  summarizeCanonicalMessages,
} from "./multimodal.js";

const IMAGE_CAPABILITIES = new Set([
  "vision",
  "image",
  "images",
  "image_url",
  "visual",
]);
const VIDEO_CAPABILITIES = new Set(["video", "video_url", "video_input", "omni"]);
const AUDIO_CAPABILITIES = new Set(["audio", "audio_input", "speech", "voice", "omni"]);
const FILE_CAPABILITIES = new Set(["file", "files", "document", "pdf", "document_input", "omni"]);

export function normalizeCapabilities(capabilities) {
  if (Array.isArray(capabilities)) {
    return [...new Set(capabilities.map((item) => String(item ?? "").trim().toLowerCase()).filter(Boolean))];
  }
  if (typeof capabilities === "string") {
    return normalizeCapabilities(capabilities.split(/[,\s]+/u));
  }
  return [];
}

export function modelSupportsImages(routeOrCapabilities) {
  const capabilities = Array.isArray(routeOrCapabilities)
    ? routeOrCapabilities
    : routeOrCapabilities?.capabilities;
  return normalizeCapabilities(capabilities).some((item) => IMAGE_CAPABILITIES.has(item));
}

export function modelModalities(routeOrCapabilities) {
  const caps = normalizeCapabilities(Array.isArray(routeOrCapabilities)
    ? routeOrCapabilities
    : routeOrCapabilities?.capabilities);
  return {
    image: caps.some((item) => IMAGE_CAPABILITIES.has(item)),
    video: caps.some((item) => VIDEO_CAPABILITIES.has(item)),
    audio: caps.some((item) => AUDIO_CAPABILITIES.has(item)),
    file: caps.some((item) => FILE_CAPABILITIES.has(item)),
  };
}

export function prepareMessagesForModel(messages, route) {
  const modalities = modelModalities(route);
  const multimodalPolicy = normalizePolicy(route?.multimodalPolicy);
  const canonical = normalizeMessagesToDToken(messages);
  const filtered = filterCanonicalMessagesForCapabilities(canonical, modalities);
  const originalSummary = filtered.originalSummary ?? summarizeCanonicalMessages(canonical);
  const lastMessage = canonical[canonical.length - 1];
  const lastSummary = summarizeCanonicalMessages(lastMessage ? [lastMessage] : []);
  const ignoredMediaParts = filtered.ignoredImageParts + filtered.ignoredVideoParts + filtered.ignoredAudioParts + filtered.ignoredFileParts;
  if (ignoredMediaParts === 0 && filtered.ignoredNonTextParts === 0) {
    return {
      ok: true,
      messages: filtered.messages,
      supportsImages: modalities.image,
      supportsVideo: modalities.video,
      supportsAudio: modalities.audio,
      supportsFiles: modalities.file,
      multimodalPolicy,
      downgradedToText: false,
      ignoredImageParts: 0,
      ignoredImageBytes: 0,
      ignoredNonTextParts: 0,
      acceptedImageParts: originalSummary.imageParts,
      acceptedImageBytes: originalSummary.imageBytes,
      acceptedVideoParts: originalSummary.videoParts,
      acceptedVideoBytes: originalSummary.videoBytes,
      acceptedAudioParts: originalSummary.audioParts,
      acceptedAudioBytes: originalSummary.audioBytes,
      acceptedFileParts: originalSummary.fileParts,
      acceptedFileBytes: originalSummary.fileBytes,
      textChars: originalSummary.textChars,
    };
  }

  if (multimodalPolicy === "reject_unsupported_media") {
    return {
      ok: false,
      statusCode: 400,
      code: "multimodal_input_not_supported",
      message: "This model is not configured for the attached media. Choose a model with matching multimodal capability.",
      supportsImages: modalities.image,
      supportsVideo: modalities.video,
      supportsAudio: modalities.audio,
      supportsFiles: modalities.file,
      multimodalPolicy,
      ignoredImageParts: filtered.ignoredImageParts,
      ignoredImageBytes: filtered.ignoredImageBytes,
      ignoredVideoParts: filtered.ignoredVideoParts,
      ignoredVideoBytes: filtered.ignoredVideoBytes,
      ignoredAudioParts: filtered.ignoredAudioParts,
      ignoredAudioBytes: filtered.ignoredAudioBytes,
      ignoredFileParts: filtered.ignoredFileParts,
      ignoredFileBytes: filtered.ignoredFileBytes,
      ignoredNonTextParts: filtered.ignoredNonTextParts,
      acceptedImageParts: 0,
      acceptedImageBytes: 0,
      acceptedVideoParts: 0,
      acceptedVideoBytes: 0,
      acceptedAudioParts: 0,
      acceptedAudioBytes: 0,
      acceptedFileParts: 0,
      acceptedFileBytes: 0,
      textChars: originalSummary.textChars,
    };
  }

  if (lastMessage?.role === "user"
    && (lastSummary.imageParts + lastSummary.videoParts + lastSummary.audioParts + lastSummary.fileParts) > 0
    && lastSummary.textChars === 0) {
    return {
      ok: false,
      statusCode: 400,
      code: "multimodal_input_not_supported",
      message: "This model is not configured for the attached media. Media-only messages cannot be processed; add text or choose a model with matching multimodal capability.",
      supportsImages: modalities.image,
      supportsVideo: modalities.video,
      supportsAudio: modalities.audio,
      supportsFiles: modalities.file,
      multimodalPolicy,
      ignoredImageParts: filtered.ignoredImageParts,
      ignoredImageBytes: filtered.ignoredImageBytes,
      ignoredVideoParts: filtered.ignoredVideoParts,
      ignoredVideoBytes: filtered.ignoredVideoBytes,
      ignoredAudioParts: filtered.ignoredAudioParts,
      ignoredAudioBytes: filtered.ignoredAudioBytes,
      ignoredFileParts: filtered.ignoredFileParts,
      ignoredFileBytes: filtered.ignoredFileBytes,
      ignoredNonTextParts: filtered.ignoredNonTextParts,
      acceptedImageParts: 0,
      acceptedImageBytes: 0,
      acceptedVideoParts: 0,
      acceptedVideoBytes: 0,
      acceptedAudioParts: 0,
      acceptedAudioBytes: 0,
      acceptedFileParts: 0,
      acceptedFileBytes: 0,
      textChars: originalSummary.textChars,
    };
  }

  if (!filtered.messages.length) {
    return {
      ok: false,
      statusCode: 400,
      code: "empty_text_after_multimodal_filter",
      message: "No text content remains after filtering unsupported multimodal parts for this text-only model.",
      supportsImages: modalities.image,
      supportsVideo: modalities.video,
      supportsAudio: modalities.audio,
      supportsFiles: modalities.file,
      multimodalPolicy,
      ignoredImageParts: filtered.ignoredImageParts,
      ignoredImageBytes: filtered.ignoredImageBytes,
      ignoredVideoParts: filtered.ignoredVideoParts,
      ignoredVideoBytes: filtered.ignoredVideoBytes,
      ignoredAudioParts: filtered.ignoredAudioParts,
      ignoredAudioBytes: filtered.ignoredAudioBytes,
      ignoredFileParts: filtered.ignoredFileParts,
      ignoredFileBytes: filtered.ignoredFileBytes,
      ignoredNonTextParts: filtered.ignoredNonTextParts,
      acceptedImageParts: 0,
      acceptedImageBytes: 0,
      acceptedVideoParts: 0,
      acceptedVideoBytes: 0,
      acceptedAudioParts: 0,
      acceptedAudioBytes: 0,
      acceptedFileParts: 0,
      acceptedFileBytes: 0,
      textChars: originalSummary.textChars,
    };
  }

  const summary = summarizeCanonicalMessages(filtered.messages);
  return {
    ok: true,
    messages: filtered.messages,
    supportsImages: modalities.image,
    supportsVideo: modalities.video,
    supportsAudio: modalities.audio,
    supportsFiles: modalities.file,
    multimodalPolicy,
    downgradedToText: ignoredMediaParts > 0 || filtered.ignoredNonTextParts > 0,
    ignoredImageParts: filtered.ignoredImageParts,
    ignoredImageBytes: filtered.ignoredImageBytes,
    ignoredVideoParts: filtered.ignoredVideoParts,
    ignoredVideoBytes: filtered.ignoredVideoBytes,
    ignoredAudioParts: filtered.ignoredAudioParts,
    ignoredAudioBytes: filtered.ignoredAudioBytes,
    ignoredFileParts: filtered.ignoredFileParts,
    ignoredFileBytes: filtered.ignoredFileBytes,
    ignoredNonTextParts: filtered.ignoredNonTextParts,
    acceptedImageParts: 0,
    acceptedImageBytes: 0,
    acceptedVideoParts: 0,
    acceptedVideoBytes: 0,
    acceptedAudioParts: 0,
    acceptedAudioBytes: 0,
    acceptedFileParts: 0,
    acceptedFileBytes: 0,
    textChars: summary.textChars,
  };
}

function normalizePolicy(value) {
  const text = String(value ?? "strip_unsupported_media_with_text").trim().toLowerCase();
  if (text === "reject" || text === "reject_unsupported" || text === "reject_unsupported_media") {
    return "reject_unsupported_media";
  }
  return "strip_unsupported_media_with_text";
}
