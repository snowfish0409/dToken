# Security and Release Hygiene

## Always Sensitive

Never commit, publish, paste into issue trackers, or include in skill assets:

- Provider private keys
- service signer private keys
- upstream API keys
- dToken API keys
- server passwords
- `.env`
- `config/production.json` if it contains secrets
- Reseller `data/`
- User Agent Gateway `data/`
- migration export JSON
- session signer private keys
- pm2 dump files containing environment
- logs containing Authorization headers or API keys

## Sharing or Support Bundle Checklist

Before sharing any folder, config, screenshot text, or support bundle:

1. Identify the intended source directories.
2. Exclude `node_modules`, `.DS_Store`, logs, pid files, runtime data, `.env`, and backups.
3. Run `scripts/scan-secrets.sh <update-folder>`.
4. Search for exact sensitive fragments if the user previously pasted credentials.

## Safe Placeholders

Use placeholders like:

```text
0xYourProviderWallet
0xYourServiceSigner
0xYourPrivateKey
sk-your-upstream-key
https://YOUR_DOMAIN/v1
https://YOUR_ETHEREUM_RPC
```

Do not use real-looking generated private keys in docs; they can be accidentally reused.

## Runtime Data Risk

User local data may include session signer material that can sign usage credentials within an escrow limit. It cannot directly steal wallet assets, but it can authorize dToken spend within active handshakes. Treat it as sensitive.

Reseller data may include issued API keys, usage ledgers, handshake state, and settlement credentials. Treat it as production financial data.

Usage monitoring outputs can also be sensitive. Avoid publishing full handshake ids, issued API keys, session signer addresses tied to private local state, or detailed usage ledgers unless the user explicitly intends to share them.

## Server Operations

When connecting to a server:

- confirm host and target directory before deleting anything
- do not rely on old deployment files unless explicitly told to preserve them
- if wiping a server, warn that active handshakes/settlement credentials may be lost
- never print private keys back in final answers
- prefer pm2 scripts that reload current `.env`

## Skill Boundary

Do not store real dToken credentials inside this skill. The skill should contain usage procedures, placeholders, validation scripts, and references only.
