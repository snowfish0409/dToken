# dToken Provider Service Node

The dToken Provider Service Node is the Provider-side gateway for serving LLM access through dToken.

```text
User App / Agent Gateway -> Provider Service Node -> Authorized Model Endpoint
```

It verifies on-chain dToken handshakes, issues dToken API keys, routes requests to authorized model endpoints, records real returned token usage, maintains the off-chain dToken credential chain, and performs Provider-side settlement when needed.

## What This Server Does

- Verifies that a User has opened a valid on-chain dToken handshake.
- Verifies the off-chain `handshakeCredential` before issuing a dToken API key.
- Exposes OpenAI-compatible and agent-compatible endpoints through dToken.
- Converts requests to the correct model endpoint format.
- Uses returned `usage` data as the token-accounting source whenever available.
- Maintains the latest User-signed dToken settlement credential for each session.
- Stops service when the handshake is no longer open.
- Claims dToken on-chain when Provider-side settlement is required.

API-key issuance itself does not cost gas. Gas is required for model announcements, User handshake creation/exit, and Provider settlement/claim transactions.

## Mainnet Contracts

- dToken ERC20: `0x28219c4417d6095C66a04940D84cba13075b768b`
- Protocol Proxy: `0xc706bd1f6F1457A8953241aF64F93bd5406d751B`
- Chain: Ethereum Mainnet
- Chain ID: `1`

## Requirements

- Linux server or VPS
- Node.js 20 or newer
- npm
- pm2 for production
- Public IP or domain
- HTTPS reverse proxy for production, such as Nginx or Caddy
- Ethereum mainnet RPC
- Provider wallet with ETH for gas
- At least one model endpoint LLM API key

## Folder Layout

```text
reseller/
  README.md
  .env.example
  package.json
  smart-contracts/deployments/mainnet-dtoken-v0.json
  apps/reseller-agent/
    config/production.template.json
    src/
    data/
```

The two files most Providers edit are:

```text
.env
config/production.json
```

Use `.env` for private keys, RPC URLs, and model access credentials. Use `production.json` for non-secret structure such as provider name, public URL, enabled model catalog, and custom model definitions.

## Quick Start

```bash
npm install

mkdir -p config
cp .env.example .env
cp apps/reseller-agent/config/production.template.json config/production.json
```

Edit `.env`:

```bash
DTOKEN_PROVIDER_CONFIG=./config/production.json
DTOKEN_PUBLIC_BASE_URL=https://your-domain.example/v1

DTOKEN_CONTRACT_RPC=https://your-mainnet-rpc.example

DTOKEN_PROVIDER_WALLET=0xYourProviderWallet
DTOKEN_PROVIDER_PRIVATE_KEY=0xYourProviderPrivateKey
DTOKEN_SERVICE_SIGNER_ADDRESS=0xYourProviderWallet
DTOKEN_SERVICE_SIGNER_KEY=0xYourProviderPrivateKey

DTOKEN_UPSTREAM_DEEPSEEK_KEY=your_deepseek_key
```

Replace every placeholder before production. The copied `.env.example` intentionally leaves private keys, RPC, and upstream API keys blank so the server does not accidentally run with fake secrets.

Only configure model access credentials for providers you actually use. Optional model endpoints without API keys are skipped.

Edit `config/production.json`:

```json
{
  "port": 8788,
  "publicBaseUrl": "https://your-domain.example/v1",
  "provider": {
    "name": "Your Provider Name",
    "wallet": "0xYourProviderWallet"
  },
  "contract": {
    "network": "mainnet",
    "contractAddress": "0xc706bd1f6F1457A8953241aF64F93bd5406d751B",
    "protocolAddress": "0xc706bd1f6F1457A8953241aF64F93bd5406d751B",
    "tokenAddress": "0x28219c4417d6095C66a04940D84cba13075b768b",
    "chainId": 1
  },
  "modelCatalogs": ["reference-v1"],
  "models": []
}
```

