# Backend Handoff: Devnet / Mainnet Network Mode

Owner: codex (backend) + small frontend + Makefile follow-ups
Frontend status: waiting on the network-source-of-truth (capabilities/session response field) before the explorer + RPC URL switching can land
Cost constraint: zero paid services. No Helius, no paid Yellowstone, no paid RPC tier.

## Why

Right now everything points at Solana mainnet:

- `api/src/solana.ts` hardcodes the mainnet USDC mint
  (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`).
- `api/.env` `SOLANA_RPC_URL` is a mainnet Alchemy URL.
- `config/frontend.public.json` `solanaRpcUrl` is the same mainnet URL.
- `frontend/src/lib/app.ts` `orbAccountUrl`/`orbTransactionUrl` point at
  Orb, which is mainnet-only.
- `yellowstone/src/yellowstone/subscriptions.rs` filters on the same
  mainnet USDC mint.

Every Squads creation test, every Privy signing roundtrip, every
preview/sign/submit cycle currently spends real mainnet SOL. The user
is testing actively and the burn is real. We need to be able to do
all that on devnet for free, and flip back to mainnet when demoing
or running for grant evaluators.

## Scope

In scope:

- Single env var (`SOLANA_NETWORK=devnet|mainnet`) drives every
  network-specific runtime constant.
- Backend reads it once at startup; derives USDC mint, default RPC
  URL fallback, and exposes the network on the capabilities response
  so the frontend doesn't have to read a build-time constant.
- Frontend reads the network from the capabilities response (or from
  a small capabilities-fetched client store) and uses it to pick the
  right Solana Explorer URL for account/transaction links and the
  right RPC URL for client-side `Connection` usage.
- New Makefile targets: `prod-backend-devnet`, `prod-backend-mainnet`,
  and `prod-backend` as an alias of `-mainnet` (preserve muscle memory).
- `api/.env.example` documents the new env var.

Out of scope (deliberately):

- **Yellowstone work.** Parafi is mainnet-only and we are not paying
  for Helius (or any other devnet Yellowstone provider). Devnet mode
  simply skips starting the Yellowstone worker. Reconciliation
  doesn't work on devnet — that's fine, we're not testing it. When
  payments/collections matching becomes the focus, that's a separate
  tranche where the cost decision gets revisited.
- Database schema changes. Treasury/personal wallet rows already
  carry a `chain` column. There is no per-network table split. Same
  Privy wallet address works on both networks because Solana wallets
  are network-agnostic at the key level.
- Existing mainnet records — leave alone. If the user has
  mainnet-created treasuries on file and switches to devnet, those
  rows just become inactive in practice (their chain state is invisible
  on devnet). Acceptable for our hackathon-stage app.

## Network constants reference

These are the only things that change between networks:

| What | Mainnet | Devnet |
|------|---------|--------|
| USDC mint | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| Default RPC | (whatever's in `api/.env` today, Alchemy) | `https://api.devnet.solana.com` (free, public, rate-limited but fine for dev) |
| Solana Explorer | `https://explorer.solana.com/address/<addr>` | `https://explorer.solana.com/address/<addr>?cluster=devnet` |
| Orb explorer | works | does not work — fall back to Solana Explorer |
| Squads v4 program | same program id on both networks | same |

## Backend changes

### 1. `api/src/config.ts` — add network parsing

Read `SOLANA_NETWORK` from env, default `mainnet`, validate to the
union `'devnet' | 'mainnet'`. Export:

```ts
export type SolanaNetwork = 'devnet' | 'mainnet';

export function getSolanaNetwork(): SolanaNetwork {
  const raw = (process.env.SOLANA_NETWORK ?? 'mainnet').toLowerCase();
  if (raw !== 'devnet' && raw !== 'mainnet') {
    throw new Error(`Invalid SOLANA_NETWORK="${raw}". Use 'devnet' or 'mainnet'.`);
  }
  return raw as SolanaNetwork;
}
```

Also default `SOLANA_RPC_URL` to `https://api.devnet.solana.com` when
network is devnet AND the env var is unset. Mainnet keeps its current
behavior (require env or fall back to mainnet-beta if missing).

### 2. `api/src/solana.ts` — network-aware USDC mint

Replace the hardcoded `USDC_MINT` constant with a function:

```ts
const USDC_MINT_MAINNET = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDC_MINT_DEVNET = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

export function getUsdcMint(network: SolanaNetwork = getSolanaNetwork()): PublicKey {
  return network === 'devnet' ? USDC_MINT_DEVNET : USDC_MINT_MAINNET;
}

// Keep USDC_MINT export for backwards compat at startup time:
export const USDC_MINT = getUsdcMint();
```

Importers (`payment-orders.ts`, `payment-runs.ts`) keep working without
changes since they import `USDC_MINT`.

If you want to be paranoid about runtime safety, audit those importers
and switch them to `getUsdcMint()` so a future env-var change at
runtime takes effect. For our use case (env set once at startup), the
constant export is fine.

### 3. `api/src/squads-treasury.ts` — Squads program id

Squads v4 uses the same program id on both networks, so no change
needed unless you want to make it explicit/verifiable. Add a comment
clarifying this.

### 4. Capabilities response

`GET /capabilities` (`api/src/routes/capabilities.ts`) should include
the active network so the frontend knows where to send users for
explorer links and which RPC URL to use:

```jsonc
{
  "...existing fields...": "...",
  "solana": {
    "network": "devnet",
    "usdcMint": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    "rpcUrl": "https://api.devnet.solana.com"
  }
}
```

Reasoning: the frontend already calls capabilities once on mount.
Adding network there means we don't need a second `/network` endpoint
or a build-time config split between devnet and mainnet bundles. Same
Vercel deploy serves both modes — the API tells it which one it is.

### 5. `api/.env.example`

Add the new env var with both values commented for clarity:

```
# SOLANA_NETWORK controls which Solana cluster the API + worker target.
# Affects USDC mint, Squads/treasury operations, and the network advertised
# to the frontend via /capabilities.
SOLANA_NETWORK=devnet
# SOLANA_NETWORK=mainnet
SOLANA_RPC_URL=https://api.devnet.solana.com
```

### 6. Validation logging at startup

The API should log the active Solana network at startup so misconfig
is obvious:

```
solana network = devnet
solana rpc     = https://api.devnet.solana.com
usdc mint      = 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
```

Yellowstone worker logs the same when it starts (when running on
mainnet — devnet mode skips it).

## Frontend changes

These are small. Easier for codex to do them as part of the same PR
since they're tightly coupled to the capabilities response shape.

### 1. `frontend/src/types.ts`

Add:

```ts
export type SolanaNetwork = 'devnet' | 'mainnet';

export type CapabilitiesResponse = {
  // ...existing fields...
  solana: {
    network: SolanaNetwork;
    usdcMint: string;
    rpcUrl: string;
  };
};
```

### 2. `frontend/src/api.ts`

If `getCapabilities()` already exists, update its return type. If
not, add it.

### 3. `frontend/src/lib/app.ts` — explorer URL switching

Replace the unconditional Orb URLs with network-aware helpers:

```ts
export function explorerAccountUrl(address: string, network: SolanaNetwork): string {
  if (network === 'mainnet') return `https://orbmarkets.io/address/${address}`;
  return `https://explorer.solana.com/address/${address}?cluster=devnet`;
}

