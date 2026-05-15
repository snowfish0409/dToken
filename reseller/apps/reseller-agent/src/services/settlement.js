export function latestUserCredentialCumulative(session) {
  return BigInt(
    session.latestUserCredential?.cumulativeSpent
      ?? session.latestUserCredential?.cumulative_spent
      ?? session.credentialChain?.lastConfirmedCumulativeSpent
      ?? "0",
  );
}

export function hasLatestUserCredential(session) {
  return !!(
    (session?.latestCredential || session?.latestUserCredential)
    && session?.latestUserCredential
    && session?.latestUserCredentialSignature
  );
}

export async function providerSettleWithLatestCredential({
  contractClient,
  keyStore,
  session,
  persistSessions,
}) {
  if (!session?.active) return { settled: false, reason: "session_inactive" };

  if (contractClient.mode === "local") {
    const result = await contractClient.providerSettle(session.handshakeId);
    keyStore.deactivateSession(session.apiKey);
    persistSessions?.();
    return { settled: true, result };
  }

  if (!hasLatestUserCredential(session)) {
    return { settled: false, reason: "missing_latest_user_credential" };
  }

  const result = await contractClient.providerSettleWithUserSettlement(
    session.latestUserCredential,
    session.latestUserCredentialSignature,
    session.providerUpdate,
  );
  keyStore.deactivateSession(session.apiKey);
  persistSessions?.();
  return {
    settled: true,
    result,
    cumulativeSpent: latestUserCredentialCumulative(session).toString(),
    credentialHash: session.latestCredentialHash,
    round: session.latestUserCredential?.round ?? session.latestCredentialRound ?? 0,
  };
}