The template uses:

```json
"modelCatalogs": ["reference-v1"]
```

This is the easiest first setup. The public release package includes only two reference model entries in this catalog:

- `deepseek-v4-pro`, using the DeepSeek/OpenAI-compatible adapter.
- `qwen3.6-plus`, using the Qwen coding-plan adapter.

All other adapters are still included in the source tree. To provide more models, keep the adapter code and add your own model entries under `models`. A custom model with the same `displayName` as a catalog model overrides the catalog entry.

Runtime ledger and session data are stored under:

```text
./data
```

Back up this directory. It contains dToken API keys, sessions, latest User-signed credentials, and settlement state.

Start the server:

```bash
set -a
source .env
set +a

npm run reseller:serve
```

For production:

```bash
pm2 start "npm run reseller:serve" --name dtoken-reseller
pm2 logs dtoken-reseller
pm2 save
```

If you use Nginx, Caddy, or another reverse proxy, expose your HTTPS domain and forward traffic to:

```text
http://127.0.0.1:8788
```

`DTOKEN_PUBLIC_BASE_URL` should be the public `/v1` URL that Users will receive, for example:

```text
https://api.your-domain.example/v1
```

## Health Checks

```bash
curl http://127.0.0.1:8788/health
curl http://127.0.0.1:8788/v1/models
```

Check that:

- `network` is `mainnet`
- contract connection is true
- `provider_operator_wallet` is your Provider wallet
- `public_base_url` is your public `/v1` URL
- `input_token_price_dtoken` and `output_token_price_dtoken` match what you intend to announce on-chain

## First Provider Deployment Flow

For a first real Provider setup, follow this order:

1. Prepare a Provider wallet with a small amount of ETH for gas.
2. Configure `.env` with RPC, Provider wallet, Provider private key, and one upstream model API key.
3. Keep `modelCatalogs: ["reference-v1"]` for the two reference models, or replace it with your own `models` entries.
4. Start the server and check `/health`.
5. Open `/v1/models` and copy the exact `displayName`, endpoint, and input/output dToken prices.
6. Open Provider Console with the same Provider wallet.
7. Announce the model on-chain using the exact values from `/v1/models`.
8. Ask a User app to scan recent Provider announcements, create a handshake, request API, and make a small test call.

If `/v1/models` does not show a model, do not announce it yet. The server must be configured and online before the on-chain announcement is useful.

Provider Console fields should be copied from `/v1/models` as follows:

- model ID / display name: `id`
- endpoint: `dtoken.public_base_url`
- input price: `dtoken.input_token_price_dtoken`
- output price: `dtoken.output_token_price_dtoken`
- Provider wallet: `owned_by` or `dtoken.provider_operator_wallet`

## Model Configuration

Each model has a dToken market name and a real endpoint model ID.

```json
{
  "displayName": "deepseek-v4-pro",
  "upstreamId": "deepseek",
  "upstreamModel": "deepseek-v4-pro",
  "providerWallet": "0xYourProviderWallet",
  "contextLength": 1048576,
  "capabilities": ["chat", "reasoning"],
  "pricing": {
    "inputTokenPrice": "4",
    "outputTokenPrice": "7"
  }
}
```

Important fields:

- `displayName`: model name shown in the dToken market and used in on-chain metadata.
- `upstreamId`: the configured model endpoint provider ID.
- `upstreamModel`: the exact model ID sent to the model endpoint API.
- `providerWallet`: wallet that announces and receives dToken settlement.
- `contextLength`: context window exposed to User and Agent Gateway.
- `capabilities`: supported features, such as `chat`, `reasoning`, `vision`, `image`, `audio`, `video`, and `file`.
- `pricing.inputTokenPrice`: dToken charged per input token.
- `pricing.outputTokenPrice`: dToken charged per output token.

The on-chain model announcement must match the Provider service node configuration. Model names are strict:

