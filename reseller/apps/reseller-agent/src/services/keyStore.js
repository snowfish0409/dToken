/**
 * API Key 存储服务
 *
 * 管理 User API key 与 session 的映射。
 * 每个 API key 绑定一个 handshake，提供完整的生命周期管理。
 */

import crypto from "node:crypto";
import { CredentialChain, ZERO_HASH } from "./credentials.js";

/**
 * 生成 API key
 * 格式：dtok_live_<16字节随机hex>
 *
 * @returns {string}
 */
export function generateApiKey() {
  return "dtok_live_" + crypto.randomBytes(16).toString("hex");
}

/**
 * @typedef {Object} SessionState
 * @property {string} apiKey
 * @property {string} handshakeId
 * @property {string} userWallet
 * @property {string} providerWallet
 * @property {bigint} escrowAmount - 托管总金额
 * @property {bigint} cumulativeSpent - Provider 已知最新累计消费
 * @property {string} latestCredentialHash
 * @property {number} latestCredentialRound
 * @property {string|null} modelHash
 * @property {string|null} pricingPolicyHash
 * @property {string|null} tokenizerHash
 * @property {bigint} inputTokenPrice
 * @property {bigint} outputTokenPrice
 * @property {Object|null} latestCredential
 * @property {Object|null} latestUserCredential
 * @property {string|null} latestUserCredentialSignature
 * @property {CredentialChain} credentialChain - Hash chain 管理器
 * @property {string|null} modelScope - 限制的模型（null=不限制）
 * @property {boolean} active
 * @property {number} createdAt
 * @property {number|null} expiresAt
 */

