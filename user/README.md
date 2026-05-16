# dToken User

Standalone mainnet dToken User package.

This local service includes:

- User DApp and Chatbot
- local Agent Gateway for third-party agents
- local User state storage
- local dToken credential ledger
- full local migration export/import

## Start

```bash
npm install
npm run dtoken:user
```

Open:

```text
http://127.0.0.1:8789/
```

Agent endpoints:

- OpenAI-compatible: `http://127.0.0.1:8789/v1`
- Anthropic-compatible: `http://127.0.0.1:8789/anthropic`

## Escrow Amount Units

When creating a handshake, the escrow field supports a unit selector:

- `1` = dToken
- `K` = thousand dToken
- `M` = million dToken
- `B` = billion dToken
- `T` = trillion dToken

For example, entering `100` with unit `B` means `100B dToken`.

## Claude Code Compatibility

The Anthropic-compatible endpoint can be used by Claude Code and other
Anthropic Messages clients. When the selected dToken provider is an
OpenAI-compatible upstream such as Qwen, the gateway intentionally suppresses
synthetic Anthropic extended-thinking blocks. This avoids invalid
`thinking_delta` / `signature_delta` streams like:

```text
Content block is not a thinking block
```

Native Anthropic upstreams may still emit real Anthropic thinking blocks.

Run the bridge check before publishing changes:

```bash
npm run check:anthropic-bridge
```

## Mainnet Contracts

- dToken ERC20: `0x28219c4417d6095C66a04940D84cba13075b768b`
- Protocol Proxy: `0xc706bd1f6F1457A8953241aF64F93bd5406d751B`
- Chain ID: `1`

## Local Data

Runtime data is created under:

```text
apps/dtoken-agent-gateway/data/
```

This directory may contain local chat history, API keys, gateway profiles, session signer material, and dToken credential state. Treat exports and runtime data as sensitive authorization assets.

---

# dToken User 中文说明

这是可独立运行的 dToken User 主网包。

本地服务包含：

- User DApp 和 Chatbot
- 面向第三方 Agent 的本地 Agent Gateway
- User 本地状态存储
- 本地 dToken 凭证 ledger
- 完整本地迁移导出/导入

## 启动

```bash
npm install
npm run dtoken:user
```

打开：

```text
http://127.0.0.1:8789/
```

Agent 接入地址：

- OpenAI-compatible：`http://127.0.0.1:8789/v1`
- Anthropic-compatible：`http://127.0.0.1:8789/anthropic`

## 托管金额单位

创建牵手时，托管输入框支持单位选择：

- `1` = dToken
- `K` = 千 dToken
- `M` = 百万 dToken
- `B` = 十亿 dToken
- `T` = 万亿 dToken

例如输入 `100` 并选择 `B`，表示 `100B dToken`。

## Claude Code 兼容

Anthropic-compatible endpoint 可用于 Claude Code 等 Anthropic Messages
客户端。当当前 dToken provider 是 Qwen 这类 OpenAI-compatible upstream 时，
gateway 会主动禁止输出伪造的 Anthropic extended-thinking block，避免产生：

```text
Content block is not a thinking block
```

只有真正 Anthropic upstream 才会继续输出原生 thinking block。

发布前可运行：

```bash
npm run check:anthropic-bridge
```

## 主网合约

- dToken ERC20：`0x28219c4417d6095C66a04940D84cba13075b768b`
- Protocol Proxy：`0xc706bd1f6F1457A8953241aF64F93bd5406d751B`
- Chain ID：`1`

## 本地数据

运行数据会生成在：

```text
apps/dtoken-agent-gateway/data/
```

该目录可能包含聊天记录、API Key、Gateway profile、session signer 材料和 dToken 凭证状态。本地导出文件和运行数据应视为敏感授权资产。
