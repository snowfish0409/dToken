# dToken Whitepaper

Version: Mainnet v0  
Date: 2026-05-15  
Status: Release version  

> This document explains the goals, architecture, settlement mechanism, economic design, and risk boundaries of dToken. It is not investment advice, legal advice, or a promise of return. dToken is an experimental protocol. Every participant should independently evaluate smart contract, liquidity, external model endpoint, pricing, and operational risks.

## What Is dToken

The `d` in dToken stands for `decentralized`. At its core, dToken means decentralized large language model token: a token and settlement protocol for coordinating LLM service usage, payment, and final distribution through decentralized blockchain infrastructure.

dToken is not an LLM itself and does not put model inference on-chain. It provides a verifiable payment and settlement layer around off-chain model services, so Users and Providers can interact through escrow, signed usage credentials, and final on-chain settlement instead of relying only on a centralized billing account.

## Abstract

dToken is a protocol for using and providing large language model services with settlement handled by decentralized blockchain infrastructure. By providing a framework of on-chain escrow, off-chain model calls, User-signed credentials, and final on-chain settlement, dToken does not attempt to put model inference on-chain and does not require every request to pass through a unified centralized platform. Instead, it places service relationships, escrowed funds, usage acknowledgement, and final distribution inside verifiable rules.

A User escrows dToken in a smart contract and opens a service handshake. A Provider-side service node serves real LLM requests off-chain through model endpoints that the Provider is authorized to operate or access, then calculates dToken cost from returned usage data. Each billable round must be acknowledged by a User-side session signature, forming an off-chain dToken hash chain. The smart contract accepts only User-signed dToken usage credentials as the basis for settlement.

The core goals are:

- Make LLM services openly discoverable, purchasable, and providable.
- Keep real LLM usage off-chain and reduce gas costs.
- Prevent Providers from unilaterally fabricating usage.
- Prevent Users from consuming service and then refusing to settle.
- Minimize contract storage and keep high-frequency details off-chain.
- Support Chatbot usage, OpenAI-compatible agents, Anthropic Messages agents, and other local agent workflows.

## 1. Background

Large language models are becoming a new layer of digital infrastructure. High-quality models are usually trained and operated by a small number of large organizations, and users can face restrictions related to geography, payment methods, platform policies, account systems, commercial lock-in, or fragmented access channels. In addition, individually customized models often have no practical commercial distribution or usage channel other than being open-sourced.

Traditional API keys solve access control, but they do not natively solve:

- prepaid service risk;
- proof of actual delivery;
- user acknowledgement of real usage;
- verifiable token accounting;
- escrow distribution during disputes;
- safe integration with third-party agents and local tools.

dToken uses blockchain for escrow and final distribution, and off-chain signed credentials for high-frequency inference calls. This allows Users and Providers to transact without fully trusting each other.

Compliance note: dToken is a settlement and escrow protocol. It does not grant rights to any third-party model, API, dataset, brand, or platform. Each Provider is responsible for ensuring that any external model endpoint, API credential, hosted model, or service it connects to dToken is used with proper authorization and in accordance with applicable terms and laws.

## 2. System Roles

### User

The User is the buyer of model service. A User connects a wallet through the local dToken User app, chooses a Provider and model, escrows dToken, obtains an API key, and uses the model through the built-in Chatbot or local Agent Gateway.

The User side is responsible for:

- wallet connection and on-chain transactions;
- opening a handshake and escrowing dToken;
- generating a local `handshakeCredential`;
- generating a local `userSessionSigner`;
- storing API keys, chat history, Agent profiles, and local usage state;
- signing every dToken usage credential;
- initiating exit or finalizing settlement after the challenge period.

### Provider

The Provider is the model-service provider. In dToken, Provider is one system role, but it normally operates through two practical components:

- Provider Service Node: the server-side component that directly provides or routes language model service.
- Provider Console: the Provider's on-chain operation console for publishing and managing model information.

A Provider may operate its own model endpoint or connect dToken to external model services that it is authorized to use, such as DeepSeek, Kimi, Gemini, Qwen, Grok, GLM, OpenAI, Anthropic, and others, where proper authorization has been obtained.

The Provider Service Node is responsible for:

