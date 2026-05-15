/**
 * dToken 链下计量凭证服务
 *
 * 核心职责：
 * 1. 生成链下计量 credential 对象
 * 2. 维护本地 Hash Chain（每条 credential 通过 previousCredentialHash 链接前一条）
 * 3. 链上只验证 User-signed settlement 的 cumulativeSpent / meteringHash
 */

import crypto from "node:crypto";

export const ZERO_HASH = "0x" + "00".repeat(32);

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

export function hashMeteringEvidence(evidence) {
  return "0x" + crypto.createHash("sha256").update(stableStringify(evidence)).digest("hex");
}

/**
 * 计算链下 credential 的哈希。
 * 这个哈希只用于本地/服务器账本连续性；主网链上结算只使用 UserDTokenSettlement digest。
 *
 * @param {Object} credential - credential 对象（不含 hash 和 signature）
 * @returns {string} 0x 前缀的 hex hash
 */
export function hashCredential(credential) {
  const canonical = [
    credential.protocol_version ?? "0",
    credential.handshake_id ?? "",
    String(credential.round ?? 0),
    credential.model ?? "",
    credential.model_hash ?? "",
    credential.pricing_policy_hash ?? "",
    credential.tokenizer_hash ?? "",
    credential.user_wallet ?? "",
    String(credential.input_token_count ?? 0),
    String(credential.output_token_count ?? 0),
    String(credential.input_token_price ?? "0"),
    String(credential.output_token_price ?? "0"),
    String(credential.round_cost ?? "0"),
    String(credential.cumulative_spent ?? "0"),
    credential.previous_credential_hash ?? ZERO_HASH,
    credential.metering_hash ?? ZERO_HASH,
    String(credential.signed_at ?? 0),
    String(credential.chain_id ?? 0),
    credential.contract_address ?? "",
  ].join("|");

  return "0x" + crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * 生成等待 User 签名的 dToken 凭证
 *
 * @param {Object} params
 * @param {string} params.handshakeId
 * @param {number} params.round
 * @param {string} params.model - User 请求的 displayName
 * @param {string} params.modelHash
 * @param {string} params.pricingPolicyHash
 * @param {string} params.tokenizerHash
 * @param {string} params.providerWallet
 * @param {string} params.userWallet
 * @param {number} params.inputTokens - 真实 prompt_tokens
 * @param {number} params.outputTokens - 真实 completion_tokens
 * @param {string|bigint} params.inputTokenPrice
 * @param {string|bigint} params.outputTokenPrice
 * @param {string|bigint} params.roundCost
 * @param {string|bigint} params.cumulativeSpent
 * @param {string} params.previousCredentialHash
 * @param {string} params.meteringHash
 * @param {number} params.chainId
 * @param {string} params.contractAddress
 * @param {number} [params.timestamp]
 * @returns {{credential: Object, credentialHash: string}}
 */
export function createUserCredential({
  protocolVersion = "6",
  handshakeId,
  round,
  model,
  modelHash,
  pricingPolicyHash,
  tokenizerHash,
  providerWallet,
  userWallet,
  inputTokens,
  outputTokens,
  inputTokenPrice = "0",
  outputTokenPrice = "0",
  roundCost,
  cumulativeSpent,
  previousCredentialHash = ZERO_HASH,
  meteringHash = ZERO_HASH,
  chainId,
  contractAddress,
  timestamp,
}) {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);

  const credential = {
    protocol_version: String(protocolVersion),
    handshake_id: handshakeId,
    round: Number(round ?? 0),
    model,
    model_hash: modelHash,
    pricing_policy_hash: pricingPolicyHash,
    tokenizer_hash: tokenizerHash,
    user_wallet: userWallet,
    input_token_count: inputTokens,
    output_token_count: outputTokens,
    input_token_price: typeof inputTokenPrice === "bigint" ? inputTokenPrice.toString() : String(inputTokenPrice),
    output_token_price: typeof outputTokenPrice === "bigint" ? outputTokenPrice.toString() : String(outputTokenPrice),
    round_cost: typeof roundCost === "bigint" ? roundCost.toString() : String(roundCost),
    cumulative_spent: typeof cumulativeSpent === "bigint" ? cumulativeSpent.toString() : String(cumulativeSpent),
    previous_credential_hash: previousCredentialHash,
    metering_hash: meteringHash,
    signed_at: ts,
    chain_id: chainId,
    contract_address: contractAddress,
  };

  const credentialHash = hashCredential(credential);

  return { credential, credentialHash };
}

/**
 * Hash Chain 管理器
 *
 * 管理一个 handshake 下的 user credential 链：
 * - 追踪最新的 credential hash 和 previous credential hash
 * - 维护累计消费和已确认累计消费（一轮差）
 */
