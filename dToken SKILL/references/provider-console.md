# Provider Console

## Purpose

Provider Console is the Provider wallet's browser-based on-chain tool. It is used to:

- connect/disconnect a browser wallet
- announce model offers on-chain
- update or delist model offers
- scan `ProviderAnnounced` events through wallet RPC
- inspect handshakes involving the connected Provider wallet
- display open and settled handshakes
- show dToken/ETH and optional ETH/USD reference pricing

It does not manage upstream API keys, Reseller private config, User chat history, or Agent Gateway profiles.

## Startup

Classic webpage:

```bash
cd "provider console"
npm install
npm run serve
```

Open:

```text
http://127.0.0.1:8792/
```

Desktop-style package when available:

```bash
cd provider-console
npm run start
```

## Wallet Requirements

Use a Chrome browser extension wallet such as MetaMask, OKX Web3, or Phantom EVM mode. The console depends on wallet RPC and extension injection.

Use the normal browser-wallet flow; do not paste Provider private keys into the console.

## Announcing a Model

Before on-chain announcement, get model data from the live Reseller:

```bash
curl http://YOUR_ENDPOINT:8788/v1/models
```

Copy exact fields into Provider Console:

- model ID / display name
- public API endpoint ending in `/v1`
- input dToken/token price
- output dToken/token price
- minimum escrow
- Provider wallet
- capability and metadata fields if the UI exposes them

Exact matching matters. A different character in model ID, endpoint, wallet, or price can create an unusable announcement that does not match the service node.

## Public API Endpoint Field

The Provider Console public endpoint is the URL Users receive for model access. It should usually be:

```text
https://YOUR_DOMAIN/v1
```

or for smoke tests:

```text
http://YOUR_SERVER_IP:8788/v1
```

This is not the upstream model vendor URL. It is the Provider/Reseller service node public `/v1` URL.

## Price Fields

Provider Console prices are dToken per model token, not USD and not wei.

Known working example values:

```text
inputTokenPrice: 100000
outputTokenPrice: 300000
minimumEscrow: 10000000000
```

These are examples, not a universal default. Use values returned by the current Reseller config or requested by the user.

## Chain Operations

Provider Console calls the dToken protocol through the connected wallet. Expect wallet prompts for transactions such as model announcement, update, or delisting. Use Ethereum mainnet unless explicitly working on a fork.