- verifying that the User has opened an on-chain handshake and escrowed dToken;
- verifying that the `handshakeCredential` matches the on-chain hash;
- issuing dToken API keys;
- forwarding requests to authorized model endpoints;
- calculating real token and dToken usage from returned usage data;
- maintaining the off-chain dToken hash chain;
- storing the latest User-signed credential;
- executing settlement strategy when the User exits, a challenge occurs, or budget is exhausted.

The Provider Console is not a separate participant. It is the Provider's browser-based on-chain tool. It uses the browser wallet RPC and contract ABI, and it does not read User local data or Provider Service Node private data. Provider Console is used to:

- announce model offers through on-chain events;
- scan recent model announcements made by the current wallet;
- view unsettled handshakes for the current Provider;
- view final distribution results of settled handshakes;
- display price references from the dToken/WETH liquidity pool.

## 3. Protocol Components

### dToken Protocol Contract

The protocol contract is responsible for:

- receiving User-escrowed dToken;
- creating and storing minimal handshake state;
- verifying User-signed usage credentials;
- processing direct Provider settlement;
- processing User exits, challenge periods, and final settlement;
- publishing or refreshing Provider model announcements through events.

The protocol contract is not responsible for:

- storing Provider-side model access credentials;
- forwarding model requests;
- storing chat history;
- storing every usage round;
- judging model output quality.

### dToken ERC20

dToken ERC20 is the settlement asset of the protocol. The mainnet version uses a fixed-supply ERC20:

- Name: dToken
- Symbol: DTOKEN
- Decimals: 18
- Total supply: 10,000,000,000,000,000 DTOKEN
- No post-deployment mint path

The ERC20 asset layer is separated from the protocol settlement layer. The dToken ERC20 is fixed, while the protocol contract uses a Proxy architecture for upgradeability. Future protocol fixes should not require minting a new dToken.

## 4. Mainnet Contracts

Ethereum Mainnet:

- dToken ERC20: `0x28219c4417d6095C66a04940D84cba13075b768b`
- Protocol Proxy: `0xc706bd1f6F1457A8953241aF64F93bd5406d751B`
- Protocol Implementation: `0xad055A36d1F442170480A116184f38b800DE4645`
- Upgrade Admin / Safe: `0x6973CE0B405637a704c0B367DbD3A302a26e2952`
- Chain ID: `1`
- Challenge period: 10 minutes

Upgrade authority is controlled by Safe multisig.

### Official Mainnet Identity and Ecosystem Development

dToken is designed to be an open framework. Anyone may build applications, Provider tools, Agent integrations, analytics, documentation, dashboards, local gateways, or service-node extensions on top of the dToken architecture.

The official dToken mainnet protocol is identified by the fixed ERC20 token address and the official protocol address listed above. This distinction is important because the ERC20 settlement asset is the economic anchor of the system. Deployments that use a different ERC20 token, mint a different settlement asset, change the protocol address, or otherwise alter the settlement layer should be presented as forks, extensions, experiments, or independent deployments, not as the official dToken mainnet protocol.

The protocol contract is upgradeable so bugs and protocol logic can be improved without replacing the dToken ERC20. The intended continuity rule is simple: the ERC20 dToken settlement asset remains fixed, while compatible protocol logic may evolve through Safe-governed upgrades.

## 5. Core Flow

### 5.1 Provider Announces a Model

The Provider calls `announceProvider` through Provider Console. The chain does not permanently store full marketplace data. Instead, it emits an event containing:

- Provider address;
- `metadataURI`;
- `metadataHash`;
- `offerId = hash(provider, metadataHash)`.

Model ID, display name, endpoint, input/output prices, minimum escrow, context length, multimodal capabilities, and tokenizer information should live in metadata or be returned by the Provider service node during API-key issuance.

Users scan recent Provider events through wallet RPC to discover active Providers. This avoids unbounded contract storage growth.

### 5.2 User Opens a Handshake

After choosing a Provider and model, the User locally generates:

- `handshakeCredential`: used to prove API-key claim rights to the Provider service node;
- `userSessionSigner`: a local session signer used to sign dToken usage credentials.

When opening the handshake, the chain stores only `hash(handshakeCredential)`, not the credential itself. The contract also binds:

- User wallet address;
- Provider address;
- User session signer address;
- escrowed dToken amount;
- Provider offerId.

### 5.3 API-Key Issuance

