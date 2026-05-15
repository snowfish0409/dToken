# dToken

Version: Mainnet v0  
Date: 2026-05-15

dToken is a protocol for using and providing large language model services with settlement handled by decentralized blockchain infrastructure.

It combines on-chain dToken escrow, off-chain LLM inference, User-signed usage credentials, and final on-chain settlement. This public package contains the mainnet-aligned modules for Users, Providers, Provider service node operators, and contract reviewers.

> dToken is experimental software. Review the contracts, guides, risk notes, and your local configuration before using real funds.

## Mainnet Contracts

- dToken ERC20: `0x28219c4417d6095C66a04940D84cba13075b768b`
- Protocol Proxy: `0xc706bd1f6F1457A8953241aF64F93bd5406d751B`
- Protocol Implementation: `0xad055A36d1F442170480A116184f38b800DE4645`
- Upgrade Admin / Safe: `0x6973CE0B405637a704c0B367DbD3A302a26e2952`
- Chain: Ethereum mainnet
- Chain ID: `1`

## Official Mainnet Identity

dToken encourages open development on top of this framework. Developers are welcome to fork the User app, Provider Console, Provider service node, Agent adapters, documentation, and integration tooling.

The official dToken mainnet identity, however, is defined by the fixed ERC20 token and the official protocol address listed above. A project that changes the ERC20 token address, mints a different token, deploys a different protocol address, or changes the settlement asset should clearly identify itself as a fork, extension, or independent deployment rather than the official dToken mainnet protocol.

The dToken ERC20 is intended to remain fixed. Protocol logic may be upgraded through the Safe-controlled proxy path, but such upgrades should not require replacing or re-minting the ERC20 settlement asset.

## Directory Layout

- `contract release/`: publishable Solidity source package for transparency and review.
- `user/`: standalone dToken User app, including Chatbot, local Agent Gateway, local state, credential ledger, and migration tools.
- `provider console/`: standalone browser console for Provider model announcements and handshake inspection.
- `reseller/`: configurable Provider service node package for routing dToken requests to authorized model endpoints.

Runtime data, private keys, API keys, User chat history, local gateway profiles, and server ledgers are not included in this public package.

## User App

The User app is a local service that includes both Chatbot and Agent Gateway.

```bash
cd "user"
npm install
npm run dtoken:user
```

Open:

```text
http://127.0.0.1:8789/
```

Typical User flow:

1. Connect a browser wallet on Ethereum mainnet.
2. Scan recent Provider model announcements.
3. Create a handshake and escrow dToken.
4. Request a dToken API Key from the selected Provider service node.
5. Use the built-in Chatbot or bind the model to Agent Gateway.
6. Exit the handshake when finished.

Agent Gateway endpoints:

- OpenAI-compatible: `http://127.0.0.1:8789/v1`
- Anthropic-compatible: `http://127.0.0.1:8789/anthropic`

Local runtime data is created under:

```text
user/apps/dtoken-agent-gateway/data/
```

This directory may contain API keys, chat history, gateway profiles, session signer material, and usage credentials. Treat exports and runtime data as sensitive authorization assets.

## Provider Console

Provider Console is a standalone browser console for on-chain Provider operations.

```bash
cd "provider console"
npm install
npm run serve
```

Open:

```text
http://127.0.0.1:8792/
```

Provider Console can:

- announce model offers on-chain;
- update or delist model offers;
- scan recent `ProviderAnnounced` events for the connected wallet;
- inspect open and settled handshakes involving the Provider wallet;
- view dToken/ETH reference pricing.

Provider Console does not read User local data, Agent Gateway state, Reseller private configuration, or upstream API keys.

## Provider Service Node

The Provider service node verifies handshakes, issues dToken API keys, routes model calls to authorized model endpoints, records usage, stores User-signed dToken credentials, and performs Provider-side settlement when required.

```bash
cd "reseller"
npm install
cp .env.example .env
mkdir -p config
cp apps/reseller-agent/config/production.template.json config/production.json
```

Then edit:

- `.env` for RPC URLs, Provider wallet keys, and model access credentials;
- `config/production.json` for public URL, Provider identity, enabled model catalogs, and non-secret model configuration.

Provider setup checklist:

