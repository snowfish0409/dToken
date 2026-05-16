import fs from "node:fs";
import path from "node:path";

loadDotEnv(path.resolve(process.cwd(), ".env"));

const { loadConfig, validateConfig } = await import("../apps/reseller-agent/src/config.js");
const { createUpstreamRouter } = await import("../apps/reseller-agent/src/services/upstream.js");

const config = loadConfig();
const configErrors = validateConfig(config);
if (configErrors.length) {
  console.error(JSON.stringify({ ok: false, phase: "config", errors: configErrors }, null, 2));
  process.exit(1);
}

const router = createUpstreamRouter(config);
const startedAt = Date.now();
const upstreams = await router.healthAll();
const degradedUpstreams = Object.fromEntries(
  Object.entries(upstreams).filter(([, result]) => !result?.ok),
);

const result = {
  ok: Object.keys(degradedUpstreams).length === 0,
  latencyMs: Date.now() - startedAt,
  upstreams,
  degradedUpstreams,
};

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, valueRaw] = match;
    let value = valueRaw.trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