When requesting an API key from the Provider service node, the User submits the original `handshakeCredential`. The service node reads the handshake from chain, recomputes the hash, and verifies it against `handshakeCredentialHash`. If user, provider, offer, status, and escrow checks pass, the service node issues an API key and model capability information.

This step requires no Provider-side on-chain transaction and does not cost Provider gas.

### 5.4 Model Usage

The User can call models through:

- the built-in dToken User Chatbot;
- the local Agent Gateway for OpenClaw, Claude Code, Hermes Agent, and other tools.

An Agent only sees the local Gateway Base URL, Agent API key, and model name. The real dToken API key, User session signer, hash chain, and budget control remain inside the local dToken User service.

### 5.5 dToken Billing and Hash Chain

After each model call, the Provider service node calculates:

- input tokens;
- output tokens;
- input dToken/token price;
- output dToken/token price;
- round dToken cost;
- cumulative dToken spent;
- metering hash;
- previous credential hash.

The Provider service node creates a new dToken credential. The User local session signer signs it. Only User-signed credentials can be used for on-chain settlement.

The contract does not verify the full hash chain round by round. The hash chain is an off-chain continuity and audit mechanism. The contract verifies the final User signature, cumulative spend, metering hash, signature time, and escrow limit.

### 5.6 Exit and Settlement

There are two exit paths:

1. The Provider directly settles with the latest User-signed credential.
2. The User requests exit and enters a 10-minute challenge period. The Provider may challenge with a newer User-signed credential during that period. After the challenge period, the User or Provider can finalize settlement with the pending credential.

At settlement:

- Provider receives `min(cumulativeSpent, escrowAmount)`.
- User receives the remaining escrow.
- If the Provider receives more than 0 dToken, the contract may refresh the Provider announcement event so actively serving Providers remain discoverable.

### 5.7 Provider Service Node Deployment Discipline

Before announcing a model on-chain, a Provider should first configure and run its Provider Service Node. The operational order is:

1. Prepare a Provider wallet with ETH for gas.
2. Configure the service node with an Ethereum mainnet RPC, Provider wallet, Provider signing key, public `/v1` endpoint, and authorized model endpoint credentials.
3. Configure model entries or enabled model catalogs in the service node.
4. Start the service node and inspect `/health` and `/v1/models`.
5. Announce only models that are visible in `/v1/models`.
6. Copy the exact model name, endpoint, input dToken/token price, output dToken/token price, and Provider wallet from `/v1/models` into Provider Console.

The on-chain Provider announcement and the Provider Service Node configuration must match exactly. If a model name, price, Provider wallet, endpoint, or metadata hash does not match, a User may be able to see an announcement but fail to obtain a working dToken API key.

Provider Service Node runtime data and environment variables are sensitive. They may contain Provider private keys, upstream model credentials, dToken API keys, User-signed settlement credentials, and service ledgers. They should not be published.

## 6. Economic Design

dToken is not designed to be one-to-one with model-provider tokens. Different model providers use different pricing, input/output ratios, contexts, cache policies, reasoning tokens, multimodal accounting, and commercial terms. Strict one-to-one mapping is not realistic.

There are three free-market price relationships:

- `dToken / model token`, set by each Provider;
- `dToken / ETH`, formed by market liquidity;
- `dToken / USD`, inferred from dToken/ETH and ETH/USD reference prices.

The binding Provider quote is `dToken/token`. USD display is only a reference derived from liquidity pools and external ETH/USD prices. It is not a protocol-guaranteed price.

In an ideal market, honest, stable, high-quality, and fairly priced LLM services should gain more Users and become dominant.

### Initial Allocation

The mainnet total supply is 10Q DTOKEN, meaning 10,000,000,000,000,000 DTOKEN. The allocation design is:

- 50%: initial liquidity;
- 20%: rewards for developers who make important contributions to the dToken ecosystem;
- 5%: rewards for KOLs who materially help dToken adoption;
- 20%: cooperation and exchange with third parties that support dToken development;
- 5%: founder allocation.

Initial liquidity is provided through a Uniswap V3 dToken/WETH pool. Because early liquidity may be shallow, price can move sharply and may be affected by relatively small trades. USD estimates in the User app and Provider Console should be treated as reference data only.

## 7. Security Model

Security boundaries:

