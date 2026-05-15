/**
 * 本地账本服务
 *
 * 记录每一次模型调用的详细信息，用于：
 * 1. 对账和审计
 * 2. 毛利分析
 * 3. 问题追溯
 */

import fs from "node:fs";
import path from "node:path";

export function createLedger(config) {
  const ledgerConfig = config.ledger ?? {};
  const storageDir = path.resolve(ledgerConfig.storagePath ?? "./data");
  // 默认不保存消息内容，保护 User 隐私
  const saveMessages = ledgerConfig.saveMessages === true;

  /** @type {Array<Object>} */
  let records = [];
  let saveTimer = null;

  // 确保存储目录存在
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }

  /**
   * 记录一次模型调用
   *
   * @param {Object} entry
   * @param {string} entry.handshakeId
   * @param {string} entry.apiKey
   * @param {string} entry.userWallet
   * @param {string} entry.requestModel
   * @param {string} entry.upstreamId
   * @param {string} entry.upstreamModel
   * @param {Array} [entry.requestMessages]
   * @param {number} entry.upstreamPromptTokens
   * @param {number} entry.upstreamCompletionTokens
   * @param {number} entry.upstreamTotalTokens
   * @param {number} entry.upstreamLatencyMs
   * @param {string} [entry.upstreamRequestId]
   * @param {string} entry.inputTokenPrice
   * @param {string} entry.outputTokenPrice
   * @param {string} entry.roundCost
   * @param {string} entry.cumulativeSpent
   * @param {string} entry.remaining
 * @param {string} entry.credentialHash
 * @param {string} entry.previousCredentialHash
   * @param {boolean} entry.autoConfirmedPrevious
   * @param {string} [entry.confirmedCumulativeSpent]
   */
  function record(entry) {
    const record = {
      id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Math.floor(Date.now() / 1000),
      ...entry,
    };

    if (!saveMessages) {
      delete record.requestMessages;
    }

    records.push(record);

    // 延迟批量落盘
    scheduleSave();

    return record;
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveToDisk();
      saveTimer = null;
    }, ledgerConfig.autoSaveIntervalMs ?? 10000);
  }

  /**
   * 将记录写入磁盘
   */
  function saveToDisk() {
    try {
      const date = new Date().toISOString().slice(0, 10);
      const filePath = path.join(storageDir, `ledger-${date}.jsonl`);

      // 追加写入
      const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
      fs.appendFileSync(filePath, lines, "utf8");

      // 清空已保存的记录
      records = [];
    } catch (error) {
      console.error(`[ledger] Failed to save: ${error.message}`);
    }
  }

  /**
   * 立即保存（用于关闭时）
   */
  function flush() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saveToDisk();
  }

  /**
   * 按 handshakeId 查询记录
   * @param {string} handshakeId
   * @returns {Array<Object>}
   */
  function queryByHandshake(handshakeId) {
    const results = [];
    // 先查内存中的
    for (const r of records) {
      if (r.handshakeId === handshakeId) results.push(r);
    }
    // 再查磁盘上的历史 ledger 文件。
    for (const r of readDiskRecords()) {
      if (r.handshakeId === handshakeId) results.push(r);
    }
    return results;
  }

  /**
   * 获取统计摘要
   */
  function getSummary() {
    const summary = {
      totalCalls: 0,
      totalDtokenEarned: 0n,
      totalTokensProcessed: 0,
      byModel: {},
    };

    for (const r of [...readDiskRecords(), ...records]) {
      summary.totalCalls++;
      summary.totalDtokenEarned += BigInt(r.roundCost ?? "0");
      summary.totalTokensProcessed += (r.upstreamTotalTokens ?? 0);

      const model = r.requestModel ?? "unknown";
      if (!summary.byModel[model]) {
        summary.byModel[model] = { calls: 0, dtokenEarned: 0n, tokens: 0 };
      }
      summary.byModel[model].calls++;
      summary.byModel[model].dtokenEarned += BigInt(r.roundCost ?? "0");
      summary.byModel[model].tokens += (r.upstreamTotalTokens ?? 0);
    }

    return {
      totalCalls: summary.totalCalls,
      totalDtokenEarned: summary.totalDtokenEarned.toString(),
      totalTokensProcessed: summary.totalTokensProcessed,
      byModel: Object.fromEntries(
        Object.entries(summary.byModel).map(([k, v]) => [
          k,
          { calls: v.calls, dtokenEarned: v.dtokenEarned.toString(), tokens: v.tokens },
        ]),
      ),
    };
  }

  return { record, flush, queryByHandshake, getSummary, saveToDisk };

  function readDiskRecords() {
    const out = [];
    try {
      const files = fs.readdirSync(storageDir)
        .filter((name) => /^ledger-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
        .sort();
      for (const name of files) {
        const filePath = path.join(storageDir, name);
        const raw = fs.readFileSync(filePath, "utf8").trim();
        if (!raw) continue;
        for (const line of raw.split("\n")) {
          if (!line) continue;
          try { out.push(JSON.parse(line)); } catch { /* skip malformed lines */ }
        }
      }
    } catch { /* ignore disk read errors */ }
    return out;
  }
}
