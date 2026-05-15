# dToken Contract Release

Publishable mainnet contract source package for transparency and review.

Included source files:

- `contracts/DTokenFixed.sol`
- `contracts/DTokenProtocolCurrentUpgradeable.sol`
- `contracts/DTokenProxy.sol`

Mainnet addresses:

- dToken ERC20: `0x28219c4417d6095C66a04940D84cba13075b768b`
- Protocol Proxy: `0xc706bd1f6F1457A8953241aF64F93bd5406d751B`
- Protocol Implementation: `0xad055A36d1F442170480A116184f38b800DE4645`
- Upgrade Admin / Safe: `0x6973CE0B405637a704c0B367DbD3A302a26e2952`

Notes:

- The ERC20 token has fixed supply and no post-deployment mint function.
- The protocol is upgradeable through the Safe-controlled proxy admin path.
- User settlement is based on User-signed cumulative dToken settlement credentials.
- High-frequency model calls and dToken hash-chain details are off-chain; the contract verifies only the settlement credential needed for final distribution.

---

# dToken 合约发布包

这是可公开发布的主网合约源码包，用于透明审阅。

包含源码：

- `contracts/DTokenFixed.sol`
- `contracts/DTokenProtocolCurrentUpgradeable.sol`
- `contracts/DTokenProxy.sol`

主网地址：

- dToken ERC20：`0x28219c4417d6095C66a04940D84cba13075b768b`
- Protocol Proxy：`0xc706bd1f6F1457A8953241aF64F93bd5406d751B`
- Protocol Implementation：`0xad055A36d1F442170480A116184f38b800DE4645`
- Upgrade Admin / Safe：`0x6973CE0B405637a704c0B367DbD3A302a26e2952`

说明：

- ERC20 dToken 固定总量，部署后没有继续 mint 函数。
- 协议合约通过 Safe 控制的 proxy admin 路径升级。
- User 结算以 User 签名的累计 dToken 凭证为准。
- 高频模型调用和 dToken hash chain 细节位于链下；合约只验证最终分配所需的结算凭证。