- The User wallet private key never goes on-chain and is not stored by dToken User.
- The `userSessionSigner` private key is stored locally and prevents the need for manual wallet signatures on every model call.
- The `userSessionSigner` public address is written into the handshake for on-chain UserAck verification.
- If User local data or a full migration JSON is leaked, an attacker may sign usage credentials within the escrow limit of that handshake, but cannot exceed escrow and cannot steal wallet assets.
- The Provider cannot settle using its own signature; settlement requires a User wallet or User session signer signature.
- The Provider service node should not issue an API key unless `handshakeCredential` verification passes.
- The same handshake is executed serially inside Gateway to avoid concurrent hash-chain forks.

## 8. Risks

Known risk categories include:

- smart contract bugs or upgrade governance risk;
- leakage of local session signer, API keys, or migration JSON;
- Provider downtime, service refusal, or external model endpoint instability;
- inconsistent usage reporting or tokenizer differences;
- shallow liquidity, high slippage, and dToken/ETH price volatility;
- Agent compatibility issues around request format, tool use, streaming, or multimodal content;
- legal, regulatory, platform-policy, or model-provider terms changes.

## 9. Conclusion

dToken is not a centralized model platform. It is an open settlement protocol for LLM service transactions. It uses the blockchain for escrow, identity constraints, final settlement, and public announcements; it leaves high-frequency inference, streaming, multimodal processing, and Agent compatibility to off-chain systems.

Through User-signed credentials, an off-chain hash chain, a local Agent Gateway, and an upgradeable protocol contract, dToken aims to provide a practical balance among user experience, verifiable settlement, and an open model-service market.

---

# dToken 白皮书

版本：主网 v0  
日期：2026-05-15  
状态：发布版  

> 本文用于说明 dToken 的目标、架构、结算机制、经济设计和风险边界。本文不构成投资建议、法律意见或收益承诺。dToken 是实验性协议，任何参与者都应自行评估智能合约、流动性、外部模型端点、价格波动和运行风险。

## 什么是 dToken

dToken 中的 `d` 代表 `decentralized`，也就是去中心化。dToken 的本质含义是去中心化的大语言模型 token：它是一套围绕大语言模型服务使用、支付和最终分配建立的 token 与结算协议，并依赖去中心化区块链基础设施完成托管与结算。

dToken 本身不是大语言模型，也不会把模型推理放到链上。它为链下模型服务提供可验证的支付与结算层，让 User 和 Provider 可以通过链上托管、签名用量凭证和最终链上结算进行协作，而不是只依赖单一中心化计费账户。

## 摘要

dToken 是一套依赖去中心化区块链进行结算的大语言模型服务使用与提供协议。通过提供“链上托管 + 链下模型调用 + User 签名凭证 + 链上最终结算”的协议框架，dToken不试图把模型推理放到链上，也不要求所有请求经过统一中心化平台，而是把服务关系、托管资金、消费确认和最终分配放进可验证的规则中。

User 通过链上合约托管 dToken 并创建服务牵手。Provider 侧服务节点在线下通过其有权运营或有权接入的模型端点提供真实 LLM 服务，并根据返回的 usage 数据计算 dToken 消耗。每轮消耗都需要 User 侧会话签名确认，形成链下 dToken hash chain的凭证。最终链上合约只接受 User 签名过的 dToken 消费凭证作为结算依据。

dToken 的核心目标是：

- 让大语言模型服务可以被开放地发现、购买和提供。
- 不将大语言模型的真实使用上链，降低 gas 成本。
- 避免 Provider 单方面伪造用量。
- 避免 User 已使用服务后拒绝结算。
- 尽量减少合约 storage 负担，把高频细节留在线下。
- 兼容 Chatbot、OpenAI-compatible Agent、Anthropic Messages Agent 等多种使用方式。

## 1. 背景

大语言模型能力正在成为新的数字基础设施。高质量模型往往由少数大型机构训练和运营，用户使用模型时会遇到地域、支付方式、平台政策、账号体系、商业封闭和访问渠道碎片化等限制。除此之外，个人的特调模型除了开源以外也无从销售和使用渠道。

传统 API Key 可以解决访问权限，但不能天然解决：

- 服务前预付款风险。
- Provider 是否真实交付。
- User 是否真实确认消耗。
- token usage 是否可验证。
- 争议时如何分配托管资金。
- 第三方 Agent 和本地工具如何安全地接入模型服务。

