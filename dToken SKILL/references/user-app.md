# User App and Agent Gateway

## Purpose

The User app lets a wallet owner discover Provider offers, open a handshake, escrow dToken, obtain a dToken API key, chat with a selected model, and expose local agent-compatible endpoints.

It includes:

- User DApp and Chatbot
- local Agent Gateway
- local User state storage
- local credential ledger
- export/import migration flow

## Typical Startup

Local service:

```bash
cd user
npm install
npm run dtoken:user
```

Desktop-style package when available:

```bash
cd user
npm install
npm run start
```

Common local endpoints:

- UI: `http://127.0.0.1:8789/`
- OpenAI-compatible: `http://127.0.0.1:8789/v1`
- Anthropic-compatible: `http://127.0.0.1:8789/anthropic`

## Usage Flow

1. Connect MetaMask, OKX Web3, Phantom, or another EVM wallet in Chrome.
2. Confirm Ethereum mainnet.
3. Scan on-chain Provider announcements.
4. Select a Provider/model whose endpoint and prices match the Reseller model config.
5. Enter escrow amount with explicit unit.
6. Open handshake and sign wallet transaction.
7. Request API key from the Provider service node.
8. Bind the model to Chatbot or Agent Gateway.
9. Use model calls; watch dToken consumption and remaining escrow.
10. Exit/settle when finished.

## Usage And Remaining Balance

For active model use, monitor:

- selected model and Provider
- handshake escrow amount
- displayed Gateway consumption
- remaining dToken
- last successful model call
- last model/API error

For spend alerts and budget thresholds, use `references/usage-monitoring.md`.

## Escrow Units

When supporting escrow input, expose a clear unit selector:

- `1` = dToken
- `K` = thousand dToken
- `M` = million dToken
- `B` = billion dToken
- `T` = trillion dToken

Avoid raw integer-only UX that forces the user to count zeros.

## Agent Gateway Usage

OpenAI-compatible clients should use:

```text
http://127.0.0.1:8789/v1
```

Anthropic Messages clients such as Claude Code can use:

```text
http://127.0.0.1:8789/anthropic
```

When the selected Provider is backed by an OpenAI-compatible upstream, some Anthropic clients can fail if the gateway exposes incompatible thinking blocks. A common symptom is:

```text
Content block is not a thinking block
```

If this appears, treat it as an Agent Gateway compatibility issue and check whether a newer User app package is available. Do not modify app internals unless the user explicitly asks for that scope.

## Local Data

Runtime data often lives under:

```text
apps/dtoken-agent-gateway/data/
```

Treat it as sensitive. It may include:

- dToken API keys
- gateway profiles
- chat history
- session signer material
- credential ledger
- migration exports

Do not publish it or include it in support bundles unless explicitly required and understood.

## Browser Wallet Notes

Wallet interactions should happen in a browser environment that supports the user's wallet extension. When using a desktop-style dToken package, it should still open the real User app through Chrome or another compatible browser so wallet prompts work normally.

```text
http://127.0.0.1:8789/
```

The normal wallet model is browser extension injection, not local private-key custody inside the app.