```text
qwen3.6-plus is not qwen3.6
grok-4.3 is not grok4.3
glm-5.1 is not glm5.1
```

## On-Chain Model Announcement

Use the Provider Console to announce models:

1. Open Provider Console.
2. Connect the same Provider wallet used by the Reseller.
3. Fill model ID, display name, endpoint, input/output dToken price, and minimum escrow.
4. Use your public Reseller endpoint:

```text
https://your-domain.example/v1
```

5. Submit the on-chain announcement.
6. User apps can discover the announcement through event scanning.

An on-chain announcement alone does not make a model usable. The Provider service node must also be online and configured with matching model metadata and model endpoint access.

## Settlement and dToken Credentials

The Provider service node maintains the off-chain usage chain. For each billable round:

1. The Provider service node calls the model endpoint.
2. The model endpoint returns usage information.
3. The Provider service node calculates dToken cost from actual token usage and model pricing.
4. The User signs the cumulative dToken settlement credential.
5. The Provider service node stores the latest User-signed credential.

On-chain settlement accepts User-signed cumulative dToken credentials. This prevents a Provider from unilaterally inventing usage while also preventing a User from consuming service and refusing to settle.

## Adding a New Model Endpoint Provider

If the model endpoint API is OpenAI Chat Completions compatible, usually you only need to:

1. Add a model endpoint entry to `config/production.json`.
2. Set `company`, `baseUrl`, and API key environment variable.
3. Add one or more model entries under `models`.

If the model endpoint uses a custom protocol, add an adapter:

1. Add company configuration under `apps/reseller-agent/src/companies/`.
2. Add or reuse a backend under `apps/reseller-agent/src/backends/`.
3. Register it in `apps/reseller-agent/src/companies/index.js`.
4. Define capabilities, context length, token accounting, and multimodal policy.
5. Test through both User Chatbot and Agent Gateway.

The goal is that User/Gateway keeps a stable dToken interface while the Provider service node absorbs model endpoint format differences.

## Security Notes

- Never commit `.env`.
- Never put private keys or real model access credentials in JSON files.
- Use a dedicated Provider wallet.
- Keep only necessary gas in the Provider wallet.
- Back up `./data` or your configured ledger storage path.
- Use HTTPS in production.
- Restrict SSH and server access.
- Monitor `pm2 logs`.

The ledger storage contains sessions, dToken API keys, latest User-signed credentials, and settlement state. Losing it can affect automatic settlement for existing handshakes.

## Troubleshooting

### `/health` says `No contract code`

The RPC is probably on the wrong network or the contract address is wrong.

Check:

```bash
DTOKEN_CONTRACT_RPC
DTOKEN_CONTRACT_ADDRESS
DTOKEN_PROTOCOL_ADDRESS
DTOKEN_TOKEN_ADDRESS
```

### API-key request fails with `handshakeCredential mismatch`

The User-submitted credential does not match the on-chain `handshakeCredentialHash`.

Common causes:

- User switched devices without migrating local data.
- User created a new handshake but requested an API key for an old one.
- Local browser or gateway state is stale.

### Request fails with `No configured reseller model matches`

The on-chain announcement does not match local Reseller configuration.

Check:

- `displayName`
- input/output dToken price
- Provider wallet
- endpoint

### Provider address is `0x000...` in `/v1/models`

Environment variables were not loaded correctly. Check:

```bash
DTOKEN_PROVIDER_WALLET
DTOKEN_SERVICE_SIGNER_ADDRESS
```

### OpenAI endpoint health is false

OpenAI may be unavailable for account, region, or billing reasons. It is optional and does not block other model endpoints.

---

# dToken Provider Service Node 中文说明

dToken Provider 服务节点是 Provider 侧用于提供 LLM 服务的本地/服务器端网关。

```text
User App / Agent Gateway -> Provider 服务节点 -> 授权模型端点
```

