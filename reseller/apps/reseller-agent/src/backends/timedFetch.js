import { UpstreamBackendError } from "./interface.js";

export const DEFAULT_UPSTREAM_TIMEOUT_MS = 300000;

const responseTimings = new WeakMap();
const REDACTED_QUERY_KEYS = new Set([
  "api_key",
  "apikey",
  "access_token",
  "key",
  "token",
]);

export async function timedFetch({
  upstreamId,
  url,
  options = {},
  timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
  logTimings = true,
}) {
  const timing = createTiming({ upstreamId, url, timeoutMs, logTimings });
  const controller = new AbortController();
  const method = String(options.method ?? "GET").toUpperCase();
  const timeout = setTimeout(() => {
    timing.markTimeout();
    controller.abort();
  }, timeoutMs);

  timing.markRequestStart(method);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    timing.markHeaders(response);
    responseTimings.set(response, timing);
    return response;
  } catch (error) {
    clearTimeout(timeout);
    throw upstreamFetchError(error, timing);
  }
}

export async function readTimedStreamChunk(reader, response, {
  upstreamId,
  timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
  logTimings = true,
} = {}) {
  const timing = responseTimings.get(response)
    ?? createTiming({ upstreamId, url: "", timeoutMs, logTimings });
  const phase = timing.streamChunks === 0
    ? "waiting_for_first_stream_chunk"
    : "waiting_for_next_stream_chunk";
  timing.setPhase(phase);

  let timeout = null;
  const readPromise = reader.read();
  readPromise.catch(() => {});
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      timing.markTimeout();
      try {
        reader.cancel(`Timed out while ${phase}`);
      } catch {}
      reject(timing.timeoutError(phase));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([readPromise, timeoutPromise]);
    clearTimeout(timeout);
    if (result?.done) {
      timing.markStreamEnd();
    } else {
      timing.markStreamChunk(result?.value?.byteLength ?? 0);
    }
    return result;
  } catch (error) {
    clearTimeout(timeout);
    if (error instanceof UpstreamBackendError) throw error;
    throw upstreamFetchError(error, timing);
  }
}

function createTiming({ upstreamId, url, timeoutMs, logTimings }) {
  const startedAt = Date.now();
  let phase = "not_started";
  let firstChunkAt = null;
  const enabled = shouldLog(logTimings);
  const timing = {
    upstreamId,
    url: sanitizeUrl(url),
    timeoutMs,
    streamChunks: 0,
    streamBytes: 0,
    phase() {
      return phase;
    },
    setPhase(nextPhase) {
      phase = nextPhase;
    },
    elapsedMs() {
      return Date.now() - startedAt;
    },
    markRequestStart(method) {
      phase = "waiting_for_response_headers";
      logTiming(enabled, {
        event: "request_started",
        upstream: upstreamId,
        method,
        url: this.url,
        timeout_ms: timeoutMs,
        elapsed_ms: this.elapsedMs(),
        phase,
      });
    },
    markHeaders(response) {
      phase = "response_headers_received";
      logTiming(enabled, {
        event: "response_headers_received",
        upstream: upstreamId,
        status: response.status,
        elapsed_ms: this.elapsedMs(),
        phase,
      });
    },
    markStreamChunk(byteLength) {
      this.streamChunks += 1;
      this.streamBytes += Number(byteLength || 0);
      if (this.streamChunks === 1) {
        firstChunkAt = Date.now();
        phase = "streaming";
        logTiming(enabled, {
          event: "first_stream_chunk_received",
          upstream: upstreamId,
          elapsed_ms: this.elapsedMs(),
          time_to_first_chunk_ms: firstChunkAt - startedAt,
          first_chunk_bytes: Number(byteLength || 0),
          phase,
        });
      }
    },
    markStreamEnd() {
      phase = "stream_completed";
      logTiming(enabled, {
        event: "stream_completed",
        upstream: upstreamId,
        elapsed_ms: this.elapsedMs(),
        stream_chunks: this.streamChunks,
        stream_bytes: this.streamBytes,
        phase,
      });
    },
    markTimeout() {
      logTiming(enabled, {
        event: "timeout",
        upstream: upstreamId,
        elapsed_ms: this.elapsedMs(),
        timeout_ms: timeoutMs,
        stream_chunks: this.streamChunks,
        phase,
      });
    },
    timeoutError(timeoutPhase = phase) {
      const error = new UpstreamBackendError(
        `Upstream ${upstreamId} timed out while ${timeoutPhase} after ${timeoutMs}ms`,
        { code: "upstream_timeout" },
      );
      error.phase = timeoutPhase;
      error.elapsedMs = this.elapsedMs();
      error.timeoutMs = timeoutMs;
      error.streamChunks = this.streamChunks;
      return error;
    },
  };
  return timing;
}

function upstreamFetchError(error, timing) {
  if (error?.name === "AbortError") {
    return timing.timeoutError(timing.phase());
  }
  if (error instanceof UpstreamBackendError) return error;
  const wrapped = new UpstreamBackendError(
    `Upstream ${timing.upstreamId} request failed while ${timing.phase()}: ${error.message}`,
    { code: "upstream_network_error" },
  );
  wrapped.phase = timing.phase();
  wrapped.elapsedMs = timing.elapsedMs();
  return wrapped;
}

function shouldLog(logTimings) {
  const env = String(process.env.DTOKEN_UPSTREAM_TIMING_LOG ?? "").toLowerCase();
  if (["0", "false", "off", "no"].includes(env)) return false;
  if (["1", "true", "on", "yes"].includes(env)) return true;
  return logTimings !== false;
}

function logTiming(enabled, payload) {
  if (!enabled) return;
  console.info(`[upstream-timing] ${JSON.stringify(payload)}`);
}

function sanitizeUrl(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (REDACTED_QUERY_KEYS.has(key.toLowerCase())) {
        parsed.searchParams.set(key, "[redacted]");
      }
    }
    return parsed.toString();
  } catch {
    return String(url).replace(/([?&](?:api_?key|access_token|key|token)=)[^&]+/gi, "$1[redacted]");
  }
}