dToken 使用区块链处理托管和最终分配，用链下签名凭证处理高频模型调用，让 User 与 Provider 在无需完全信任对方的情况下完成模型服务交易。

合规边界说明：dToken 是结算与托管协议，本身不授予任何第三方模型、API、数据集、品牌或平台的使用权。Provider 需要自行确认接入 dToken 的外部模型端点、API 凭证、自托管模型或服务来源具有适当授权，并符合相关服务条款与适用法律。

## 2. 系统角色

### User

User 是模型服务使用方。User 通过 dToken User 本地应用连接钱包，选择 Provider/模型，托管 dToken，获取 API Key，然后通过内置 Chatbot 或本地 Agent Gateway 调用模型。

User 端负责：

- 钱包连接和链上交易。
- 创建 handshake 并托管 dToken。
- 生成本地 `handshakeCredential`。
- 生成本地 `userSessionSigner`。
- 保存 API Key、聊天记录、Agent profile 和本地使用状态。
- 对每轮 dToken 消费凭证签名确认。
- 发起退出或在挑战期后完成最终结算。

### Provider

Provider 是模型服务提供方。在 dToken 中，Provider 是一个系统角色，但通常由两个实际组件组成：

- Provider 服务节点：服务器/语言模型直接提供部分，负责真实模型服务的接入、转发、计量和结算凭证管理。
- Provider Console：Provider 的链上操作控制台，用来发布和管理模型信息。

Provider 可以运营自己的模型端点，也可以把 dToken 接入其有权使用的外部模型服务，例如 DeepSeek、Kimi、Gemini、Qwen、Grok、GLM、OpenAI、Anthropic 等（在获得正式授权的情况下）。

Provider 服务节点负责：

- 验证 User 已经在链上创建 handshake 并托管 dToken。
- 验证 `handshakeCredential` 与链上 hash 一致。
- 签发 dToken API Key。
- 将请求转发到授权模型端点。
- 根据返回的 usage 数据计算真实 token 和 dToken 消耗。
- 维护链下 dToken hash chain。
- 保存最新 User 签名凭证。
- 在 User 退出、挑战或预算耗尽时执行结算策略。

Provider Console 不是独立参与方，而是 Provider 的浏览器链上操作工具。它使用浏览器钱包 RPC 与合约交互，不读取 User 本地数据，也不读取 Provider 服务节点私有数据。Provider Console 用于：

- 上链发布模型声明 event。
- 扫描当前钱包近期发布过的模型声明。
- 查看当前 Provider 的未结算牵手。
- 查看已结算牵手的最终分配结果。
- 展示基于 dToken/WETH 流动性池的价格参考。

## 3. 协议组件

### dToken Protocol Contract

协议合约负责：

- 接收 User 托管的 dToken。
- 创建和保存 handshake 的最小必要状态。
- 验证 User 签名的消费凭证。
- 处理 Provider 直接结算。
- 处理 User 发起退出后的挑战期与最终结算。
- 通过 event log 发布或刷新 Provider 模型声明。

协议合约不负责：

- 托管 Provider 侧模型访问凭证。
- 转发模型请求。
- 保存聊天记录。
- 保存每轮完整 usage 历史。
- 判断模型输出质量。

### dToken ERC20

dToken ERC20 是协议结算资产。主网版本使用固定供应 ERC20：

- 名称：dToken
- 符号：DTOKEN
- 小数位：18
- 总量：10,000,000,000,000,000 DTOKEN
- 无后续 mint 路径

ERC20 资产层与协议结算层分离。dToken ERC20 固定，协议合约通过 Proxy 结构支持升级。这样即使协议逻辑未来需要修补，也不需要重新铸造新的 dToken。

## 4. 主网合约

Ethereum Mainnet：

- dToken ERC20：`0x28219c4417d6095C66a04940D84cba13075b768b`
- Protocol Proxy：`0xc706bd1f6F1457A8953241aF64F93bd5406d751B`
- Protocol Implementation：`0xad055A36d1F442170480A116184f38b800DE4645`
- Upgrade Admin / Safe：`0x6973CE0B405637a704c0B367DbD3A302a26e2952`
- Chain ID：`1`
- 挑战期：10 分钟

升级权限由 Safe 多签控制。

### 官方主网身份与生态开发

dToken 被设计为一个开放框架。任何人都可以基于 dToken 架构开发应用、Provider 工具、Agent 集成、数据分析、文档、仪表盘、本地 Gateway 或服务节点扩展。

