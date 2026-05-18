# Model Service Setup

## Purpose

This reference is for configuring models that a Provider is authorized to serve through dToken. It is about usage and operations, not internal service implementation.

## Reseller Model Fields

When configuring a model service, keep these fields consistent from Reseller to Provider Console:

- model ID / display name
- public `/v1` endpoint
- upstream provider name
- upstream model name
- context length
- capabilities
- input dToken/token price
- output dToken/token price
- minimum escrow
- Provider wallet

The source of truth for on-chain announcement should be the live Reseller response:

```bash
curl http://YOUR_RESELLER_HOST:8788/v1/models
```

Copy the exact model name, endpoint, prices, and Provider wallet into Provider Console.

## Qwen Token Plan Example

Known service values from a working Qwen Token Plan setup:

```text
model: qwen3.6-plus
upstream: qwen
upstreamModel: qwen3.6-plus
baseUrl: https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
contextLength: 1048576
capabilities: chat, vision, image, video, multimodal, reasoning
inputTokenPrice: 100000
outputTokenPrice: 300000
minimumEscrow: 10000000000
```

Use the user's current requested price values or server config as source of truth.

## DeepSeek Example

Known DeepSeek API details:

```text
OpenAI-compatible base URL: https://api.deepseek.com
Anthropic-compatible base URL: https://api.deepseek.com/anthropic
models: deepseek-v4-flash, deepseek-v4-pro
```

Set model prices and minimum escrow to match the Provider's intended offer. Validate through Reseller health and `/v1/models` before announcing.

## Preflight

Before a Provider announces a model on-chain:

```bash
npm run config:check
npm run upstream:check
curl http://127.0.0.1:8788/health
curl http://127.0.0.1:8788/v1/models
```

For a remote server, use the public host instead of `127.0.0.1`.

## Upstream Keys

Never place upstream API keys in public docs, screenshots, shared folders, or chat responses. Use environment variables or private server config. If a key was pasted into a public or shared context, rotate it.

## Long Agent Tasks

Long-running agent tasks may need higher upstream timeouts. Operationally, a safer timeout value is often:

```text
timeoutMs: 300000
```

Use Reseller logs to distinguish slow upstream response from no response or stream stall.
