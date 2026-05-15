/**
 * 速率限制中间件
 *
 * 基于滑动窗口的 per-key 速率限制。
 * 限制维度：
 * - 每分钟请求数
 * - 每分钟 token 消耗数
 */

import { sendError } from "../http.js";

/**
 * 创建速率限制器
 *
 * @param {Object} options
 * @param {number} [options.defaultRequestsPerMinute=60]
 * @param {number} [options.defaultTokensPerMinute=100000]
 * @returns {Object}
 */
export function createRateLimiter(options = {}) {
  const defaultRPM = options.defaultRequestsPerMinute ?? 60;
  const defaultTPM = options.defaultTokensPerMinute ?? 100000;

  // per-key 追踪
  const trackers = new Map();

  /**
   * 检查是否超出速率限制
   *
   * @param {string} apiKey
   * @param {Object} limits - { requestsPerMinute, tokensPerMinute }
   * @param {number} estimatedTokens - 预估 token 数
   * @param {Object} response
   * @returns {boolean} 是否放行
   */
  function check(apiKey, limits, estimatedTokens, response) {
    const rpm = limits?.requestsPerMinute ?? defaultRPM;
    const tpm = limits?.tokensPerMinute ?? defaultTPM;

    if (!rpm && !tpm) return true; // 无限制

    const now = Date.now();
    const windowMs = 60000;

    let tracker = trackers.get(apiKey);
    if (!tracker || (now - tracker.windowStart) > windowMs) {
      tracker = { windowStart: now, requestCount: 0, tokenCount: 0 };
      trackers.set(apiKey, tracker);
    }

    // 先检查，再计数
    if (rpm && tracker.requestCount >= rpm) {
      const retryAfter = Math.ceil((tracker.windowStart + windowMs - now) / 1000);
      sendError(response, 429, "rate_limit_exceeded",
        `Rate limit exceeded: ${rpm} requests/min. Retry after ${retryAfter}s`);
      return false;
    }

    if (tpm && tracker.tokenCount >= tpm) {
      const retryAfter = Math.ceil((tracker.windowStart + windowMs - now) / 1000);
      sendError(response, 429, "rate_limit_exceeded",
        `Rate limit exceeded: ${tpm} tokens/min. Retry after ${retryAfter}s`);
      return false;
    }

    // 通过检查，记录本次请求
    tracker.requestCount++;

    return true;
  }

  /**
   * 记录实际 token 消耗（如果预估值不准确）
   */
  function recordTokens(apiKey, actualTokens) {
    const tracker = trackers.get(apiKey);
    if (tracker) {
      tracker.tokenCount += actualTokens;
    }
  }

  return { check, recordTokens };
}
