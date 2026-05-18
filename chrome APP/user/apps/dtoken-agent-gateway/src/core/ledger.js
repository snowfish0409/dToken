import fs from "node:fs";
import path from "node:path";

export function createGatewayLedger(config) {
  const recordsPath = path.join(config.dataPath, "gateway-ledger.jsonl");
  const statePath = path.join(config.dataPath, "gateway-state.json");
  let state = {
    calls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    latestReceiptRound: 0,
    latestReceiptHash: "",
    handshakeId: "",
    cumulativeSpent: "0",
    lastAckedSpent: "0",
    lastRequestAt: null,
    lastError: null,
    byHandshake: {},
  };

  try {
    if (fs.existsSync(statePath)) {
      state = { ...state, ...JSON.parse(fs.readFileSync(statePath, "utf8")) };
    }
    if (!state.handshakeId || !state.byHandshake || !Object.keys(state.byHandshake).length) {
      state = { ...state, ...inferStateFromRecords(recordsPath) };
    }
  } catch {
    // Local dashboard state is informational only.
  }
  state = sanitizeCredentialState(state);

  function record(entry) {
    fs.mkdirSync(config.dataPath, { recursive: true });
    const normalized = {
      ts: new Date().toISOString(),
      ...entry,
    };
    fs.appendFileSync(recordsPath, `${JSON.stringify(normalized)}\n`, "utf8");
    state.calls += 1;
    state.lastRequestAt = normalized.ts;
    if (entry.ok === false) {
      state.failedCalls += 1;
      state.lastError = entry.error ?? "unknown";
    } else {
      state.successfulCalls += 1;
      state.lastError = null;
    }
    if (entry.credentialRound != null || entry.receiptRound != null) state.latestReceiptRound = Number(entry.credentialRound ?? entry.receiptRound);
    if (entry.credentialHash || entry.receiptHash) state.latestReceiptHash = entry.credentialHash || entry.receiptHash;
    if (entry.handshakeId) state.handshakeId = String(entry.handshakeId);
    if (entry.cumulativeSpent != null) state.cumulativeSpent = String(entry.cumulativeSpent);
    if (entry.acknowledgedSpent != null) state.lastAckedSpent = String(entry.acknowledgedSpent);
    updateHandshakeState(entry);
    persist();
  }

  function updateHandshakeState(entry) {
    if (!entry.handshakeId) return;
    const hid = String(entry.handshakeId).toLowerCase();
    const prev = state.byHandshake?.[hid] ?? {};
    state.byHandshake = {
      ...(state.byHandshake ?? {}),
      [hid]: {
        calls: Number(prev.calls || 0) + 1,
        successfulCalls: Number(prev.successfulCalls || 0) + (entry.ok === false ? 0 : 1),
        failedCalls: Number(prev.failedCalls || 0) + (entry.ok === false ? 1 : 0),
        latestReceiptRound: entry.credentialRound != null || entry.receiptRound != null ? Number(entry.credentialRound ?? entry.receiptRound) : Number(prev.latestReceiptRound || 0),
        latestReceiptHash: entry.credentialHash || entry.receiptHash || prev.latestReceiptHash || "",
        latestReceipt: entry.credential || entry.receipt || prev.latestReceipt || null,
        latestUserCredentialSignature: entry.userCredentialSignature || entry.user_credential_signature || prev.latestUserCredentialSignature || "",
        handshakeId: hid,
        cumulativeSpent: entry.cumulativeSpent != null ? String(entry.cumulativeSpent) : String(prev.cumulativeSpent || "0"),
        lastAckedSpent: entry.acknowledgedSpent != null ? String(entry.acknowledgedSpent) : String(prev.lastAckedSpent || "0"),
        lastRequestAt: state.lastRequestAt,
        lastError: entry.ok === false ? (entry.error ?? "unknown") : null,
      },
    };
  }

  function persist() {
    fs.mkdirSync(config.dataPath, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
  }

  function summary() {
    return { ...state };
  }

  function handshakeSummary(handshakeId) {
    const hid = String(handshakeId ?? "").toLowerCase();
    return state.byHandshake?.[hid] ?? {
      calls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      latestReceiptRound: 0,
      latestReceiptHash: "",
      latestReceipt: null,
      latestUserCredentialSignature: "",
      handshakeId: hid,
      cumulativeSpent: "0",
      lastAckedSpent: "0",
      lastRequestAt: null,
      lastError: null,
    };
  }

  function recent(limit = 30) {
    try {
      if (!fs.existsSync(recordsPath)) return [];
      const lines = fs.readFileSync(recordsPath, "utf8").trim().split(/\n+/).filter(Boolean);
      return lines.slice(-limit).map((line) => JSON.parse(line)).reverse();
    } catch {
      return [];
    }
  }

  function records() {
    try {
      if (!fs.existsSync(recordsPath)) return [];
      return fs.readFileSync(recordsPath, "utf8").trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  function exportData() {
    return { summary: summary(), records: records() };
  }

  function importData(data = {}) {
    const importedRecords = Array.isArray(data.records) ? data.records : [];
    fs.mkdirSync(config.dataPath, { recursive: true });
    if (importedRecords.length) {
      fs.writeFileSync(recordsPath, importedRecords.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
      state = sanitizeCredentialState({ ...state, ...inferStateFromRecords(recordsPath) });
    } else if (Array.isArray(data.records)) {
      fs.writeFileSync(recordsPath, "", "utf8");
    }
    const importedState = data.summary || data.state;
    if (importedState && typeof importedState === "object") {
      state = sanitizeCredentialState({ ...state, ...importedState });
    }
    persist();
    return exportData();
  }

  return { record, summary, handshakeSummary, recent, records, exportData, importData };
}

function inferStateFromRecords(recordsPath) {
  try {
    if (!fs.existsSync(recordsPath)) return {};
    const lines = fs.readFileSync(recordsPath, "utf8").trim().split(/\n+/).filter(Boolean).reverse();
    const byHandshake = {};
    let latest = {};
    for (const line of lines) {
      const record = JSON.parse(line);
      if (!record?.handshakeId) continue;
      const hid = String(record.handshakeId).toLowerCase();
      if (!byHandshake[hid]) {
        byHandshake[hid] = {
          handshakeId: hid,
          latestReceiptRound: record.credentialRound != null || record.receiptRound != null ? Number(record.credentialRound ?? record.receiptRound) : 0,
          latestReceiptHash: record.credentialHash || record.receiptHash || "",
          latestReceipt: record.credential || record.receipt || null,
          latestUserCredentialSignature: record.userCredentialSignature || record.user_credential_signature || "",
          cumulativeSpent: record.cumulativeSpent != null ? String(record.cumulativeSpent) : "0",
          lastAckedSpent: record.acknowledgedSpent != null ? String(record.acknowledgedSpent) : "0",
        };
      }
      if (!latest.handshakeId) latest = {
        handshakeId: String(record.handshakeId),
        latestReceiptRound: record.credentialRound != null || record.receiptRound != null ? Number(record.credentialRound ?? record.receiptRound) : 0,
        latestReceiptHash: record.credentialHash || record.receiptHash || "",
        latestReceipt: record.credential || record.receipt || null,
        latestUserCredentialSignature: record.userCredentialSignature || record.user_credential_signature || "",
        cumulativeSpent: record.cumulativeSpent != null ? String(record.cumulativeSpent) : "0",
        lastAckedSpent: record.acknowledgedSpent != null ? String(record.acknowledgedSpent) : "0",
      };
    }
    return { ...latest, byHandshake };
  } catch {
    return {};
  }
  return {};
}

function sanitizeCredentialState(input = {}) {
  const state = { ...input, byHandshake: { ...(input.byHandshake ?? {}) } };
  state.latestReceipt = sanitizeCredential(state.latestReceipt);
  if (!state.latestReceipt) {
    state.latestReceiptHash = "";
    state.latestReceiptRound = 0;
  }
  for (const [hid, item] of Object.entries(state.byHandshake)) {
    const next = { ...item, latestReceipt: sanitizeCredential(item.latestReceipt) };
    if (!next.latestReceipt) {
      next.latestReceiptHash = "";
      next.latestReceiptRound = 0;
      next.latestUserCredentialSignature = "";
    }
    state.byHandshake[hid] = next;
  }
  return state;
}

function sanitizeCredential(value) {
  if (!value || typeof value !== "object") return null;
  if (!value.handshake_id || !value.metering_hash || value.cumulative_spent == null) return null;
  return value;
}
