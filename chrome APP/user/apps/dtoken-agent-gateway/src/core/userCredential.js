import { ethers } from "ethers";
import { providerPath } from "./profileStore.js";

export async function signAndSubmitUserCredential(profile, dtokenPayload) {
  const credential = dtokenPayload?.credential;
  if (!credential?.credential_hash) {
    const error = new Error("Provider response did not include a signable dToken credential");
    error.code = "credential_missing";
    throw error;
  }

  const wallet = new ethers.Wallet(profile.dtoken.sessionSigner.privateKey);
  const normalizedCredential = {
    handshake_id: credential.handshake_id || profile.dtoken.handshakeId,
    round: Number(credential.round || 0),
    model: credential.model,
    model_hash: credential.model_hash,
    pricing_policy_hash: credential.pricing_policy_hash,
    tokenizer_hash: credential.tokenizer_hash,
    user_wallet: credential.user_wallet,
    input_token_count: Number(credential.input_token_count || 0),
    output_token_count: Number(credential.output_token_count || 0),
    input_token_price: String(credential.input_token_price || "0"),
    output_token_price: String(credential.output_token_price || "0"),
    round_cost: String(credential.round_cost || "0"),
    cumulative_spent: String(credential.cumulative_spent || dtokenPayload.cumulative_spent || "0"),
    previous_credential_hash: credential.previous_credential_hash,
    metering_hash: credential.metering_hash,
    signed_at: Number(credential.signed_at || Math.floor(Date.now() / 1000)),
    chain_id: Number(credential.chain_id || profile.dtoken.chainId || 1),
    contract_address: credential.contract_address || profile.dtoken.contractAddress,
  };
  const settlementValue = {
    handshakeId: normalizedCredential.handshake_id,
    cumulativeSpent: normalizedCredential.cumulative_spent,
    meteringHash: normalizedCredential.metering_hash,
    signedAt: normalizedCredential.signed_at,
  };
  const domain = {
    name: "dToken",
    version: String(profile.dtoken.signingVersion || "0"),
    chainId: Number(profile.dtoken.chainId || 1),
    verifyingContract: profile.dtoken.contractAddress,
  };
  const types = {
    UserDTokenSettlement: [
      { name: "handshakeId", type: "bytes32" },
      { name: "cumulativeSpent", type: "uint256" },
      { name: "meteringHash", type: "bytes32" },
      { name: "signedAt", type: "uint64" },
    ],
  };

  const signature = await wallet.signTypedData(domain, types, settlementValue);
  const response = await fetch(providerPath(profile, "/dtoken/credential-signature"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${profile.dtoken.apiKey}`,
    },
    body: JSON.stringify({ credential: normalizedCredential, signature }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error?.message || `User credential submit failed with HTTP ${response.status}`);
    error.code = body?.error?.code || "credential_submit_failed";
    error.statusCode = response.status;
    throw error;
  }

  return {
    credential: normalizedCredential,
    credentialRound: normalizedCredential.round,
    cumulativeSpent: normalizedCredential.cumulative_spent,
    signature,
    acknowledged: true,
    providerResponse: body,
  };
}