官方 dToken mainnet 协议由上方列出的固定 ERC20 代币地址和官方协议地址共同识别。这个边界非常重要，因为 ERC20 结算资产是整个系统的经济锚点。如果某个部署使用了不同的 ERC20 token、重新铸造了不同的结算资产、修改了协议地址，或改变了结算层，就应明确标记为 fork、扩展、实验版本或独立部署，而不应被表述为官方 dToken mainnet 协议。

协议合约保留可升级能力，是为了在不替换 dToken ERC20 的情况下修复问题和改进协议逻辑。dToken 的连续性原则很简单：ERC20 dToken 结算资产保持固定，兼容的协议逻辑可以通过 Safe 治理升级继续演进。

## 5. 核心流程

### 5.1 Provider 声明模型

Provider 使用 Provider Console 调用 `announceProvider`。链上不会永久保存完整模型市场数据，而是通过 event log 发布：

- Provider 地址。
- `metadataURI`。
- `metadataHash`。
- `offerId = hash(provider, metadataHash)`。

模型 ID、展示名、endpoint、input/output 价格、最低托管量、上下文长度、多模态能力和 tokenizer 信息应放在 metadata 或 Provider 服务节点返回的链下能力信息中。

User 通过钱包 RPC 扫描近期 Provider event logs，发现可用 Provider。这样可以避免将大量 Provider 市场数据写入合约 storage。

### 5.2 User 创建牵手

User 选择 Provider 和模型后，本地生成：

- `handshakeCredential`：用于向 Provider 服务节点证明 API Key 领取权。
- `userSessionSigner`：用于后续签署 dToken 消费凭证的本地会话签名器。

User 创建 handshake 时，链上只保存 `hash(handshakeCredential)`，不会公开 credential 原文。合约同时锁定：

- User 钱包地址。
- Provider 地址。
- User session signer 地址。
- 托管 dToken 数量。
- Provider offerId。

### 5.3 获取 API Key

User 向 Provider 服务节点申请 API Key 时提交 `handshakeCredential` 原文。服务节点查询链上 handshake，重新计算 hash。如果与链上 `handshakeCredentialHash` 一致，且 user、provider、offer、状态和托管金额匹配，则签发 API Key 和模型能力信息。

这个过程不需要 Provider 侧上链，不消耗 Provider gas。

### 5.4 调用模型

User 可以通过两种方式调用：

- dToken User 内置 Chatbot。
- 本地 Agent Gateway，供 OpenClaw、Claude Code、Hermes Agent 等 Agent 接入。

Agent 只知道本地 Gateway 的 Base URL、Agent API Key 和模型名。真实 dToken API Key、User session signer、hash chain 和预算控制都保存在本机 dToken User 服务中。

### 5.5 dToken 计费与 hash chain

每次模型调用后，Provider 侧服务节点根据模型端点返回的 usage 计算：

- input tokens。
- output tokens。
- input dToken/token 价格。
- output dToken/token 价格。
- 本轮 dToken 消耗。
- 累计 dToken 消耗。
- metering hash。
- 前一轮凭证 hash。

Provider 服务节点生成新的 dToken credential，User 本地 session signer 签名确认。只有被 User 签名过的凭证才能用于链上结算。

链上不逐轮验证完整 hash chain。hash chain 是链下连续性和审计机制；链上只验证最终 User 签名凭证、累计消耗、meteringHash、签名时间和预算上限。

### 5.6 退出与结算

有两条退出路径：

1. Provider 拿到 User 最新签名凭证后，直接调用合约结算并获得应得 dToken。
2. User 发起退出，进入 10 分钟挑战期。Provider 可以在挑战期内提交更新的 User 签名凭证进行挑战。挑战期结束后，User 或 Provider 可按已提交凭证完成最终结算。

结算时：

- Provider 获得 `min(cumulativeSpent, escrowAmount)`。
- User 收回剩余托管 dToken。
- 若 Provider 最终获得大于 0 dToken，可刷新一次 Provider 声明 event，使真实服务中的 Provider 继续保持活跃可发现。

### 5.7 Provider 服务节点上线纪律

Provider 在链上声明模型之前，应先配置并运行 Provider 服务节点。推荐顺序是：