export function createKeyStore(config) {
  /** @type {Map<string, SessionState>} */
  const sessions = new Map();

  // 从配置中加载初始 demo keys
  for (const keyCfg of config.accessKeys ?? []) {
    sessions.set(keyCfg.apiKey, {
      apiKey: keyCfg.apiKey,
      handshakeId: keyCfg.handshakeId ?? "demo_handshake",
      userWallet: keyCfg.userWallet ?? "0xUser",
      providerWallet: config.provider.wallet,
      escrowAmount: BigInt(keyCfg.escrowAmount ?? "1000"),
      cumulativeSpent: 0n,
      latestCredentialHash: ZERO_HASH,
      latestCredentialRound: 0,
      modelHash: null,
      pricingPolicyHash: null,
      tokenizerHash: null,
      inputTokenPrice: 0n,
      outputTokenPrice: 0n,
      latestCredential: null,
      latestUserCredential: null,
      latestUserCredentialSignature: null,
        providerUpdate: null,
        credentialChain: new CredentialChain(),
      modelScope: keyCfg.modelScope ?? null,
      active: keyCfg.active !== false,
      createdAt: keyCfg.createdAt ?? Math.floor(Date.now() / 1000),
      expiresAt: keyCfg.expiresAt ?? null,
    });
  }

  return {
    sessions,

    /**
     * 鉴权：从 Authorization header 解析 API key 并返回 session
     *
     * @param {string|null} authorizationHeader
     * @returns {SessionState|null}
     */
    authenticate(authorizationHeader) {
      const token = parseBearer(authorizationHeader);
      if (!token) return null;

      const session = sessions.get(token);
      if (!session) return null;
      if (!session.active) return null;

      return session;
    },

    /**
     * 创建新的 API key 并绑定到 handshake
     *
     * @param {Object} params
     * @param {string} params.handshakeId
     * @param {string} params.userWallet
     * @param {string} params.escrowAmount
     * @param {string|null} [params.modelScope]
     * @returns {{apiKey: string, session: SessionState}}
     */
    createSession({ handshakeId, userWallet, escrowAmount, modelScope = null, chainState = null }) {
      const apiKey = generateApiKey();
      const latestCredentialHash = normalizeHash(chainState?.latestUserCredentialHash);
      const latestCredentialRound = Number(chainState?.latestUserCredentialRound ?? 0);
      const cumulativeSpent = BigInt(chainState?.latestUserCredentialCumulativeSpent ?? "0");
      const lastConfirmedCumulativeSpent = BigInt(chainState?.lastConfirmedCumulativeSpent ?? chainState?.pendingCloseAmount ?? "0");
      const session = {
        apiKey,
        handshakeId,
        userWallet,
        providerWallet: chainState?.providerOperator ?? config.provider.wallet,
        escrowAmount: BigInt(chainState?.escrowAmount ?? escrowAmount),
        cumulativeSpent,
        latestCredentialHash,
        latestCredentialRound,
        modelHash: null,
        pricingPolicyHash: null,
        tokenizerHash: null,
        inputTokenPrice: 0n,
        outputTokenPrice: 0n,
        latestCredential: null,
        latestUserCredential: null,
        latestUserCredentialSignature: null,
        providerUpdate: chainState?.providerUpdate ?? null,
        credentialChain: new CredentialChain({
          latestCredentialHash,
          latestCredentialRound,
          cumulativeSpent,
          lastConfirmedCumulativeSpent,
        }),
        modelScope,
        active: true,
        createdAt: Math.floor(Date.now() / 1000),
        expiresAt: null,
      };
      sessions.set(apiKey, session);
      return { apiKey, session };
    },

    syncSessionFromChain(session, chainState) {
      const chainRound = Number(chainState.latestUserCredentialRound ?? 0);
      const chainCumulativeSpent = BigInt(chainState.latestUserCredentialCumulativeSpent ?? "0");
      const localRound = Number(session.latestCredentialRound ?? session.credentialChain.latestCredentialRound ?? 0);
      session.escrowAmount = BigInt(chainState.escrowAmount ?? "0");
      session.providerWallet = chainState.providerOperator ?? session.providerWallet;
      const chainConfirmed = BigInt(chainState.lastConfirmedCumulativeSpent ?? chainState.pendingCloseAmount ?? "0");
      const localAckConfirmed = BigInt(session.latestUserCredential?.cumulative_spent ?? session.latestUserCredential?.cumulativeSpent ?? "0");
      session.credentialChain.lastConfirmedCumulativeSpent = chainConfirmed > localAckConfirmed
        ? chainConfirmed
        : localAckConfirmed;
      if (chainRound > localRound || chainCumulativeSpent > BigInt(session.cumulativeSpent ?? "0")) {
        const chainCredentialHash = normalizeHash(chainState.latestUserCredentialHash);
        if (chainCredentialHash.toLowerCase() !== normalizeHash(session.latestCredentialHash).toLowerCase()) {
          session.latestCredential = null;
        }
        session.cumulativeSpent = chainCumulativeSpent;
        session.latestCredentialHash = chainCredentialHash;
        session.latestCredentialRound = chainRound;
        session.credentialChain.cumulativeSpent = session.cumulativeSpent;
        session.credentialChain.latestCredentialHash = session.latestCredentialHash;
        session.credentialChain.latestCredentialRound = session.latestCredentialRound;
      }
    },

    /**
     * 停用 API key
     *
     * @param {string} apiKey
     */
    deactivateSession(apiKey) {
      const session = sessions.get(apiKey);
      if (session) {
        session.active = false;
      }
    },

    /**
     * 通过 handshakeId 查找 session
     *
     * @param {string} handshakeId
     * @returns {SessionState|null}
     */
    findByHandshakeId(handshakeId) {
      for (const session of sessions.values()) {
        if (session.handshakeId === handshakeId) return session;
      }
      return null;
    },

    /**
     * 更新 session 的累计消费
     *
     * @param {SessionState} session
     * @param {bigint} cumulativeSpent
     * @param {string} credentialHash
     */
    updateSpent(session, cumulativeSpent, credentialHash, credentialRound = null, credentialState = {}) {
      session.cumulativeSpent = cumulativeSpent;
      session.latestCredentialHash = credentialHash;
      if (credentialRound != null) {
        session.latestCredentialRound = Number(credentialRound);
      }
      if (credentialState.credential) session.latestCredential = credentialState.credential;
      session.credentialChain.cumulativeSpent = cumulativeSpent;
      if (normalizeHash(session.credentialChain.latestCredentialHash).toLowerCase() !== normalizeHash(credentialHash).toLowerCase()) {
        session.credentialChain.recordCredential(credentialHash, credentialRound);
      } else if (credentialRound != null) {
        session.credentialChain.latestCredentialRound = Number(credentialRound);
      }
    },

    recordUserCredential(session, credential, signature) {
      session.latestUserCredential = credential;
      session.latestUserCredentialSignature = signature;
      session.credentialChain.lastConfirmedCumulativeSpent = BigInt(credential.cumulative_spent ?? credential.cumulativeSpent ?? "0");
      session.credentialChain.latestCredentialRound = Number(credential.round ?? session.credentialChain.latestCredentialRound ?? 0);
      session.latestCredentialRound = session.credentialChain.latestCredentialRound;
    },

    /**
     * 列出所有 session
     */
    listSessions() {
      return Array.from(sessions.entries()).map(([apiKey, s]) => ({
        apiKey: maskApiKey(apiKey),
        apiKeyMasked: maskApiKey(apiKey),
        handshakeId: s.handshakeId,
        userWallet: s.userWallet,
        active: s.active,
        escrowAmount: s.escrowAmount.toString(),
        cumulativeSpent: s.cumulativeSpent.toString(),
        remaining: (s.escrowAmount - s.cumulativeSpent).toString(),
        lastConfirmedCumulativeSpent: s.credentialChain.lastConfirmedCumulativeSpent.toString(),
        credentialCount: s.credentialChain.credentialCount,
        latestCredentialHash: s.latestCredentialHash,
        latestCredentialRound: s.latestCredentialRound ?? s.credentialChain.latestCredentialRound ?? 0,
        // Legacy response aliases retained for existing User Gateway/User DApp builds.
        latestReceiptHash: s.latestCredentialHash,
        latestReceiptRound: s.latestCredentialRound ?? s.credentialChain.latestCredentialRound ?? 0,
        modelScope: s.modelScope,
        pricingPolicyHash: s.pricingPolicyHash,
        tokenizerHash: s.tokenizerHash,
        inputTokenPrice: s.inputTokenPrice?.toString?.() ?? "0",
        outputTokenPrice: s.outputTokenPrice?.toString?.() ?? "0",
        latestCredential: s.latestCredential ?? null,
        latestReceipt: s.latestCredential ?? null,
        latestUserCredential: s.latestUserCredential ?? null,
        hasLatestUserCredentialSignature: !!s.latestUserCredentialSignature,
        providerUpdate: s.providerUpdate ?? null,
        createdAt: s.createdAt,
      }));
    },

    /**
     * 获取活跃 session 数量
     */
    getActiveCount() {
      let count = 0;
      for (const s of sessions.values()) {
        if (s.active) count++;
      }
      return count;
    },

    /**
     * 获取总数
     */
    getTotalCount() {
      return sessions.size;
    },

    /**
     * 导出所有 session 状态（用于持久化）
     */
    exportState() {
      const data = [];
      for (const [apiKey, s] of sessions) {
        data.push({
          apiKey,
          handshakeId: s.handshakeId,
          userWallet: s.userWallet,
          providerWallet: s.providerWallet,
          escrowAmount: s.escrowAmount.toString(),
          cumulativeSpent: s.cumulativeSpent.toString(),
          latestCredentialHash: s.latestCredentialHash,
          latestCredentialRound: s.latestCredentialRound ?? s.credentialChain.latestCredentialRound ?? 0,
          // Legacy persisted aliases retained so older User/Gateway builds can still read fresh reseller state.
          latestReceiptHash: s.latestCredentialHash,
          latestReceiptRound: s.latestCredentialRound ?? s.credentialChain.latestCredentialRound ?? 0,
          modelHash: s.modelHash,
          pricingPolicyHash: s.pricingPolicyHash,
          tokenizerHash: s.tokenizerHash,
          inputTokenPrice: s.inputTokenPrice?.toString?.() ?? "0",
          outputTokenPrice: s.outputTokenPrice?.toString?.() ?? "0",
          latestCredential: s.latestCredential ?? null,
          latestUserCredential: s.latestUserCredential ?? null,
          latestUserCredentialSignature: s.latestUserCredentialSignature ?? null,
          latestReceipt: s.latestCredential ?? null,
          providerUpdate: s.providerUpdate ?? null,
          credentialChain: s.credentialChain.snapshot(),
          modelScope: s.modelScope,
          active: s.active,
          createdAt: s.createdAt,
          expiresAt: s.expiresAt,
        });
      }
      return data;
    },

    /**
     * 导入 session 状态（从持久化恢复）
     */
    importState(data) {
      for (const item of data) {
        const chainSnapshot = item.credentialChain ?? item.receiptChain ?? {};
        const session = {
          apiKey: item.apiKey,
          handshakeId: item.handshakeId,
          userWallet: item.userWallet,
          providerWallet: item.providerWallet,
          escrowAmount: BigInt(item.escrowAmount ?? "0"),
          cumulativeSpent: BigInt(item.cumulativeSpent ?? "0"),
          latestCredentialHash: item.latestCredentialHash ?? item.latestReceiptHash ?? chainSnapshot.latestCredentialHash ?? chainSnapshot.latestReceiptHash ?? ZERO_HASH,
          latestCredentialRound: Number(item.latestCredentialRound ?? item.latestReceiptRound ?? chainSnapshot.latestCredentialRound ?? chainSnapshot.latestReceiptRound ?? 0),
          modelHash: item.modelHash ?? null,
          pricingPolicyHash: item.pricingPolicyHash ?? null,
          tokenizerHash: item.tokenizerHash ?? null,
          inputTokenPrice: BigInt(item.inputTokenPrice ?? "0"),
          outputTokenPrice: BigInt(item.outputTokenPrice ?? "0"),
          latestCredential: sanitizeStoredCredential(item.latestCredential ?? item.latestReceipt),
          latestUserCredential: item.latestUserCredential ?? null,
          latestUserCredentialSignature: item.latestUserCredentialSignature ?? null,
          providerUpdate: item.providerUpdate ?? null,
          credentialChain: CredentialChain.fromSnapshot(chainSnapshot),
          modelScope: item.modelScope ?? null,
          active: item.active !== false,
          createdAt: item.createdAt ?? 0,
          expiresAt: item.expiresAt ?? null,
        };
        sessions.set(item.apiKey, session);
      }
    },
  };
}

function parseBearer(header) {
  if (!header) return null;
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function normalizeHash(value) {
  if (!value || value === "0x0") return ZERO_HASH;
  return value;
}

function sanitizeStoredCredential(value) {
  if (!value || typeof value !== "object") return null;
  if (!value.handshake_id || !value.metering_hash || value.cumulative_spent == null) return null;
  return value;
}

function maskApiKey(key) {
  const text = String(key ?? "");
  if (text.length <= 16) return text ? "***" : "";
  return `${text.slice(0, 10)}...${text.slice(-6)}`;
}
