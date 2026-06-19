# 01 Current Product

Decimal is an AI-powered accounts-payable product on Solana: it ingests invoices, and an agent
pays approved bills in USDC from a non-custodial Squads treasury — automatically when policy
allows, or through member approval when it doesn't.

The active wedge (outbound AP / auto-pay):

```text
Invoice in (PDF/image, CSV, or manual)
  -> AI extraction into payment orders
  -> review gate (vendor address trusted? changed? look-alike?)
  -> route:
       auto-pay  (agent spends within an on-chain Squads spending limit)   OR
       proposal  (Squads members approve/reject, then execute)
  -> RPC settlement verification (USDC token-account deltas)
  -> JSON proof packet
```

## Built

- Users sign in with email/password or Google OAuth, and join organizations via invite links.
- Users hold personal signing wallets through Privy embedded wallets.
- Organizations create Squads v4 treasury vaults and manage members/thresholds via config
  proposals.
- A **vendor address book** (`counterparty_wallets`): one vendor (counterparty) can hold several
  payout addresses. Each address has a `trust_state` (unreviewed/trusted/restricted/blocked) and
  the vendor has one `is_primary` default. Addresses can be added, verified, set as default,
  archived, or removed.
- **Invoice intake**: a PDF/image or CSV becomes payment orders; OpenAI vision extracts the rows.
- **A review gate that catches the AP-fraud cases**: a new/changed payout address for a known
  vendor (account-change / BEC signal) and a near-duplicate look-alike address (OCR/transcription
  corruption) are flagged to `needs_review` before any money can move.
- **Auto-pay**: the agent pays an approved bill on its own, gated by a Squads **spending limit**
  (destinations + cap enforced on-chain by the SVM). Built on the agent wallet + a delegated
  spending limit. See [07 Payment Routing Algorithm](./07-payment-routing-algorithm.md).
- **Proposal path**: anything that doesn't qualify for auto-pay becomes a Squads voting proposal;
  members approve/reject, then it executes.
- Proposal submission and execution signatures are confirmed by Solana RPC (proxied through the
  backend so the RPC key stays server-side). Executed USDC payments are verified by parsed
  token-account deltas. Payment proof packets are deterministic JSON.

## Intentionally Not Active

- No global USDC stream indexing, no Yellowstone worker, no ClickHouse.
- Inbound collections exist as expected-inbound intent/proof records only; they do not
  auto-settle on-chain, and inbound is not the active direction (the wedge is outbound AP).
- Decimal does not custody private keys, provide fiat rails, or (yet) sync to an accounting
  system / general ledger (GL sync is planned).