它负责验证链上 dToken 牵手、签发 dToken API Key、将请求转发到授权模型端点、记录真实返回的 token 用量、维护链下 dToken 凭证链，并在需要时执行 Provider 侧链上结算。

## 这个服务做什么

- 验证 User 是否已经创建有效的链上 dToken handshake。
- 在签发 dToken API Key 前验证链下 `handshakeCredential`。
- 通过 dToken 暴露 OpenAI-compatible 和 agent-compatible 接口。
- 将请求转换成模型端点需要的格式。
- 尽可能使用模型端点返回的 `usage` 作为 token 计量来源。
- 为每个 session 保存最新的 User 签名结算凭证。
- handshake 不再是 open 状态时停止服务。
- 在协议需要 Provider 操作时执行链上 claim / settle。

获取 API Key 的验证本身不消耗 gas。需要 gas 的操作包括模型上链声明、User 创建/退出 handshake，以及 Provider 结算/认领。

## 主网合约

- dToken ERC20：`0x28219c4417d6095C66a04940D84cba13075b768b`
- Protocol Proxy：`0xc706bd1f6F1457A8953241aF64F93bd5406d751B`
- Chain：Ethereum Mainnet
- Chain ID：`1`

## 准备条件

- Linux 服务器或 VPS
- Node.js 20 或更新版本
- npm
- 生产环境建议使用 pm2
- 公网 IP 或域名
- 生产环境建议使用 Nginx / Caddy 做 HTTPS 反向代理
- Ethereum mainnet RPC
- 带少量 ETH gas 的 Provider 钱包
- 至少一个模型访问凭证

## 文件结构

```text
reseller/
  README.md
  .env.example
  package.json
  smart-contracts/deployments/mainnet-dtoken-v0.json
  apps/reseller-agent/
    config/production.template.json
    src/
    data/
```

最常修改的是：

```text
.env
config/production.json
```

`.env` 放私钥、RPC、模型端点 key 等敏感内容。`production.json` 放 Provider 名称、公开 URL、启用模型目录、自定义模型等非敏感结构配置。

## 快速开始

```bash
npm install

mkdir -p config
cp .env.example .env
cp apps/reseller-agent/config/production.template.json config/production.json
```

编辑 `.env`：

```bash
DTOKEN_PROVIDER_CONFIG=./config/production.json
DTOKEN_PUBLIC_BASE_URL=https://your-domain.example/v1

DTOKEN_CONTRACT_RPC=https://your-mainnet-rpc.example

DTOKEN_PROVIDER_WALLET=0xYourProviderWallet
DTOKEN_PROVIDER_PRIVATE_KEY=0xYourProviderPrivateKey
DTOKEN_SERVICE_SIGNER_ADDRESS=0xYourProviderWallet
DTOKEN_SERVICE_SIGNER_KEY=0xYourProviderPrivateKey

DTOKEN_UPSTREAM_DEEPSEEK_KEY=your_deepseek_key
```

正式运行前必须替换所有占位符。复制出来的 `.env.example` 会刻意把私钥、RPC 和上游模型 API Key 留空，避免服务误用假的密钥启动。

只需要配置你实际提供的模型端点。没有 API Key 的 optional model endpoint 会自动跳过。

编辑 `config/production.json`：

```json
{
  "port": 8788,
  "publicBaseUrl": "https://your-domain.example/v1",
  "provider": {
    "name": "Your Provider Name",
    "wallet": "0xYourProviderWallet"
  },
  "contract": {
    "network": "mainnet",
    "contractAddress": "0xc706bd1f6F1457A8953241aF64F93bd5406d751B",
    "protocolAddress": "0xc706bd1f6F1457A8953241aF64F93bd5406d751B",
    "tokenAddress": "0x28219c4417d6095C66a04940D84cba13075b768b",
    "chainId": 1
  },
  "modelCatalogs": ["reference-v1"],
  "models": []
}
```

模板默认使用：

```json
"modelCatalogs": ["reference-v1"]
```

