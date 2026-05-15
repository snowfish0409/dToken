import { readJson, sendError, sendJson } from "../http.js";
import { redactProfile } from "../core/profileStore.js";

export async function handleAdminRoutes({
  config,
  profileStore,
  queue,
  ledger,
  userState,
  request,
  response,
  pathname,
}) {
  if (request.method === "GET" && pathname === "/admin/status") {
    sendJson(response, 200, statusBody({ config, profileStore, queue, ledger, userState }));
    return true;
  }

  if (request.method === "GET" && pathname === "/admin/ledger") {
    sendJson(response, 200, {
      summary: ledger.summary(),
      recent: ledger.recent(50),
    });
    return true;
  }

  if (request.method === "GET" && pathname === "/admin/user-state") {
    sendJson(response, 200, {
      state: userState.load(),
      path: userState.getPath(),
    });
    return true;
  }

  if (request.method === "PUT" && pathname === "/admin/user-state") {
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      sendError(response, error.statusCode ?? 400, error.code ?? "invalid_request", error.message);
      return true;
    }
    try {
      const saved = userState.save(body?.state ?? body ?? {});
      sendJson(response, 200, {
        saved: true,
        path: userState.getPath(),
        savedAt: saved.savedAt,
      });
    } catch (error) {
      sendError(response, 400, "invalid_user_state", error.message);
    }
    return true;
  }

  if (request.method === "GET" && pathname === "/admin/full-state") {
    sendJson(response, 200, {
      format: "dtoken-user-local-service-state",
      version: 1,
      exportedAt: new Date().toISOString(),
      userState: userState.load(),
      profiles: profileStore.exportData?.() ?? { profiles: profileStore.list() },
      ledger: ledger.exportData?.() ?? { summary: ledger.summary(), records: ledger.recent(1000).reverse() },
    });
    return true;
  }

  if (request.method === "PUT" && pathname === "/admin/full-state") {
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      sendError(response, error.statusCode ?? 400, error.code ?? "invalid_request", error.message);
      return true;
    }
    try {
      const savedUserState = userState.save(body?.userState ?? body?.state ?? {});
      const savedProfiles = body?.profiles ? profileStore.importData?.(body.profiles) : profileStore.exportData?.();
      const savedLedger = body?.ledger ? ledger.importData?.(body.ledger) : ledger.exportData?.();
      sendJson(response, 200, {
        imported: true,
        savedAt: savedUserState.savedAt,
        userStatePath: userState.getPath(),
        profilePath: profileStore.getPath(),
        profiles: savedProfiles?.profiles?.length ?? profileStore.list().length,
        ledgerRecords: savedLedger?.records?.length ?? ledger.recent(1000).length,
      });
    } catch (error) {
      sendError(response, 400, "invalid_full_state", error.message);
    }
    return true;
  }

  const credentialMatch = pathname.match(/^\/admin\/handshakes\/([^/]+)\/latest-(?:credential|receipt)$/);
  if (request.method === "GET" && credentialMatch) {
    const handshakeId = String(credentialMatch[1] ?? "").toLowerCase();
    const item = ledger.handshakeSummary(handshakeId);
    const credential = item.latestReceipt;
    if (!credential) {
      sendError(response, 404, "credential_not_found", "No Agent Gateway credential is available for this handshake");
      return true;
    }
    sendJson(response, 200, {
      handshakeId: item.handshakeId || handshakeId,
      credential,
      credentialHash: item.latestReceiptHash || credential.credential_hash || "",
      userCredentialSignature: item.latestUserCredentialSignature || "",
      credentialRound: item.latestReceiptRound || credential.round || 0,
      cumulativeSpent: item.cumulativeSpent || credential.cumulative_spent || "0",
      lastAckedSpent: item.lastAckedSpent || item.cumulativeSpent || credential.cumulative_spent || "0",
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/admin/profile") {
    if (!config.gateway.allowProfileInstall) {
      sendError(response, 403, "profile_install_disabled", "Profile installation is disabled");
      return true;
    }
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      sendError(response, error.statusCode ?? 400, error.code ?? "invalid_request", error.message);
      return true;
    }
    const incomingProfile = body?.profile ?? body;
    try {
      const profile = profileStore.save(incomingProfile);
      sendJson(response, 200, {
        installed: true,
        profile: redactProfile(profile),
        status: statusBody({ config, profileStore, queue, ledger, userState }),
      });
    } catch (error) {
      sendError(response, 400, "invalid_profile", error.message);
    }
    return true;
  }

  const profileDeleteMatch = pathname.match(/^\/admin\/profiles?\/([^/]+)$/);
  if (request.method === "DELETE" && profileDeleteMatch) {
    const handshakeId = String(profileDeleteMatch[1] ?? "");
    const removed = profileStore.remove(handshakeId);
    sendJson(response, 200, {
      removed,
      handshakeId,
      status: statusBody({ config, profileStore, queue, ledger, userState }),
    });
    return true;
  }

  return false;
}

function statusBody({ config, profileStore, queue, ledger, userState }) {
  return {
    service: "dtoken-user",
    phase: config.gateway.phase,
    baseUrl: config.publicBaseUrl,
    profilePath: profileStore.getPath(),
    userStatePath: userState?.getPath?.() ?? "",
    profileLoaded: profileStore.list().length > 0,
    profile: redactProfile(profileStore.get()),
    profiles: profileStore.list().map(redactProfile),
    ledger: ledger.summary(),
    queues: queue.snapshot(),
    compatibility: config.compatibility,
  };
}
