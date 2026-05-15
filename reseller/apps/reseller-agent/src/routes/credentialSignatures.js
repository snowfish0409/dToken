import { readJson, sendError, sendJson } from "../http.js";
import { providerSettleWithLatestCredential } from "../services/settlement.js";

export async function handleCredentialSignature({
  keyStore,
  contractClient,
  persistSessions,
  request,
  response,
}) {
  const session = keyStore.authenticate(request.headers.authorization);
  if (!session) {
    sendError(response, 401, "invalid_api_key", "Invalid or missing dToken API key");
    return;
  }
  if (!session.active) {
    sendError(response, 403, "session_closed", "This dToken session has been closed");
    return;
  }

  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    sendError(response, error.statusCode ?? 400, error.code ?? "invalid_request", error.message);
    return;
  }

  const credential = normalizeCredential(body?.credential);
  const signature = body?.signature;
  if (!credential || !signature) {
    sendError(response, 400, "missing_user_credential", "credential and signature are required");
    return;
  }

  if (credential.handshake_id !== session.handshakeId) {
    sendError(response, 403, "handshake_mismatch", "Credential handshake does not match this API key");
    return;
  }
  if (!session.latestCredential) {
    sendError(response, 409, "missing_pending_credential", "No dToken credential is waiting for user signature");
    return;
  }
  if (!sameCredentialPayload(credential, normalizeCredential(session.latestCredential))) {
    sendError(response, 409, "credential_not_latest", "User credential must match the latest dToken credential payload");
    return;
  }

  try {
    const verified = await contractClient.verifyUserCredential(credential, signature);
    if (!verified) {
      sendError(response, 401, "invalid_user_credential_signature", "User credential signature is not valid for this handshake");
      return;
    }
  } catch (error) {
    sendError(response, 502, "credential_verify_failed", `Could not verify user credential: ${error.message}`);
    return;
  }

  keyStore.recordUserCredential(session, credential, signature);
  persistSessions?.();

  let autoSettlement = null;
  if (BigInt(credential.cumulative_spent) >= BigInt(session.escrowAmount ?? "0")) {
    try {
      autoSettlement = await providerSettleWithLatestCredential({
        contractClient,
        keyStore,
        session,
        persistSessions,
      });
    } catch (error) {
      autoSettlement = { settled: false, reason: error.message };
    }
  }

  sendJson(response, 200, {
    acknowledged: true,
    handshakeId: credential.handshake_id,
    credentialHash: session.latestCredentialHash,
    round: credential.round,
    cumulativeSpent: credential.cumulative_spent,
    autoSettlement,
  });
}

function normalizeCredential(credential) {
  if (!credential || typeof credential !== "object") return null;
  return {
    protocol_version: String(credential.protocol_version ?? "0"),
    handshake_id: credential.handshake_id ?? credential.handshakeId,
    round: Number(credential.round ?? 0),
    model: credential.model,
    model_hash: credential.model_hash ?? credential.modelHash,
    pricing_policy_hash: credential.pricing_policy_hash ?? credential.pricingPolicyHash,
    tokenizer_hash: credential.tokenizer_hash ?? credential.tokenizerHash,
    user_wallet: credential.user_wallet ?? credential.userWallet,
    input_token_count: Number(credential.input_token_count ?? credential.inputTokenCount ?? 0),
    output_token_count: Number(credential.output_token_count ?? credential.outputTokenCount ?? 0),
    input_token_price: String(credential.input_token_price ?? credential.inputTokenPrice ?? "0"),
    output_token_price: String(credential.output_token_price ?? credential.outputTokenPrice ?? "0"),
    round_cost: String(credential.round_cost ?? credential.roundCost ?? "0"),
    cumulative_spent: String(credential.cumulative_spent ?? credential.cumulativeSpent ?? "0"),
    previous_credential_hash: credential.previous_credential_hash ?? credential.previousCredentialHash ?? normalizeHash(null),
    metering_hash: credential.metering_hash ?? credential.meteringHash,
    signed_at: Number(credential.signed_at ?? credential.signedAt ?? Math.floor(Date.now() / 1000)),
    chain_id: Number(credential.chain_id ?? credential.chainId ?? 0),
    contract_address: credential.contract_address ?? credential.contractAddress,
  };
}

function normalizeHash(value) {
  if (!value || value === "0x0") return "0x" + "00".repeat(32);
  return value;
}

function sameCredentialPayload(a, b) {
  if (!a || !b) return false;
  const exact = [
    "handshake_id",
    "round",
    "model_hash",
    "pricing_policy_hash",
    "tokenizer_hash",
    "input_token_count",
    "output_token_count",
    "input_token_price",
    "output_token_price",
    "round_cost",
    "cumulative_spent",
    "metering_hash",
    "signed_at",
    "chain_id",
  ];
  for (const key of exact) {
    if (String(a[key] ?? "") !== String(b[key] ?? "")) return false;
  }
  if (String(a.contract_address ?? "").toLowerCase() !== String(b.contract_address ?? "").toLowerCase()) return false;
  if (normalizeHash(a.previous_credential_hash).toLowerCase() !== normalizeHash(b.previous_credential_hash).toLowerCase()) return false;
  return true;
}