这是最简单的第一次配置方式。公开发布包的这个目录只内置两个参考模型：

- `deepseek-v4-pro`，使用 DeepSeek / OpenAI-compatible adapter。
- `qwen3.6-plus`，使用 Qwen coding-plan adapter。

其他公司的 adapter 代码仍然全部保留。如果你要提供更多模型，请保留 adapter 代码，并在 `models` 中添加自己的模型配置。`models` 中如果出现和目录相同的 `displayName`，会覆盖目录默认项。

运行数据默认保存在：

```text
./data
```

请备份这个目录。里面包含 dToken API Key、session、最新 User 签名凭证和结算状态。

启动服务：

```bash
set -a
source .env
set +a

npm run reseller:serve
```

生产环境建议：

```bash
pm2 start "npm run reseller:serve" --name dtoken-reseller
pm2 logs dtoken-reseller
pm2 save
```

如果你使用 Nginx、Caddy 或其他反向代理，请把公网 HTTPS 请求转发到：

```text
http://127.0.0.1:8788
```

`DTOKEN_PUBLIC_BASE_URL` 应该是 User 实际收到的公网 `/v1` 地址，例如：

```text
https://api.your-domain.example/v1
```

## 健康检查

```bash
curl http://127.0.0.1:8788/health
curl http://127.0.0.1:8788/v1/models
```

确认：

- `network` 是 `mainnet`
- 合约连接正常
- `provider_operator_wallet` 是你的 Provider 钱包
- `public_base_url` 是你的公网 `/v1` 地址
- `input_token_price_dtoken` / `output_token_price_dtoken` 是你准备上链声明的价格

## 第一次 Provider 部署流程

第一次真实提供服务，建议按这个顺序：

1. 准备一个 Provider 钱包，并放入少量 ETH 作为 gas。
2. 在 `.env` 中配置 RPC、Provider 钱包、Provider 私钥和至少一个上游模型 API Key。
3. 如果只测试两个参考模型，保留 `modelCatalogs: ["reference-v1"]`；如果要提供自己的模型，就改成自己的 `models` 配置。
4. 启动服务并检查 `/health`。
5. 打开 `/v1/models`，复制精确的 `displayName`、endpoint、input/output dToken 价格。
6. 使用同一个 Provider 钱包打开 Provider Console。
7. 用 `/v1/models` 里的精确值进行链上模型声明。
8. 让 User 端扫描近期 Provider 声明，创建牵手，申请 API，并做一次小额测试调用。

如果 `/v1/models` 没有显示某个模型，不要先上链声明它。服务端必须已经配置完成并在线，链上声明才有实际意义。

Provider Console 字段建议直接从 `/v1/models` 复制：

- model ID / 展示名：`id`
- endpoint：`dtoken.public_base_url`
- input price：`dtoken.input_token_price_dtoken`
- output price：`dtoken.output_token_price_dtoken`
- Provider 钱包：`owned_by` 或 `dtoken.provider_operator_wallet`

## 模型配置

每个模型都有一个 dToken 市场模型名和一个真实端点模型 ID。

```json
{
  "displayName": "deepseek-v4-pro",
  "upstreamId": "deepseek",
  "upstreamModel": "deepseek-v4-pro",
  "providerWallet": "0xYourProviderWallet",
  "contextLength": 1048576,
  "capabilities": ["chat", "reasoning"],
  "pricing": {
    "inputTokenPrice": "4",
    "outputTokenPrice": "7"
  }
}
```

字段含义：

- `displayName`：dToken 市场展示名，也是链上 metadata 中的模型名。
- `upstreamId`：配置好的模型端点提供方 ID。
- `upstreamModel`：真实发送给模型端点的模型 ID。
- `providerWallet`：上链声明并接收 dToken 结算的钱包。
- `contextLength`：暴露给 User 和 Agent Gateway 的上下文窗口。
- `capabilities`：模型能力，例如 `chat`、`reasoning`、`vision`、`image`、`audio`、`video`、`file`。
- `pricing.inputTokenPrice`：每 1 个 input token 收多少 dToken。
- `pricing.outputTokenPrice`：每 1 个 output token 收多少 dToken。

