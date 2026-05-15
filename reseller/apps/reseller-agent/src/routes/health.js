/**
 * GET /health — 健康检查
 */

import { sendJson } from "../http.js";

export async function handleHealth({ config, upstreamRouter, contractClient, startTime, response }) {
  const upstreamHealth = await upstreamRouter.healthAll();
  const contractHealth = await contractClient.health();

  const requiredIds = new Set((config.upstreams ?? [])
    .filter((upstream) => upstream.optional !== true)
    .map((upstream) => upstream.id));
  const requiredHealth = Object.entries(upstreamHealth)
    .filter(([id]) => requiredIds.has(id))
    .map(([, health]) => health);
  const allRequiredUpstreamsOk = requiredHealth.length
    ? requiredHealth.every((h) => h.ok)
    : Object.values(upstreamHealth).some((h) => h.ok);
  const degradedUpstreams = Object.fromEntries(
    Object.entries(upstreamHealth).filter(([, health]) => !health.ok),
  );

  sendJson(response, allRequiredUpstreamsOk ? 200 : 503, {
    ok: allRequiredUpstreamsOk && contractHealth.connected,
    service: "dtoken-reseller-agent",
    provider: config.provider.name,
    version: "1.0.0",
    network: config.contract.network,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    contract: contractHealth,
    upstreams: upstreamHealth,
    degradedUpstreams,
  });
}
