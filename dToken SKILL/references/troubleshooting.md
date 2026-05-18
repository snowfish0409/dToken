# Troubleshooting

## Port Already In Use

Symptom:

```text
Error: listen EADDRINUSE: address already in use 127.0.0.1:8789
```

Cause: another User Agent Gateway is already running.

Actions:

```bash
lsof -nP -iTCP:8789 -sTCP:LISTEN
kill <pid>
```

Prefer the bundled `npm run stop` script when present.

## Claude Code: Content Block Is Not a Thinking Block

Symptom:

```text
API Error: Content block is not a thinking block
```

Likely cause: the Anthropic-compatible endpoint produced `thinking_delta` or `signature_delta` for a content block that was not a real Anthropic thinking block.

Operational response:

- This is usually a User Agent Gateway compatibility issue, not an on-chain issue.
- Check whether the user is running the latest User app package.
- Switch to the OpenAI-compatible endpoint as a temporary workaround when the client supports it.
- Do not change gateway source code unless the user explicitly requests code changes.

## Claude Desktop or Claude Code Consumes Tokens but Shows No Output

Likely causes:

- stream conversion never emits a valid final message
- upstream stream stalls after usage is metered
- gateway keeps waiting for completion while client sees no content
- 502 or fetch failure gets mapped poorly

Operational response:

- Check User Gateway logs and Reseller logs to locate where streaming stopped.
- Test a short prompt against the same model.
- Test the same model through OpenAI-compatible and Anthropic-compatible endpoints if available.
- If only one client fails, treat it as compatibility rather than model unavailability.
- Check latest cumulative spend before retrying; dToken may have been consumed even if the client showed no final answer.

## Upstream Timeout

Symptom:

```text
dToken Gateway error (upstream_timeout): Upstream qwen timed out after 90000ms
```

Possible reasons:

- long agent task
- parallel Claude Code tasks
- upstream slow to send headers
- upstream sends headers but no first stream chunk
- upstream stream stalls between chunks

Operational response:

- Check Reseller logs for whether headers arrived, first chunk arrived, or stream stalled.
- For long agent tasks, use a service configuration with a higher timeout such as `300000ms`.
- Avoid running multiple heavy parallel tasks through a small upstream quota while diagnosing.

## 502 Fetch Failed

Symptom:

```text
API Error: 502 fetch failed
```

Could be:

- upstream or provider service interruption
- local gateway stream mapping issue
- client-side gateway returning a generic proxy error

First check:

```bash
curl http://127.0.0.1:8789/health
curl http://PROVIDER_ENDPOINT/v1/models
pm2 logs dtoken-reseller
```

Then inspect whether the error happened in User Gateway, Reseller, or upstream.

Also check usage state before retrying. A failed client response does not always mean zero dToken usage if the upstream call already completed or partially streamed.

## Provider Scan Fails

Examples:

```text
quorum not met
UNKNOWN_ERROR
eth_blockNumber
```

Check:

- wallet is on Ethereum mainnet
- injected wallet RPC is healthy
- app is not mixing wallet RPC and unrelated public RPC in one quorum provider
- contract deployment JSON matches mainnet

## `/health` False but `/v1/models` Works

`/v1/models` can be local catalog only. It does not prove upstream API keys work.

Run:

```bash
npm run upstream:check
```

## Qwen Invalid API Key

Check:

- full Token Plan API key was copied
- base URL is Token Plan compatible-mode URL
- Reseller is configured for the Qwen Token Plan endpoint rather than a generic incompatible endpoint
- pm2 was restarted with the current `.env`
- key was not reset, disabled, expired, or truncated

## No Configured Reseller Model Matches

The on-chain Provider announcement does not match local Reseller configuration. Compare:

- model ID / display name
- public endpoint
- input price
- output price
- minimum escrow
- Provider wallet

## Local App Opens Blank

Common causes:

- app launcher points at missing `index.html`
- `.app` path resolution assumes the wrong parent directory
- local service exits immediately
- dependencies were not installed
- Chrome `open -a` ignored `--args --app` because Chrome was already running

Operational response:

- Start service first, verify `curl`.
- Use direct Chrome binary with `--app=http://127.0.0.1:PORT/`.
- Ensure background process survives the launcher exit.