export function explorerTransactionUrl(signature: string, network: SolanaNetwork): string {
  if (network === 'mainnet') return `https://orbmarkets.io/tx/${signature}`;
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}
```

The current `orbAccountUrl`/`orbTransactionUrl` callers are in:

- `frontend/src/App.tsx` (Profile page personal wallet table)
- `frontend/src/pages/Wallets.tsx` (treasury account address column)
- `frontend/src/pages/PaymentDetail.tsx`, `PaymentRunDetail.tsx`,
  `Settlement.tsx`, etc. (any signature/address link)

Migrating them: pass the network down from a small client-side store
seeded by the capabilities response. A simple `useNetwork()` hook
backed by React Query keyed `['capabilities']` is enough.

Keep the old functions as thin shims that call `explorerAccountUrl`
with `'mainnet'` so unmigrated call sites don't break — then migrate
gradually.

### 4. `frontend/src/lib/solana-wallet.ts` — Connection RPC URL

`resolveSolanaRpcUrl()` currently reads from `config/frontend.public.json`.
Update it to prefer the capabilities-supplied RPC URL if available,
falling back to the public.json value. Browser-side `Connection`
objects (used in `runSignAndConfirm` for Squads) need to point at the
right cluster, otherwise sendRawTransaction goes to the wrong network.

### 5. `config/frontend.public.json`

Change `solanaRpcUrl` to `https://api.devnet.solana.com` so
unauthenticated paths (landing page demos, etc.) default to devnet.
Authenticated paths will use the capabilities-supplied URL.

This is the single source of truth in the public bundle. Don't
duplicate config files — Vercel serves the same bundle for both modes.

## Makefile changes

Three targets after this lands:

```make
prod-backend-devnet:
	export SOLANA_NETWORK=devnet && \
	export SOLANA_RPC_URL="${SOLANA_RPC_URL:-https://api.devnet.solana.com}" && \
	$(MAKE) _prod-backend-shared SKIP_WORKER=1

prod-backend-mainnet:
	export SOLANA_NETWORK=mainnet && \
	$(MAKE) _prod-backend-shared

prod-backend: prod-backend-mainnet
```

