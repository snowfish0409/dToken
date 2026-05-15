/**
 * HTTP 工具函数
 */

/**
 * 发送 JSON 响应
 */
export function sendJson(response, statusCode, body) {
  const json = JSON.stringify(body);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-dToken-Expose-Metadata, X-Requested-With",
  });
  response.end(json);
}

/**
 * 发送错误响应
 */
export function sendError(response, statusCode, code, message) {
  sendJson(response, statusCode, {
    error: { type: code, code, message },
  });
}

/**
 * 发送 404
 */
export function notFound(response) {
  sendError(response, 404, "not_found", "The requested resource was not found");
}

/**
 * 读取请求体为 JSON
 */
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
      } catch (error) {
        reject(Object.assign(new Error("Invalid JSON in request body"), { statusCode: 400, code: "invalid_request" }));
      }
    });
    request.on("error", reject);
  });
}

/**
 * 获取当前 Unix 时间戳
 */
export function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

/**
 * 获取服务启动时间
 */
export function uptime(startTime) {
  return Math.floor((Date.now() - startTime) / 1000);
}

/**
 * 脱敏：只显示 key 的前 4 和后 4 字符
 */
export function maskKey(key) {
  if (!key) return "***";
  if (key.length <= 8) return key[0] + "***" + key[key.length - 1];
  return key.slice(0, 4) + "****" + key.slice(-4);
}
