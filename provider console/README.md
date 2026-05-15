# dToken Provider Console

Standalone browser console for Providers.

The Provider Console depends only on:

- browser wallet extension
- wallet RPC
- Ethereum mainnet dToken contracts
- the deployment JSON and bundled ethers package in this directory

It does not read User app data, Agent Gateway state, Reseller private data, or upstream API keys.

## Start

```bash
npm install
npm run serve
```

Open:

```text
http://127.0.0.1:8792/
```

## Features

- connect and disconnect browser wallet
- announce Provider model offers on-chain
- update or delist model offers
- scan `ProviderAnnounced` events through the wallet RPC
- inspect handshakes involving the connected Provider wallet
- display open/unsettled handshakes separately from settled handshakes
- show dToken/ETH pool price reference
- show ETH/USD estimates when the external price source is available

The console does not manage dToken API keys, upstream model availability, multimodal policies, User chat history, or Gateway profiles. Those belong to the Reseller Server and User app.

---

# dToken Provider Console 中文说明

这是可独立运行的 Provider 浏览器控制台。

Provider Console 只依赖：

- 浏览器钱包插件
- 钱包 RPC
- Ethereum mainnet dToken 合约
- 本目录中的部署 JSON 和 ethers 浏览器包

它不读取 User 端数据、Agent Gateway 状态、Reseller 私有数据或上游 API Key。

## 启动

```bash
npm install
npm run serve
```

打开：

```text
http://127.0.0.1:8792/
```

## 功能

- 连接和退出浏览器钱包
- Provider 模型链上声明
- 更新或下架模型声明
- 通过钱包 RPC 扫描 `ProviderAnnounced` event
- 查看与当前 Provider 钱包相关的牵手
- 分开展示未结算牵手和已结算牵手
- 显示 dToken/ETH 池子价格参考
- 外部价格源可用时显示 ETH/USD 估算

该控制台不管理 dToken API Key、上游模型可用性、多模态策略、User 聊天记录或 Gateway profile。这些内容属于 Reseller Server 和 User App。
