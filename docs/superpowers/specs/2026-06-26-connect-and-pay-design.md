# Connect-and-Pay Payment System — Design

**Date:** 2026-06-26
**Status:** Approved

## Goal

On connecting a wallet, charge the user `N` native tokens (default `0.1`) into a
treasury wallet configured per ecosystem. Works for injected EVM wallets
(MetaMask et al. via `window.ethereum`) on any chain, and Solana (Phantom via
`window.solana`). No WalletConnect library, no build step — this stays a vanilla
CDN-script project.

## Decisions

- **Wallets:** injected only — EVM (`window.ethereum`) + Solana (`window.solana`/Phantom).
- **Trigger:** charge fires immediately after a successful connect.
- **Amount:** `N = 0.1` native tokens, identical for every chain.
- **Treasuries:** one EVM treasury reused across all EVM chains; one Solana treasury.
  - EVM: `0xd7E147a344d7B5afEB5cc9eBCcCC0D5439E6061a`
  - Solana: `AHSKwsRWS5waAYGdDXJgod3sXoqeenSqwxnMj8oRzcQV`
- **Decline/failure:** user stays connected (identity still works) and may retry.
- **Repeat:** charge once per wallet — a wallet that has paid is never auto-charged
  again, including on auto-reconnect after reload.
- **Network:** mainnet, as specified. Configurable so a testnet can be swapped in.

## Components

### 1. `payment.config.js`
Plain script loaded before `game.js`. Sets `window.PAYMENT_CONFIG`:

```js
window.PAYMENT_CONFIG = {
  amount: 0.1,
  evm:    { treasury: "0xd7E147a344d7B5afEB5cc9eBCcCC0D5439E6061a" },
  solana: {
    treasury: "AHSKwsRWS5waAYGdDXJgod3sXoqeenSqwxnMj8oRzcQV",
    rpc: "https://solana-mainnet.g.alchemy.com/v2/l6BMmySufl3A-bEnrSmbQ3aKxT9kQX5H"
  }
};
```

All editable values (addresses, amount, RPC) live here.

### 2. `payments.js`
Exposes `window.Payments.charge(provider, address) -> Promise<txHash>`.

- **EVM** (`provider === 'MetaMask'` / any injected): compute `value` as
  `BigInt(round(amount * 1e18))` → hex string; call
  `window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: address, to: evm.treasury, value: hexWei }] })`.
  Sends on whatever chain the wallet is currently connected to.
- **Solana** (`provider === 'Phantom'`): use `@solana/web3.js` (CDN global
  `solanaWeb3`). Open a `Connection(rpc)`, fetch latest blockhash, build a
  `Transaction` with `SystemProgram.transfer({ fromPubkey, toPubkey: treasury,
  lamports: round(amount * LAMPORTS_PER_SOL) })`, then
  `window.solana.signAndSendTransaction(tx)`.
- Throws on user rejection / failure; resolves with a tx signature/hash on success.

### 3. Integration in `setupWallet()` (game.js:4263)
- A `localStorage` set `pq_paid_wallets` (JSON array of paid addresses).
- Helpers: `hasPaid(address)`, `markPaid(address, txHash)`.
- After `showConnected(provider, address)`:
  - If `hasPaid(address)` → render "Paid ✓" status, no charge.
  - Else auto-call `Payments.charge(...)`:
    - success → `markPaid`, toast "Payment sent", show "Paid ✓".
    - reject/fail → toast warning, leave connected, show retry button.
- Add to `#wallet-info` panel: a status line and a **"Pay 0.1"** button visible only
  when the connected wallet has not paid. Clicking it retries `Payments.charge`.

### 4. `index.html`
Add before `game.js`:
```html
<script src="https://unpkg.com/@solana/web3.js@1.95.3/lib/index.iife.min.js"></script>
<script src="payment.config.js"></script>
<script src="payments.js"></script>
```
Add the status line + Pay button markup inside `#wallet-info`.

### 5. game.js header comment
Update the "No tokens, no transactions" note to reflect the payment step.

## Error handling

| Case | Behaviour |
|------|-----------|
| No injected provider | Existing alert; no charge. |
| User rejects tx (EVM 4001 / Phantom reject) | Warning toast, stay connected, retry button. |
| Insufficient funds / RPC error | Warning toast, stay connected, retry button. |
| Already paid | Skip charge, show "Paid ✓". |
| Solana lib not loaded | Warning toast, no charge. |

## Out of scope
- Server-side verification of payment (this is a no-backend client).
- Receipts/refunds, fiat, ERC-20 / SPL tokens (native only).
- WalletConnect / mobile QR flows.