链上模型声明必须和 Provider 服务节点配置一致。模型名严格匹配：

```text
qwen3.6-plus 不要写成 qwen3.6
grok-4.3 不要写成 grok4.3
glm-5.1 不要写成 glm5.1
```

## 上链声明模型

使用 Provider Console 完成模型声明：

1. 打开 Provider Console。
2. 连接和 Provider 服务节点相同的 Provider 钱包。
3. 填写模型 ID、展示名、endpoint、input/output dToken 价格、最低托管量。
4. endpoint 填公网 Provider 服务节点地址：

```text
https://your-domain.example/v1
```

5. 提交链上声明。
6. User 端可以通过 event scanning 发现模型。

只有链上声明并不代表模型可用。Provider 服务节点必须在线，并且本地模型配置、价格、Provider 钱包、模型端点访问配置都必须匹配。

## 结算与 dToken 凭证

Provider 服务节点维护链下用量链。每一轮计费：

1. Provider 服务节点调用模型端点。
2. 模型端点返回 usage。
3. Provider 服务节点根据真实 token 用量和模型价格计算 dToken 消耗。
4. User 对累计 dToken 消耗签名。
5. Provider 服务节点保存最新 User 签名凭证。

链上结算只接受 User 签名的累计 dToken 凭证。这可以防止 Provider 单方面伪造用量，也可以防止 User 使用服务后拒绝结算。

## 添加新的模型端点提供方

如果模型端点 兼容 OpenAI Chat Completions，通常只需要：

1. 在 `config/production.json` 添加 model endpoint。
2. 设置 `company`、`baseUrl` 和 API key 环境变量。
3. 在 `models` 中添加模型。

如果模型端点协议特殊，需要新增 adapter：

1. 在 `apps/reseller-agent/src/companies/` 添加公司配置。
2. 在 `apps/reseller-agent/src/backends/` 添加或复用 backend。
3. 在 `apps/reseller-agent/src/companies/index.js` 注册。
4. 定义能力、上下文窗口、token 计量和多模态策略。
5. 分别用 User Chatbot 和 Agent Gateway 测试。

Reseller 的目标是：User/Gateway 保持稳定的 dToken 调用方式，而模型端点格式差异由 Provider 服务节点吸收。

## 安全建议

- 不要提交 `.env`。
- 不要把私钥或真实模型端点 key 写进 JSON。
- 使用专门的 Provider 钱包。
- Provider 钱包只放必要 gas。
- 备份 `./data` 或你配置的 ledger storage path。
- 生产环境使用 HTTPS。
- 限制 SSH 和服务器访问。
- 定期查看 `pm2 logs`。

ledger storage 保存 session、dToken API key、最新 User 签名凭证和结算状态。丢失后可能影响旧 handshake 的自动结算能力。

## 常见问题

### `/health` 显示 `No contract code`

通常是 RPC 指向错误网络，或合约地址错误。

### API Key 申请失败：`handshakeCredential mismatch`

User 提交的 credential 与链上 `handshakeCredentialHash` 不一致。常见原因是换设备没有迁移本地数据、请求了旧 handshake，或本地状态混乱。

### 请求失败：`No configured reseller model matches`

链上声明和 Reseller 本地配置不匹配。检查 `displayName`、input/output dToken 价格、Provider wallet 和 endpoint。

### `/v1/models` 里 Provider 地址是 `0x000...`

环境变量没有正确加载。重点检查 `DTOKEN_PROVIDER_WALLET` 和 `DTOKEN_SERVICE_SIGNER_ADDRESS`。

### OpenAI model endpoint 是 false

OpenAI 可能由于账号、地区或计费状态不可用。它是 optional model endpoint，不影响其他模型。
