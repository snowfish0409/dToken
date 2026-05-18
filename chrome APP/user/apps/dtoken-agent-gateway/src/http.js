export function sendJson(response, statusCode, body, headers = {}) {
  const json = JSON.stringify(body);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
    ...corsHeaders(),
    ...headers,
  });
  response.end(json);
}

export function sendError(response, statusCode, code, message, extra = {}) {
  sendJson(response, statusCode, {
    error: {
      type: code,
      code,
      message,
      ...extra,
    },
  });
}

export function sendHtml(response, statusCode, html) {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    ...corsHeaders(),
  });
  response.end(html);
}

export function notFound(response) {
  sendError(response, 404, "not_found", "The requested resource was not found");
}

export function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("Invalid JSON in request body"), {
          statusCode: 400,
          code: "invalid_request",
        }));
      }
    });
    request.on("error", reject);
  });
}

export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version, X-dToken-Gateway-Install, X-dToken-Expose-Metadata",
  };
}

export function handleOptions(response) {
  response.writeHead(204, corsHeaders());
  response.end();
}

export function parseBearer(header) {
  if (!header) return "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

export function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

export function maskSecret(value) {
  const s = String(value ?? "");
  if (!s) return "";
  if (s.length <= 12) return `${s.slice(0, 2)}***${s.slice(-2)}`;
  return `${s.slice(0, 8)}...${s.slice(-6)}`;
}
