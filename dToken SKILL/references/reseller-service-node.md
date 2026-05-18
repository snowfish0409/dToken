# Reseller / Provider Service Node

## Purpose

The Reseller is the Provider-side service node:

```text
User App / Agent Gateway -> Reseller -> Authorized Model Endpoint
```

It verifies on-chain handshakes, issues dToken API keys, routes requests to configured upstream model services, records usage, stores User-signed credentials, and handles Provider-side settlement work.

For usage and spend monitoring, the Reseller is the Provider-side source for per-handshake usage ledger, latest cumulative spend, issued API key state, upstream usage, and settlement-ready credentials. See `usage-monitoring.md` for operator thresholds and alert rules.

## Important Files

Common layout:

```text
reseller/
  .env.example
  package.json
  scripts/
    check-provider-config.mjs
    check-upstreams.mjs
    pm2-start.sh
    pm2-restart-env.sh
  apps/reseller-agent/
    config/production.template.json
  smart-contracts/deployments/mainnet-dtoken-v0.json
```

Private files that must not be committed:

```text
.env
config/production.json
data/
node_modules/
deployment backups
```

## Required Inputs

Use placeholders in docs and examples:

```bash
DTOKEN_PROVIDER_CONFIG=./config/production.json
DTOKEN_PUBLIC_BASE_URL=https://YOUR_DOMAIN/v1
DTOKEN_PORT=8788
DTOKEN_CONTRACT_RPC=https://ethereum-rpc.publicnode.com
DTOKEN_PROVIDER_WALLET=0xYourProviderWallet
DTOKEN_PROVIDER_PRIVATE_KEY=0xYourProviderPrivateKey
DTOKEN_SERVICE_SIGNER_ADDRESS=0xYourServiceSigner
DTOKEN_SERVICE_SIGNER_KEY=0xYourServiceSignerPrivateKey
DTOKEN_UPSTREAM_QWEN_KEY=sk-sp-your-token-plan-key
```

The first deployment may reuse the Provider wallet as the service signer. For stronger production separation, use a different service signer, while keeping the Provider wallet as the on-chain announcing and settlement wallet.

## Configuration Flow

1. Install dependencies.
2. Copy `.env.example` to `.env`.
3. Copy `apps/reseller-agent/config/production.template.json` to `config/production.json`.
4. Fill `.env` with RPC, wallet, signer, and upstream API keys.
5. Fill `production.json` with public URL, Provider identity, upstreams, and models.
6. Run:

```bash
npm run config:check
npm run upstream:check
```

7. Start locally:

```bash
npm run reseller:serve
```

8. Check:

```bash
curl http://127.0.0.1:8788/health
curl http://127.0.0.1:8788/v1/models
```

9. Start production with pm2:

```bash
npm run pm2:start
pm2 logs dtoken-reseller
```

After changing `.env`, use:

```bash
npm run pm2:restart
```

## Fresh Server Deployment

When replacing an old deployment and the user explicitly asks for a clean server:

```bash
pm2 delete dtoken >/dev/null 2>&1 || true
pm2 delete dtoken-reseller >/dev/null 2>&1 || true
pm2 save --force
rm -rf /opt/dtoken
mkdir -p /opt/dtoken
```

Only delete old `data/` if the user understands there may be active handshakes, API keys, sessions, or settlement credentials inside.

## Production Endpoint

For production, expose HTTPS with Nginx or Caddy and forward to:

```text
http://127.0.0.1:8788
```

`DTOKEN_PUBLIC_BASE_URL` must be the public `/v1` URL copied into Provider Console. HTTP can be used for short smoke tests, but HTTPS is recommended because User traffic and dToken API keys pass through this endpoint.

## Checks Before On-Chain Announcement

Do not announce a model until:

- `npm run config:check` passes
- `npm run upstream:check` passes
- `/health` is healthy enough for the target upstream
- `/v1/models` lists the model exactly as intended
- Provider Console fields are copied from `/v1/models`
