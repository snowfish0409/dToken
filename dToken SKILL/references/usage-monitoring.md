# Usage Monitoring and Spend Alerts

## Purpose

Use this reference when the user asks about dToken usage, remaining escrow, model-call cost, spend alerts, monitoring, or whether an agent should continue a task.

This is an operational guide. It does not grant wallet authority and does not store credentials.

## Core Budget Model

For an active handshake:

```text
remaining dToken = escrowAmount - cumulativeSpent
```

Where:

- `escrowAmount`: dToken escrow opened on-chain for the handshake.
- `cumulativeSpent`: latest accepted or locally recorded cumulative spend for that handshake.
- `remaining`: budget available before the escrow is exhausted.

Use this as the starting estimate, then cross-check with app state, Reseller ledger, and on-chain status.

## Data Sources

Prefer sources in this order, depending on what the user has access to:

1. **User app UI**
   - selected model
   - handshake status
   - escrow amount
   - displayed Gateway consumption
   - remaining balance

2. **User Agent Gateway local data**
   - bound model profile
   - local usage ledger
   - latest session signer state
   - issued dToken API key state

3. **Reseller service node**
   - issued API key status
   - per-handshake usage ledger
   - latest cumulative spend
   - latest User-signed usage credential
   - upstream usage returned by model provider

4. **Ethereum contract state**
   - handshake status
   - escrow amount
   - Provider operator
   - User wallet
   - pending exit or settlement status

When sources disagree, prefer the most settlement-relevant record: latest valid User-signed cumulative credential plus on-chain handshake status. Explain uncertainty.

## What To Monitor

For User-side use:

- active handshake id
- selected Provider/model
- escrow amount
- current cumulative spend
- remaining dToken
- round count or request count
- last successful model call time
- last error
- local gateway endpoint in use

For Provider/Reseller-side operation:

- model health
- upstream API status
- issued dToken API keys
- per-handshake cumulative spend
- unsigned or missing usage records
- latest settlement credential
- unsettled handshakes
- upstream timeout or 5xx rate

## Alert Thresholds

Use conservative defaults unless the user provides their own:

- **Warning**: remaining escrow below 30%.
- **Critical**: remaining escrow below 10%.
- **Stop and ask**: projected next task cost may exceed remaining escrow.
- **Manual confirmation required**: opening new escrow, increasing escrow materially, settlement, exit, or any wallet transaction.

If the app reports dToken in large units, normalize before comparing:

```text
1 = dToken
K = 1,000 dToken
M = 1,000,000 dToken
B = 1,000,000,000 dToken
T = 1,000,000,000,000 dToken
```

## Before Long Agent Tasks

Before starting a long coding or research task through dToken:

1. Identify selected model and Provider.
2. Read current remaining dToken.
3. Check input/output token prices.
4. Estimate whether the task can fit inside the remaining escrow.
5. Warn the user if the task is long, parallel, multimodal, or likely to stream many tokens.
6. Avoid running multiple heavy parallel tasks through a small remaining escrow.

The estimate can be rough. The key is to avoid silent budget exhaustion.

## During Long Tasks

If the task is active and the agent has access to local gateway or Reseller status:

- periodically check cumulative spend
- watch for no-output-but-token-consuming symptoms
- stop or ask when remaining dToken crosses the critical threshold
- record the last known model, handshake, spend, and error if the task fails

Do not hide spend uncertainty. If only UI screenshots are available, say the estimate is based on visible UI state.

## After Errors

If tokens were consumed but the client returned an error:

1. Check whether the Reseller recorded usage.
2. Check whether User Gateway recorded a signed cumulative credential.
3. Check whether the client received partial output.
4. Check whether the error was upstream timeout, stream conversion, 502, or client compatibility.
5. Report both functional failure and possible dToken spend impact.

Use wording like:

```text
The model call may have consumed dToken because the Reseller recorded upstream usage before the client error. Verify the latest cumulative spend before retrying.
```

## Agent Autonomy Boundary

An agent may automatically:

- read visible balance/usage
- compute remaining dToken
- warn on thresholds
- suggest adding escrow
- suggest switching to a cheaper model
- stop a non-critical task before budget exhaustion

An agent should require explicit user confirmation before:

- wallet transactions
- opening a new handshake
- increasing escrow
- settlement or exit actions
- using a new Provider
- continuing after a critical spend warning

Do not design usage monitoring as a hidden auto-spend system. The user should know when dToken is being consumed and by which model.
