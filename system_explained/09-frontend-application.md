# 09 Frontend Application

The frontend lives in `frontend/` and is a Vite + React + TypeScript app with React Router and TanStack Query. It talks to the API only — no direct ClickHouse or Postgres access. The backend enforces every business rule; the frontend is one client among several (human UI, API keys, agents).

## High-level shape

- `frontend/src/App.tsx` — a thin router shell. Mounts auth, the sidebar, and one `<Route>` per page.
- `frontend/src/Sidebar.tsx` — institutional sidebar: workspace switcher, nav groups (**Operations** / **Registry** / **Advanced**), theme toggle, profile menu.
- `frontend/src/pages/*.tsx` — one file per top-level page. This is where the real UI logic lives.
- `frontend/src/api.ts` — typed HTTP client for every endpoint the UI uses.
- `frontend/src/domain.ts` — cross-cutting helpers: address shortening, USDC formatting, Solana wallet discovery / signing, USD value computation.
- `frontend/src/ui/Toast.tsx` — toast provider used by every page for success / error / info notices.
- `frontend/src/styles/` — the design system (see below).

There used to be one big `App.tsx` containing most pages. That monolith is legacy; active pages live under `frontend/src/pages/`.

## Design system

Institutional, not consumer. Dual theme — light-default, dark first-class. References: Linear, Mercury, Stripe, Bloomberg Terminal. Source of truth for the brand lives in `brand.md` at the repo root.

### Tokens

All colors, spacing, and typography hang off `--ax-*` CSS variables defined in `frontend/src/styles/design-tokens.css`. Two theme roots:

- `:root` — light defaults.
- `:root[data-theme='dark']` — dark overrides.

Key token families (full list in `brand.md`):

- Surfaces: `--ax-surface-0` through `--ax-surface-3`.
- Text: `--ax-text`, `--ax-text-secondary`, `--ax-text-muted`, `--ax-text-faint`.
- Borders: `--ax-border`, `--ax-border-strong`.
- Accent (verified-green): `--ax-accent`, `--ax-accent-hover`, `--ax-accent-dim`, `--ax-on-accent`.
- Semantic: `--ax-warning`, `--ax-danger`, `--ax-info`.
- Typography: Geist Variable for UI, system mono stack for numbers / addresses / signatures (`font-variant-numeric: tabular-nums`).

Never hardcode colors or spacing. If you need a new shade, add a token.

### Stylesheets

- `frontend/src/styles/design-tokens.css` — the tokens above.
- `frontend/src/styles/canonical.css` — canonical components: buttons (`rd-btn`, `rd-btn-primary`, `rd-btn-secondary`, `rd-btn-ghost`, `rd-btn-danger`), inputs (`.field`, `.rd-input`, `.rd-select`), dialogs (`.rd-dialog-backdrop`, `.rd-dialog`), tables (`.rd-table-shell`, `.rd-table`), pills (`.rd-pill`), metric blocks (`.rd-metrics`, `.rd-metric`).
- `frontend/src/styles/run-detail.css` — the `rd-*` layer used everywhere: recipient blocks, filter bars, tables, signature/address links, primary action cards, skeleton loaders. Amount columns use `.rd-num` (left-aligned, mono, tabular-nums).
- `frontend/src/styles/sidebar.css` — sidebar layout, nav items, theme toggle.
- `frontend/src/styles/app-dark.css` — dark-theme overrides applied at `:root[data-theme='dark']`.
- `frontend/src/styles.css` — legacy global rules still carrying the older `.panel` / `.data-table` patterns. New code should prefer the files above.

### Batch-expandable table pattern

Four pages use the same expandable-rows pattern: **Proofs**, **Execution**, **Settlement**, **Approvals**.

- Each row represents a group: either a `PaymentRun` (batch) or a standalone `PaymentOrder`.
- Run rows show aggregate info (item count, total, status pill) and a chevron.
- Clicking the run row toggles child rows indented with a `↳` marker — one per payment in the run.
- Standalone rows are flat and don't expand.
- Amount columns live under `rd-num`.

If you add another list view that mixes batches and singles, use this same pattern — don't invent a new one.

## Top-level routes

From `App.tsx`:

