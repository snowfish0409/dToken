# Wallet and On-Chain Contract Calls

## Scope

This skill is for using the dToken contract framework through the apps, not rewriting contracts.

## Mainnet Contract Identity

- dToken ERC20: `0x28219c4417d6095C66a04940D84cba13075b768b`
- Protocol Proxy: `0xc706bd1f6F1457A8953241aF64F93bd5406d751B`
- Chain ID: `1`
- Chain: Ethereum mainnet

Use the deployment JSON in the relevant app package as the local contract reference.

## Wallet Model

Browser-facing apps should use the browser wallet provider:

- EIP-1193 `window.ethereum`
- EIP-6963 wallet discovery when present
- `ethers.BrowserProvider(provider)`
- connected wallet signer for transactions

Use a browser environment that supports the wallet extension. Do not paste private keys into the app.

## Provider Announcement

Provider Console calls the protocol with Provider wallet signer. The important action is announcing a Provider model offer. The chain emits a `ProviderAnnounced` event with Provider operator, offer id, metadata hash/URI, and version.

Keep rich model metadata off-chain or in emitted metadata references. Provider Console fields must match Reseller `/v1/models`.

## User Handshake

User opens a handshake by:

1. selecting a Provider offer
2. preparing session signer and handshake credential
3. approving or transferring dToken escrow as required by the app flow
4. calling the protocol to open the handshake
5. storing local session/key material needed to sign usage credentials

Escrow is denominated in dToken. UI should make dToken units explicit.

For monitoring, the on-chain handshake is the source for escrow amount and status. Remaining budget still depends on off-chain cumulative usage credentials recorded by User/Reseller.

## API Key Issuance

After handshake, User app requests a dToken API key from the Reseller. Reseller verifies:

- handshake exists on-chain
- handshake status is open
- Provider/operator/offer matches local model config
- escrow is sufficient
- handshake credential hash matches

Then it issues a local API key and returns model capability data.

## Usage Credentials

High-frequency usage is off-chain. The User-side session signer signs cumulative dToken spend credentials. Reseller stores these credentials and uses the highest valid cumulative spend for settlement. Leaked session signer/local migration data can authorize spend within escrow limits, so treat it as sensitive.

## Settlement and Exit

Final settlement distributes escrow based on accepted User-signed cumulative spend:

- Provider receives up to cumulative spent, capped by escrow.
- User receives remaining escrow.

Provider-side settlement may be automated by Reseller; User exit is handled by User app flow.

## RPC and Network

Use Ethereum mainnet RPC for official dToken. If scans fail with errors like `quorum not met` or wrong block numbers, confirm the wallet RPC is on mainnet and the app provider is not mixing incompatible RPC sources.