export class CredentialChain {
  /**
   * @param {Object} opts
   * @param {string} [opts.latestCredentialHash] - 初始最新 credential hash
   * @param {bigint} [opts.cumulativeSpent] - 初始累计消费
   * @param {bigint} [opts.lastConfirmedCumulativeSpent] - 初始已确认累计消费
   */
  constructor(opts = {}) {
    this.latestCredentialHash = opts.latestCredentialHash ?? opts.latestReceiptHash ?? ZERO_HASH;
    this.latestCredentialRound = Number(opts.latestCredentialRound ?? opts.latestReceiptRound ?? 0);
    this.cumulativeSpent = opts.cumulativeSpent ?? 0n;
    this.lastConfirmedCumulativeSpent = opts.lastConfirmedCumulativeSpent ?? 0n;
    this.previousCredentialHash = opts.previousCredentialHash ?? opts.previousReceiptHash ?? ZERO_HASH;
    this.credentialCount = opts.credentialCount ?? opts.receiptCount ?? 0;
  }

  get latestReceiptHash() { return this.latestCredentialHash; }
  set latestReceiptHash(value) { this.latestCredentialHash = value; }
  get latestReceiptRound() { return this.latestCredentialRound; }
  set latestReceiptRound(value) { this.latestCredentialRound = Number(value ?? 0); }
  get previousReceiptHash() { return this.previousCredentialHash; }
  set previousReceiptHash(value) { this.previousCredentialHash = value; }
  get receiptCount() { return this.credentialCount; }
  set receiptCount(value) { this.credentialCount = Number(value ?? 0); }

  /**
   * 是否有上一轮未确认的 user credential
   */
  hasUnconfirmedCredential() {
    return this.cumulativeSpent > this.lastConfirmedCumulativeSpent;
  }

  /**
   * 获取本轮可确认的金额（即上一轮的 cumulativeSpent）
   * 用于下一轮请求自动确认上一轮
   */
  getConfirmableAmount() {
    if (!this.hasUnconfirmedCredential()) return null;
    return this.cumulativeSpent;
  }

  /**
   * 自动确认上一轮 user credential
   * 将 lastConfirmedCumulativeSpent 更新为上一轮的 cumulativeSpent
   * 注意：这应在"本轮 request 到来时"调用，确认的是"上一轮"的 cumulativeSpent
   *
   * @returns {{confirmed: boolean, previousConfirmed: bigint, newConfirmed: bigint}}
   */
  autoConfirmPrevious() {
    if (!this.hasUnconfirmedCredential()) {
      return { confirmed: false, previousConfirmed: this.lastConfirmedCumulativeSpent, newConfirmed: this.lastConfirmedCumulativeSpent };
    }
    const previousConfirmed = this.lastConfirmedCumulativeSpent;
    this.lastConfirmedCumulativeSpent = this.cumulativeSpent;
    return { confirmed: true, previousConfirmed, newConfirmed: this.lastConfirmedCumulativeSpent };
  }

  /**
   * 记录一条新的 user credential
   *
   * @param {string} credentialHash - 新 credential 的 hash
   */
  recordCredential(credentialHash, credentialRound = null) {
    this.previousCredentialHash = this.latestCredentialHash || ZERO_HASH;
    this.latestCredentialHash = credentialHash;
    if (credentialRound != null) this.latestCredentialRound = Number(credentialRound);
    this.credentialCount++;
  }

  /**
   * 获取当前状态快照
   */
  snapshot() {
    return {
      latestCredentialHash: this.latestCredentialHash,
      latestCredentialRound: this.latestCredentialRound,
      previousCredentialHash: this.previousCredentialHash,
      cumulativeSpent: this.cumulativeSpent.toString(),
      lastConfirmedCumulativeSpent: this.lastConfirmedCumulativeSpent.toString(),
      credentialCount: this.credentialCount,
    };
  }

  /**
   * 从快照恢复状态
   */
  static fromSnapshot(snapshot) {
    return new CredentialChain({
      latestCredentialHash: normalizeHash(snapshot.latestCredentialHash ?? snapshot.latestReceiptHash),
      latestCredentialRound: Number(snapshot.latestCredentialRound ?? snapshot.latestReceiptRound ?? 0),
      cumulativeSpent: BigInt(snapshot.cumulativeSpent ?? "0"),
      lastConfirmedCumulativeSpent: BigInt(snapshot.lastConfirmedCumulativeSpent ?? "0"),
      previousCredentialHash: normalizeHash(snapshot.previousCredentialHash ?? snapshot.previousReceiptHash),
      credentialCount: snapshot.credentialCount ?? snapshot.receiptCount,
    });
  }
}

function normalizeHash(value) {
  if (!value || value === "0x0") return ZERO_HASH;
  return value;
}