- `/` — entry redirect.
- `/landing` — pre-auth landing.
- `/login` — login form.
- `/setup` — onboarding.
- `/profile` — user profile + sessions.
- `/workspaces/:workspaceId` → **CommandCenter** (Overview).
- `/workspaces/:workspaceId/wallets` → **Wallets** (treasury wallets + live balances).
- `/workspaces/:workspaceId/counterparties` → **Counterparties** (destinations + counterparties with Edit modal).
- `/workspaces/:workspaceId/registry` → legacy Address Book (retained but not linked from primary nav).
- `/workspaces/:workspaceId/requests` → Payment Requests (legacy list).
- `/workspaces/:workspaceId/payments` and `/workspaces/:workspaceId/runs` → unified **Payments** page.
- `/workspaces/:workspaceId/runs/:paymentRunId` → **PaymentRunDetail**.
- `/workspaces/:workspaceId/payments/:paymentOrderId` → **PaymentDetail**.
- `/workspaces/:workspaceId/approvals` → **Approvals** (supports `?runId=X` filter).
- `/workspaces/:workspaceId/execution` → **Execution** (Ready to sign / In flight / Executed).
- `/workspaces/:workspaceId/settlement` → **Settlement** (Matched / Pending / Exceptions).
- `/workspaces/:workspaceId/proofs` → **Proofs**.
- `/workspaces/:workspaceId/policy` → Policy.
- `/workspaces/:workspaceId/exceptions` → Exceptions.

## Page-by-page notes

### CommandCenter (Overview)

File: `frontend/src/pages/CommandCenter.tsx`.

What it answers: *"Is my workspace healthy right now, and what should I do next?"*

- Treasury hero at the top — total USD value (span 2 columns), total USDC, total SOL. Uses `/treasury-wallets/balances` + `pricing.ts`.
- Operations metric strip: Awaiting approval / Ready to sign / In flight / Settled.
- Exceptions banner if there are open exceptions.
- Recent activity table — same shape as the Payments table (Recipient/Run, Destination, Source, Amount, Origin, Status), capped at 8 rows, "View all" link.
- Onboarding empty state when the workspace has no wallets/destinations/payments (three-step checklist).

### Wallets

File: `frontend/src/pages/Wallets.tsx`.

Registers and monitors the workspace's `TreasuryWallet` rows. Polls `/treasury-wallets/balances` every 15 s. Shows per-wallet USDC + SOL + USD value and an `rpcError` column when balance fetches fail. Add-wallet dialog is the only mutation.

### Counterparties

File: `frontend/src/pages/Counterparties.tsx`.

Two concerns on one page: destinations (top, main table) and counterparties (bottom, card grid).

- Destinations table: Label, Counterparty, Wallet, Trust pill, Type (internal/external), Actions column with **Edit** button.
- Edit modal: label, trust state (`unreviewed | trusted | restricted | blocked`), counterparty tag, notes, active flag. Wallet address is read-only.
- Filters: All / Trusted / Unreviewed / Blocked.
- Counterparties section is just name + category cards.

### Payments

File: `frontend/src/pages/Payments.tsx`.

Unified list of `PaymentRun`s and standalone `PaymentOrder`s. Columns: Recipient/Run, Destination, Source (treasury wallet), Amount, Origin pill (`Single` / `Batch · N rows`), Status. Click any row to navigate to the batch or the order detail.

Also hosts:
- **Create payment** dialog (single order, destination + amount + reason).
- **Import CSV** dialog with preview step, widened preview modal, and duplicate-fingerprint error surfacing: if the backend returns `importResult.imported === 0` with an existing `paymentRun`, the UI raises a "This CSV was already imported as '<name>'" error instead of reporting success.

### PaymentRunDetail

File: `frontend/src/pages/PaymentRunDetail.tsx`.

Per-run lifecycle view.

- Lifecycle rail: Imported → Reviewed → Approved → Executed → Settled → Proven. Execute turns green once any child order has a submitted signature (not waiting for the aggregate `derivedState` to catch up).
- Primary action card based on run state:
  - `needs_approval`: "Approve all (N)" + "Review individually →" (routes drafts, navigates to `/approvals?runId=X`).
  - `ready_to_sign`: source-wallet picker + signing-wallet picker + Sign-and-submit.
  - `in_flight`: shows submitted signatures, auto-refreshes.
  - `settled`: Download proof JSON.
  - `exception`: message pointing at the rows table.
