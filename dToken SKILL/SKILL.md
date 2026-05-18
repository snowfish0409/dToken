---
name: dtoken-framework-usage-monitoring
description: Use when operating the dToken framework as a User or Provider, including User app and Agent Gateway usage, Provider Console on-chain model announcements, Reseller service node setup, upstream model API configuration, wallet-based Ethereum contract calls, dToken escrow/pricing units, usage/remaining-balance monitoring, spend alerts, server deployment, and common usage troubleshooting. Do not use for contract coding or internal app architecture work.
---

# dToken Framework

Use this skill for dToken operation and usage. The goal is to help Users and Providers run the framework safely: connect wallets, call contracts through the apps, configure Reseller service nodes, publish model offers, and call models through dToken.

This skill is intentionally not for contract coding, app refactors, or internal implementation work unless the user explicitly asks to leave the usage/operator scope.

## First Move

Classify the request before editing:

- **User app / Agent Gateway**: read `references/user-app.md`.
- **Provider Console / on-chain model announcement**: read `references/provider-console.md` and `references/onchain-contract-calls.md`.
- **Reseller / Provider service node**: read `references/reseller-service-node.md` and `references/model-service-setup.md`.
- **Wallet, escrow, handshake, settlement flow**: read `references/onchain-contract-calls.md`.
- **dToken usage, remaining escrow, spend alerts, or budget checks**: read `references/usage-monitoring.md`, then the relevant User or Reseller reference.
- **Usage troubleshooting such as Claude, timeouts, no output, 502, invalid content blocks**: read `references/troubleshooting.md`.
- **Credential handling or publishing any instructions/config examples**: read `references/security.md`.

For architecture questions, start with `references/architecture.md`.

## Operating Rules

- Treat dToken runtime data as sensitive authorization material, not just cache.
- Never commit or echo real private keys, API keys, server passwords, `.env`, `data/`, gateway profiles, migration exports, or upstream credentials.
- Preserve exact model identity fields across Reseller and Provider Console: model ID/display name, endpoint, input price, output price, minimum escrow, Provider wallet.
- For usage monitoring, treat `remaining = escrowAmount - cumulativeSpent` as the basic budget model, then verify against User Gateway, Reseller ledger, and chain state when available.
- Do not let an agent automatically open large escrow, change spend limits, settle, or exit without explicit user confirmation.
- Before announcing on-chain, verify the Reseller model appears in `/v1/models` and upstream checks pass.
- If a task requires source-code changes, pause and make that scope explicit before proceeding.

## Common Local Directory Names

Local dToken workspaces often include:

- `user/` or `user-chrome-app-next/`: User app and Agent Gateway package.
- `provider console/` or `provider-chrome-app-next/`: Provider browser console package.
- `reseller/` or `reseller-qwen-timeout-next/`: Provider/Reseller service node.

Always inspect the actual workspace with `rg --files`, `find`, and `package.json` rather than assuming these names exist.

## Useful Scripts

Bundled script:

- `scripts/scan-secrets.sh <path>`: scan a candidate release/update folder for common dToken secrets.

Use it before sharing config snippets, deployment folders, or support bundles.
