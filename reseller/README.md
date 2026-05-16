# dToken Provider Service Node

The dToken Provider Service Node is the Provider-side gateway for serving LLM access through dToken.

```text
User App / Agent Gateway -> Provider Service Node -> Authorized Model Endpoint
```

It verifies on-chain dToken handshakes, issues dToken API keys, routes requests through configured upstream adapters, records returned token usage, maintains User-signed off-chain settlement credentials, and performs Provider-side settlement when required.

## Mainnet Contracts

- dToken ERC20: `0x28219c4417d6095C66a04940D84cba13075b768b`
- Protocol Proxy: `0xc706bd1f6F1457A8953241aF64F93bd5406d751B`
- Chain: Ethereum mainnet
- Chain ID: `1`

## Requirements

- Linux server or VPS
- Node.js 20 or newer
- npm
- pm2 for production
- Public IP or domain
- HTTPS reverse proxy for production, such as Nginx or Caddy
- Ethereum mainnet RPC
- Dedicated Provider wallet with ETH for gas
- At least one upstream model API key

## Important Files

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
    src/backends/qwenCodingPlan.js
    src/
  smart-contracts/deployments/mainnet-dtoken-v0.json
```

Private runtime files are intentionally not included:

```text
.env
config/production.json
data/
node_modules/
```

Never commit `.env`, private keys, upstream API keys, `data/`, or deployment backups.

## Quick Start

```bash
npm install

cp .env.example .env
mkdir -p config
cp apps/reseller-agent/config/production.template.json config/production.json
```

Edit `.env`:

```bash
DTOKEN_PROVIDER_CONFIG=./config/production.json
DTOKEN_PUBLIC_BASE_URL=http://YOUR_SERVER_IP_OR_DOMAIN:8788/v1
DTOKEN_PORT=8788

DTOKEN_CONTRACT_RPC=https://ethereum-rpc.publicnode.com

DTOKEN_PROVIDER_WALLET=0xYourProviderWallet
DTOKEN_PROVIDER_PRIVATE_KEY=0xYourProviderPrivateKey

DTOKEN_SERVICE_SIGNER_ADDRESS=0xYourProviderWallet
DTOKEN_SERVICE_SIGNER_KEY=0xYourProviderPrivateKey

DTOKEN_UPSTREAM_QWEN_KEY=sk-sp-your-token-plan-key
```

The first deployment may reuse the Provider wallet as the service signer. For production hardening, a separate service signer wallet is possible, but the Provider wallet must remain the wallet used for on-chain model announcement and settlement.

## Qwen Token Plan Adapter

Qwen Token Plan is handled by the existing adapter:

```text
type: qwen_coding_plan
file: apps/reseller-agent/src/backends/qwenCodingPlan.js
```

The production template already contains the adapter entry:

```json
{
  "id": "qwen",
  "company": "qwen",
  "type": "qwen_coding_plan",
  "baseUrl": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  "healthModel": "qwen3.6-plus",
  "apiKey": "${DTOKEN_UPSTREAM_QWEN_KEY}",
  "optional": true,
  "timeoutMs": 90000
}
```

The adapter probes Qwen through:

```text
POST /chat/completions
```

It does not rely on a generic `/models` probe because the Token Plan endpoint may not behave like standard OpenAI `/models`.

The default `reference-v1` catalog includes:

```text
model: qwen3.6-plus
upstream: qwen
upstreamModel: qwen3.6-plus
contextLength: 1048576
capabilities: chat, vision, image, video, multimodal, reasoning
inputTokenPrice: 1000000 dToken / token
outputTokenPrice: 3000000 dToken / token
```

If you need different prices, override the catalog model by adding a model with the same `displayName` under `models` in `config/production.json`.

## Preflight Checks

Run these before starting pm2 or announcing on-chain:

```bash
npm run config:check
npm run upstream:check
```

`npm run config:check` verifies:

- JSON and environment variables load correctly.
- Provider wallet and service signer are valid addresses.
- Private keys derive the configured addresses.
- model, upstream, price, and public endpoint are coherent.

`npm run upstream:check` verifies upstream health through the configured adapters. For Qwen Token Plan, this uses `qwen_coding_plan` and checks that `/chat/completions` returns success.

Do not announce a model on-chain until both checks pass.

## Start Locally

```bash
npm run reseller:serve
```

Then check:

```bash
curl http://127.0.0.1:8788/health
curl http://127.0.0.1:8788/v1/models
```

Expected `/health` shape:

```json
{
  "ok": true,
  "network": "mainnet",
  "contract": { "connected": true, "signerReady": true },
  "upstreams": { "qwen": { "ok": true } },
  "degradedUpstreams": {}
}
```

## Start With pm2

Use the bundled scripts so pm2 loads the current `.env` correctly:

```bash
npm run pm2:start
pm2 logs dtoken-reseller
```

After changing `.env`, reload pm2 with:

```bash
npm run pm2:restart
```

This avoids the common failure where `.env` has been edited but the pm2 process still runs with stale environment variables.

## Public Endpoint

For production, expose HTTPS and forward it to:

```text
http://127.0.0.1:8788
```

`DTOKEN_PUBLIC_BASE_URL` must be the public `/v1` endpoint that Users will receive, for example:

```text
https://api.your-domain.example/v1
```

HTTP can work for a short smoke test, but HTTPS is recommended for production because User traffic and dToken API keys pass through this endpoint.

## Provider Console Announcement

Copy values from:

```bash
curl http://YOUR_SERVER_IP_OR_DOMAIN:8788/v1/models
```

For the default Qwen Token Plan catalog entry, Provider Console should use:

| Provider Console field | Value |
| --- | --- |
| Model ID | `qwen3.6-plus` |
| Model Display Name | `qwen3.6-plus` |
| Public API Endpoint | `http://YOUR_SERVER_IP_OR_DOMAIN:8788/v1` or your HTTPS `/v1` URL |
| Input Token Price | `1000000` |
| Output Token Price | `3000000` |
| Minimum Escrow | `100000000000` |
| Provider Wallet | `DTOKEN_PROVIDER_WALLET` |