- Payments-in-this-run table with per-order status + signature + Details link.

### PaymentDetail

File: `frontend/src/pages/PaymentDetail.tsx`.

Single-order view: approval timeline, execution state, reconciliation detail, proof preview, audit export.

### Approvals

File: `frontend/src/pages/Approvals.tsx`.

Batch-expandable pending table:

- Batch rows show item count, batch total, reason line, age, and a `Approve batch (N)` / `Reject batch` pair (green / red).
- Expand to reveal per-order rows with individual Approve / Reject.
- Standalone (non-batch) pending orders are flat rows.

Decision history table below also uses batch-expandable rows. A batch decision row aggregates its children into a single pill (`Approved (N)` / `Rejected (N)` / `Escalated (N)` / `Mixed · Xa · Yr`).

If the page is opened with `?runId=<uuid>`, a banner appears at the top ("Reviewing batch: <runName>") with "Back to run" and "Clear filter" actions. The list is scoped to that run.

### Proofs

File: `frontend/src/pages/Proofs.tsx`.

Single unified table — no tabs, no "needs review vs exported" segregation (proofs are always available). Batches expand to reveal child payments. Each row has inline **Preview** + **Export** buttons. Preview opens a wide modal with `ProofJsonView` rendering the packet structure.

### Execution

File: `frontend/src/pages/Execution.tsx`.

Tabs: **All / Ready to sign / In flight / Executed**. Batch-expandable rows. Batch rows show the aggregate signature (first + `+N` chip when more than one); expanded children show per-order signature and an action button (`Open signer` / `Track settlement` / `Resolve`).

### Settlement

File: `frontend/src/pages/Settlement.tsx`.

Tabs: **All / Matched / Pending / Exceptions**. Batch-expandable rows. Match pill uses the `--ax-accent` / `--ax-warning` / `--ax-danger` tones. Signature column prefers the matched settlement signature over the execution-submitted signature.

### Policy

Legacy page still in `App.tsx`. Shows the workspace's `ApprovalPolicy` and its derived metrics (Pending approvals, Threshold-triggered, Trusted destinations rendered as `N/M`, External approval load). Edit modal writes to `ruleJson`.

### Exceptions

Legacy page still in `App.tsx`. Lists `ExceptionState` rows joined with ClickHouse facts. Detail drawer shows the transfer, the observed transfer, and the operator notes.

## Solana wallet integration

Discovery and signing helpers live in `frontend/src/domain.ts` (`discoverSolanaWallets`, `subscribeSolanaWallets`, `signAndSubmitPreparedPayment`). They implement the Wallet Standard and talk to whatever Solana wallet the user has installed.

Signing flow:

1. The frontend hits `/prepare-execution` on the order or run.
2. The API returns a prepared Solana transaction (`executionPacket.instructions` + signer/recent-blockhash metadata).
3. The frontend uses the chosen wallet to sign + submit and receives a signature.
4. The frontend hits `/attach-signature` with that signature; the API creates / updates the matching `ExecutionRecord`.

Axoria never holds keys. If a signer isn't detected, the UI tells the user to install or unlock a Solana wallet.

## Data fetching conventions

- **TanStack Query** for all GETs. Keys are arrays like `['payment-orders', workspaceId]`.
- **React Query mutations** for POST/PATCH. Invalidate the relevant query on success.
- **Refetch intervals** are tuned per page: 5 s for execution / approval queues, 10 s for payments, 15 s for wallet balances, 30 s for static registries.
- **Optimistic updates** are deliberately avoided for state-changing flows — the backend is the source of truth and races are too easy to hit.

## UI principles

When building or redesigning a screen, be explicit about these before writing JSX:

1. **Page purpose.** What's the one question this page answers?
2. **Primary action.** Every operational page has exactly one.
3. **States.** Loading skeleton, empty with CTA, error with retry, success.
4. **Density.** Institutional users scan data. Favor more rows on screen over airy padding.
5. **Tokens only.** Colors, radii, spacing come from `--ax-*` / Tailwind-style scales in `canonical.css`. Never `#hex` or `px` magic numbers inline unless there's a documented reason.

If a proposed change fights the institutional aesthetic (pill buttons, gradients, soft drop-shadows everywhere), push back or raise it in `brand.md` before shipping.