1. Prepare a Provider wallet with ETH for gas.
2. Fill `.env` with a mainnet RPC, Provider wallet address, Provider private key, and the upstream model API keys you are authorized to use.
3. Fill `config/production.json` with the public `/v1` URL, Provider identity, enabled model catalogs, and optional custom model definitions.
4. Start the service node and check:

```bash
curl http://127.0.0.1:8788/health
curl http://127.0.0.1:8788/v1/models
```

5. Only announce models that appear in `/v1/models`.
6. Copy the exact model name, endpoint, input dToken/token price, output dToken/token price, and Provider wallet from `/v1/models` into Provider Console.
7. Keep model names exact. A different character creates a different on-chain offer and will not match the service node configuration.

The service node runtime data and `.env` are sensitive. They can contain dToken API keys, session state, User-signed credentials, private keys, and upstream model access credentials. Do not publish them.

Read `reseller/README.md` for the complete Provider service node setup guide.

## Contract Source

The public Solidity source is in `contract release/`.

Included contracts:

- `DTokenFixed.sol`
- `DTokenProtocolCurrentUpgradeable.sol`
- `DTokenProxy.sol`

The ERC20 dToken has fixed supply and no post-deployment mint function. The protocol logic is upgradeable through the Safe-controlled proxy admin path.

## Documentation

- Whitepaper: `WHITEPAPER.md`
- User module notes: `user/README.md`
- Provider Console module notes: `provider console/README.md`
- Provider service node setup guide: `reseller/README.md`
- Contract source notes: `contract release/README.md`

## Safety Checklist

- Use the correct Ethereum mainnet network.
- Never commit `.env`, private keys, API keys, runtime data, or User migration exports.
- User local session signer data is an authorization asset.
- Provider service nodes must only connect to model endpoints they are authorized to operate or access.
- Model names and dToken prices in Provider Console must match the Provider service node configuration.
- Protocol settlement is based on User-signed cumulative dToken credentials.
- High-frequency model calls are off-chain; only escrow, exits, claims, and final settlement touch the chain.

---

# dToken 中文说明

版本：主网 v0  
日期：2026-05-15

dToken 是一套依赖去中心化区块链进行结算的大语言模型服务使用与提供协议。

它把链上 dToken 托管、链下大模型调用、User 签名用量凭证和最终链上结算结合起来。本目录是面向公开发布的主网对齐版本，包含 User 端、Provider Console、Provider 服务节点和合约源码。

> dToken 仍属于实验性软件。使用真实资产前，请仔细阅读合约、操作说明、风险提示和本地配置。

## 主网合约

- dToken ERC20：`0x28219c4417d6095C66a04940D84cba13075b768b`
- Protocol Proxy：`0xc706bd1f6F1457A8953241aF64F93bd5406d751B`
- Protocol Implementation：`0xad055A36d1F442170480A116184f38b800DE4645`
- Upgrade Admin / Safe：`0x6973CE0B405637a704c0B367DbD3A302a26e2952`
- 链：Ethereum mainnet
- Chain ID：`1`

## 官方主网身份

dToken 鼓励任何人在这个框架基础上继续开发。开发者可以自由 fork 和扩展 User 端、Provider Console、Provider 服务节点、Agent adapter、文档和集成工具。

但是，官方 dToken 主网身份由上方列出的固定 ERC20 代币地址和官方协议地址共同定义。如果某个项目修改了 ERC20 地址、重新铸造了不同 token、部署了不同协议地址，或更换了结算资产，就应明确说明其属于 fork、扩展版本或独立部署，而不应与官方 dToken mainnet 协议混淆。

dToken ERC20 预计保持固定不变。协议逻辑可以通过 Safe 控制的 proxy 路径升级，但这类升级不应要求替换或重新铸造 ERC20 结算资产。

## 目录说明

- `contract release/`：可公开发布的 Solidity 合约源码，用于透明审阅。
- `user/`：可独立运行的 dToken User 端，包含 Chatbot、本地 Agent Gateway、本地状态、凭证 ledger 和迁移工具。
- `provider console/`：可独立运行的浏览器 Provider 控制台，用于模型上链声明和牵手查看。
- `reseller/`：Provider 侧可配置的服务节点，用于把 dToken 请求路由到授权模型端点。

公开包不包含运行数据、私钥、API Key、User 聊天记录、本地 Gateway profile 或服务器 ledger。

## User 端

User 端是一个本地服务，同时包含 Chatbot 和 Agent Gateway。