Where `_prod-backend-shared` is the existing prod-backend recipe
factored into a private target, and the devnet variant sets
`SKIP_WORKER=1` (or some equivalent) so the recipe skips the
`(cd yellowstone && exec cargo run)` block.

Update help text accordingly. Update doc 11 (operating-testing-and-debugging)
to document the new targets and the why (no devnet Yellowstone).

## What this does NOT change

- Privy wallet creation / signing — Privy wallets work on both
  networks with the same address. No Privy config change.
- Treasury/personal wallet records — schema unchanged.
- Postgres / ClickHouse — local docker, network-agnostic.
- Existing mainnet treasuries — they remain in the database. On
  devnet mode their balances will report as zero / RPC errors because
  those addresses don't exist on devnet. That's fine for our purposes;
  if it gets noisy we can add a `network` column on `treasury_wallets`
  later and filter the list to active-network rows. Don't do that now —
  premature.

## Yellowstone — explicit non-decision

Yellowstone work is **explicitly excluded** from this tranche.
Devnet mode runs without the worker. Effects:

- Payment matching does not work on devnet. CSV import → Squads
  proposal preparation → on-chain execution all work, but the
  matcher writes nothing because the worker isn't running.
- Collections matching does not work on devnet, same reason.
- The frontend's "matching state" UI (proof packets etc.) will
  show pending forever on devnet.

This is acceptable for the current focus (Squads creation, Privy
signing, treasury setup UX). When the focus shifts to payments and
reconciliation, we revisit:

- Helius offers devnet Yellowstone but costs money. Not viable today.
- Could try a self-hosted Yellowstone Geyser plugin against a public
  devnet validator — possible but operationally heavy.
- Easier short-term: write a polling-based observer that hits
  `getSignaturesForAddress` for each treasury wallet at a slow
  interval. Not real-time but catches transfers eventually. Could
  satisfy devnet reconciliation needs.

None of that lands in this tranche.

## Recovery & retry behavior — fix while you're in there

Frontend `runSignAndConfirm` in `Wallets.tsx` already handles the
"tx submitted, confirmation polling failed" recovery correctly — the
retry path skips the blockhash-dependent step and calls backend
confirm directly via signature. Confirmed working in user testing
(Squads multisig at `94kYyVPUbCYwenH3DZtAy7LzDcHmvpv56BmyQkKRdfVh`
created via the retry click).

Polish that's worth landing:

- After `confirmTransaction` times out (block height exceeded), poll
  `connection.getSignatureStatuses([sig])` once. If the status shows
  the tx confirmed/finalized on chain, skip directly to backend
  confirm and don't show the user a scary "confirmation failed"
  banner — they didn't fail, the polling did.
- Only show the recoverable-state error when the signature genuinely
  isn't on chain after the polling check.

This is in `frontend/src/pages/Wallets.tsx`, not really backend, so
optional for this handoff — flag it for a frontend follow-up if you
don't want to touch frontend in this commit.

## Validation

After you implement:

1. `make prod-backend-devnet` — API logs `solana network = devnet`,
   USDC mint shows the devnet address.
2. Browser at `decimal.finance` → `/capabilities` returns
   `solana.network: 'devnet'`.
3. Profile → Create personal wallet → Privy creates a Solana wallet.
4. Fund that wallet from a devnet faucet (`solana airdrop 1 <addr>
   --url devnet`, or one of the public web faucets).
5. Treasury accounts → Create Squads treasury → fill name → Prepare →
   Review → Sign and create. Should complete end-to-end without
   spending mainnet SOL.
6. Verify the new treasury row uses the devnet explorer link.
7. `make prod-backend-mainnet` — API logs the mainnet equivalents,
   browser sees mainnet capabilities, links go to Orb.
8. `make test-api` still passes.

## Files codex will touch (rough)

- `api/src/config.ts`
- `api/src/solana.ts`
- `api/src/routes/capabilities.ts`
- `api/.env.example`
- `frontend/src/types.ts`
- `frontend/src/api.ts`
- `frontend/src/lib/app.ts`
- `frontend/src/lib/solana-wallet.ts`
- `frontend/src/pages/Wallets.tsx` (only if doing the retry polish)
- `frontend/src/pages/PaymentDetail.tsx`, `PaymentRunDetail.tsx`,
  `Settlement.tsx`, `App.tsx` — explorer URL migrations
- `config/frontend.public.json`
- `Makefile`
- `system_explained/11-operating-testing-and-debugging.md` — document
  the new targets and the no-devnet-Yellowstone constraint

## Author note

This handoff is from Claude Code (frontend assistant). I'm flagging
the cost constraint up top because the easy path here is "just pay
Helius for devnet Yellowstone" and we explicitly cannot do that.
