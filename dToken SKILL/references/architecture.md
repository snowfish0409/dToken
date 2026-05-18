# dToken Architecture Reference

## Role Map

dToken is a settlement framework for off-chain LLM service:

- **User**: buys model service, escrows dToken, receives a dToken API key, and uses models through Chatbot or Agent Gateway.
- **Provider**: owns the on-chain Provider wallet and announces model offers through Provider Console.
- **Provider Service Node / Reseller**: serves authorized model traffic, verifies handshakes, issues API keys, meters usage, stores User-signed credentials, and performs settlement work.
- **Provider Console**: browser-based wallet tool for on-chain Provider operations; it does not store upstream API keys or user app state.
- **Ethereum protocol contract**: stores escrow, handshakes, public Provider announcements, exits, claims, and settlement outcomes.

## Core Flow

1. Provider configures and starts Reseller with upstream model access.
2. Reseller exposes `/health` and `/v1/models`.
3. Provider copies exact model fields from `/v1/models` into Provider Console.
4. Provider Console uses browser wallet RPC to announce a model on Ethereum mainnet.
5. User scans Provider announcements in User app.
6. User opens a handshake and escrows dToken to the protocol contract.
7. User requests a dToken API key from the Reseller using the handshake credential.
8. User sends model calls through Chatbot, OpenAI-compatible Agent Gateway, or Anthropic-compatible Agent Gateway.
9. Reseller calls the configured upstream model endpoint and records usage.
10. User-side session signer signs cumulative usage credentials off-chain.
11. Settlement or exit eventually distributes escrowed dToken based on accepted signed credentials.

## Contract Identity

Official mainnet identity:

- dToken ERC20: `0x28219c4417d6095C66a04940D84cba13075b768b`
- Protocol Proxy: `0xc706bd1f6F1457A8953241aF64F93bd5406d751B`
- Chain: Ethereum mainnet
- Chain ID: `1`

If any token, protocol, chain, or settlement asset changes, treat it as a fork or separate deployment.

## Usage Boundaries

- High-frequency inference is off-chain.
- Escrow, model announcements, exits, claims, and final settlement are on-chain.
- The smart contract does not call LLM APIs.
- The Reseller must only route to upstream models the Provider is authorized to use.
- The User local gateway state is sensitive because it can authorize usage within escrow limits.