1. 准备一个有 ETH gas 的 Provider 钱包。
2. 在服务节点中配置 Ethereum mainnet RPC、Provider 钱包、Provider 私钥、公网 `/v1` endpoint，以及有权使用的模型端点凭证。
3. 在服务节点中配置模型条目或启用模型目录。
4. 启动服务节点并检查 `/health` 和 `/v1/models`。
5. 只上链声明 `/v1/models` 中真实显示的模型。
6. 将 `/v1/models` 中的模型名、endpoint、input dToken/token 价格、output dToken/token 价格和 Provider 钱包地址精确复制到 Provider Console。

链上 Provider 声明必须与 Provider 服务节点配置完全一致。如果模型名、价格、Provider 钱包、endpoint 或 metadata hash 不匹配，User 可能能看到链上声明，但无法获得可用的 dToken API Key。

Provider 服务节点运行数据和环境变量都是敏感内容，可能包含 Provider 私钥、上游模型凭证、dToken API Key、User 签名结算凭证和服务 ledger，不应公开发布。

## 6. 经济设计

dToken 并不设计成与模型服务商 token 一一对应。不同模型公司的计费方式、输入输出价格、上下文、缓存、推理 token、多模态 token 和商业价格都不同，因此严格的一一对应不可行。

dToken 中存在三层自由价格关系：

- Provider 设定的 `dToken / model token`。
- 市场形成的 `dToken / ETH`。
- 由 ETH/USD 或其他市场数据推导出的 `dToken / USD` 参考价。

最终 Provider 的报价以 `dToken/token` 为准。USD 只是由流动性池和外部 ETH/USD 价格推导出的参考估值，不是协议承诺价格。

理想情况下，诚实、稳定、质量高且定价合理的模型服务会在开放市场中获得更多 User，进而占据市场主导地位。

### 初始分配

主网 dToken 总量为 10Q DTOKEN，即 10,000,000,000,000,000 DTOKEN。设计分配如下：

- 50%：初始流动性。
- 20%：奖励对 dToken 生态有重要贡献的开发者。
- 5%：奖励对 dToken 使用增长有明显促进的 KOL。
- 20%：用于与支持 dToken 发展的第三方个人、团队或机构合作。
- 5%：创始人保留。

初始流动性通过 Uniswap V3 的 dToken/WETH 池提供。由于早期池子较浅，价格可能剧烈波动，也可能被较小交易影响。User 和 Provider 在使用 USD 估算时应将其视为参考，而不是稳定报价。

## 7. 安全模型

dToken 的安全边界包括：

- User 钱包私钥永不上链，也不由 dToken User 保存。
- `userSessionSigner` 私钥保存在 User 本地，用于免去每次调用都手动钱包签名。
- `userSessionSigner` 公钥地址写入 handshake，用于链上验证 UserAck。
- 如果 User 本地数据或完整迁移 JSON 泄露，攻击者可能在对应 handshake 的 escrow 范围内伪造消费签名，但不能超出托管金额，也不能盗取 User 钱包资产。
- Provider 不能凭自己签名伪造消耗，结算必须依赖 User 钱包或 User session signer 签名。
- Provider 服务节点不应向未通过 `handshakeCredential` 验证的请求签发 API Key。
- 同一 handshake 在 Gateway 内部串行执行，避免并发导致 hash chain 分叉。

## 8. 风险

dToken 仍然存在以下风险：

- 智能合约 bug 或升级治理风险。
- User 本地 session signer、API Key 或完整迁移 JSON 泄露风险。
- Provider 离线、拒绝服务或外部模型端点不稳定风险。
- 模型 usage 返回不一致或 token 计量差异风险。
- 早期流动性浅导致 dToken/ETH 价格波动或滑点风险。
- Agent 工具兼容性差异导致请求格式、工具调用或多模态失败风险。
- 法律、监管、平台政策和模型服务条款变化风险。

## 9. 结论

dToken 不是一个中心化模型平台，而是一套用于大语言模型服务交易的开放结算协议。它把区块链用于最适合的部分：托管、身份约束、最终结算和公开声明；把高频模型调用、流式响应、多模态和 Agent 适配留在线下系统中完成。

通过 User 签名凭证、链下 hash chain、本地 Agent Gateway 和可升级协议合约，dToken 试图在使用体验、结算可信度和开放市场之间取得一个现实可运行的平衡。
