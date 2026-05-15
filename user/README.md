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
