export const DTOKEN_DECIMALS = 18;
export const DTOKEN_UNIT = 10n ** BigInt(DTOKEN_DECIMALS);

export function parseDTokenAmount(value, fieldName = "dToken amount") {
  const text = String(value ?? "").trim();
  if (!/^(?:\d+|\d+\.\d{0,18}|\.\d{1,18})$/.test(text)) {
    throw new Error(`${fieldName} must be a non-negative dToken amount with up to ${DTOKEN_DECIMALS} decimals`);
  }
  const [wholeRaw, fracRaw = ""] = text.split(".");
  const whole = BigInt(wholeRaw || "0");
  const frac = BigInt((fracRaw + "0".repeat(DTOKEN_DECIMALS)).slice(0, DTOKEN_DECIMALS) || "0");
  return whole * DTOKEN_UNIT + frac;
}

export function isDTokenAmount(value) {
  return /^(?:\d+|\d+\.\d{0,18}|\.\d{1,18})$/.test(String(value ?? "").trim());
}

export function formatDTokenAmount(value, maxFractionDigits = 6) {
  const raw = BigInt(value ?? 0);
  const sign = raw < 0n ? "-" : "";
  const abs = raw < 0n ? -raw : raw;
  const whole = abs / DTOKEN_UNIT;
  const frac = abs % DTOKEN_UNIT;
  if (frac === 0n || maxFractionDigits <= 0) return `${sign}${whole.toString()}`;
  const padded = frac.toString().padStart(DTOKEN_DECIMALS, "0");
  const visibleDigits = whole === 0n && padded.startsWith("0".repeat(maxFractionDigits))
    ? DTOKEN_DECIMALS
    : maxFractionDigits;
  const trimmed = padded.slice(0, visibleDigits).replace(/0+$/, "");
  return trimmed ? `${sign}${whole.toString()}.${trimmed}` : `${sign}${whole.toString()}`;
}

export function modelPricing(modelCfg) {
  return {
    inputTokenPrice: parseDTokenAmount(modelCfg?.pricing?.inputTokenPrice ?? "0", "inputTokenPrice"),
    outputTokenPrice: parseDTokenAmount(modelCfg?.pricing?.outputTokenPrice ?? "0", "outputTokenPrice"),
  };
}