The on-chain model announcement must match the Provider service node configuration exactly. A different model name, price, wallet, or endpoint can make the announcement unusable.

## Fresh Server Deployment

If replacing an old dToken deployment, do not reuse old runtime state unless you intentionally need it.

Recommended clean deployment flow:

```bash
pm2 delete dtoken >/dev/null 2>&1 || true
pm2 delete dtoken-reseller >/dev/null 2>&1 || true
pm2 save --force

rm -rf /opt/dtoken
mkdir -p /opt/dtoken
```

Then upload this `reseller` directory to `/opt/dtoken`, fill `.env`, run preflight checks, and start with `npm run pm2:start`.

Only delete old `data/` if you are sure there are no active handshakes or settlement credentials you still need.

## Troubleshooting

### `/health` is false but `/v1/models` works

`/v1/models` only means the local model catalog is configured. It does not prove the upstream API key works. Run:

```bash
npm run upstream:check
```

### Qwen returns `invalid_api_key`

Check that:

- You copied the full Token Plan API key from the console.
- You are using the Token Plan Base URL through `qwen_coding_plan`.
- The key was not reset, disabled, expired, or copied with missing characters.
- pm2 has been restarted with the current `.env` using `npm run pm2:restart`.

The Qwen adapter reports `errorCode`, `errorMessage`, and `requestId` in health details when the upstream rejects a request.

### Provider address is `0x000...` in `/v1/models`

Environment variables were not loaded correctly. Run:

```bash
npm run config:check
```

Then restart pm2 with:

```bash
npm run pm2:restart
```

### `No configured reseller model matches`

The on-chain announcement does not match local Reseller configuration. Compare:

- model ID / display name
- endpoint
- input price
- output price
- Provider wallet

### `/health` says `No contract code`

The RPC is probably on the wrong network or the contract address is wrong. Check:

```bash
DTOKEN_CONTRACT_RPC
DTOKEN_CONTRACT_ADDRESS
DTOKEN_PROTOCOL_ADDRESS
DTOKEN_TOKEN_ADDRESS
```

## Security Notes

- Use a dedicated Provider wallet.
- Keep only necessary ETH in the Provider wallet.
- Do not paste private keys into public chats, tickets, commits, or logs.
- Back up `data/` only if you understand it contains active API keys, sessions, and settlement credentials.
- Use HTTPS in production.
- Restrict SSH access.
- Rotate leaked Provider private keys or upstream API keys immediately.