```bash
cd "user"
npm install
npm run dtoken:user
```

打开：

```text
http://127.0.0.1:8789/
```

典型 User 流程：

1. 在 Ethereum mainnet 连接浏览器钱包。
2. 扫描近期 Provider 模型声明。
3. 创建 handshake 并托管 dToken。
4. 向选定的 Provider 服务节点申请 dToken API Key。
5. 使用内置 Chatbot，或把模型绑定到 Agent Gateway。
6. 使用结束后退出 handshake。

Agent Gateway 入口：

- OpenAI-compatible：`http://127.0.0.1:8789/v1`
- Anthropic-compatible：`http://127.0.0.1:8789/anthropic`

运行后，本地数据会生成在：

```text
user/apps/dtoken-agent-gateway/data/
```

其中可能包含 API Key、聊天记录、Gateway profile、session signer 材料和用量凭证。导出文件与运行数据都应视为敏感授权资产。

## Provider Console

Provider Console 是独立的浏览器链上控制台。

```bash
cd "provider console"
npm install
npm run serve
```

打开：

```text
http://127.0.0.1:8792/
```

Provider Console 可以：

- 上链声明模型服务；
- 更新或下架模型声明；
- 扫描当前钱包近期发布的 `ProviderAnnounced` event；
- 查看当前 Provider 钱包相关的未结算和已结算 handshake；
- 查看 dToken/ETH 参考价格。

Provider Console 不读取 User 本地数据、Agent Gateway 状态、Reseller 私有配置或上游 API Key。

## Provider 服务节点

Provider 服务节点负责验证 handshake、签发 dToken API Key、把模型调用路由到授权模型端点、记录用量、保存 User 签名 dToken 凭证，并在需要时执行 Provider 侧结算。

```bash
cd "reseller"
npm install
cp .env.example .env
mkdir -p config
cp apps/reseller-agent/config/production.template.json config/production.json
```

然后编辑：

- `.env`：RPC、Provider 钱包密钥、模型访问凭证；
- `config/production.json`：公网 URL、Provider 身份、启用模型目录和非敏感模型配置。

Provider 配置检查清单：

1. 准备一个有 ETH gas 的 Provider 钱包。
2. 在 `.env` 中填写 mainnet RPC、Provider 钱包地址、Provider 私钥，以及你有权使用的上游模型 API Key。
3. 在 `config/production.json` 中填写公网 `/v1` 地址、Provider 身份、启用模型目录和可选自定义模型定义。
4. 启动服务节点后检查：

```bash
curl http://127.0.0.1:8788/health
curl http://127.0.0.1:8788/v1/models
```

5. 只上链声明 `/v1/models` 中真实出现的模型。
6. 将 `/v1/models` 中的模型名、endpoint、input dToken/token 价格、output dToken/token 价格和 Provider 钱包地址精确复制到 Provider Console。
7. 模型名必须完全一致。任何字符差异都会形成不同链上 offer，导致无法匹配服务节点配置。

服务节点运行数据和 `.env` 都是敏感内容，可能包含 dToken API Key、session 状态、User 签名凭证、私钥和上游模型访问凭证，不要公开发布。

完整 Provider 服务节点配置流程见 `reseller/README.md`。

## 合约源码

公开 Solidity 源码位于 `contract release/`。

包含：

- `DTokenFixed.sol`
- `DTokenProtocolCurrentUpgradeable.sol`
- `DTokenProxy.sol`

dToken ERC20 固定总量，部署后没有继续 mint 函数。协议逻辑通过 Safe 控制的 proxy admin 路径升级。

## 文档

- 白皮书：`WHITEPAPER.md`
- User 模块说明：`user/README.md`
- Provider Console 模块说明：`provider console/README.md`
- Provider 服务节点配置说明：`reseller/README.md`
- 合约源码说明：`contract release/README.md`

## 安全检查

- 确认使用 Ethereum mainnet。
- 不要提交 `.env`、私钥、API Key、运行数据或 User 迁移导出。
- User 本地 session signer 数据属于授权资产。
- Provider 服务节点只能连接自己有权运营或有权接入的模型端点。
- Provider Console 中声明的模型名和 dToken 价格必须与 Provider 服务节点配置匹配。
- 协议结算以 User 签名的累计 dToken 用量凭证为准。
- 高频模型调用在线下完成；链上只处理托管、退出、认领和最终结算。
