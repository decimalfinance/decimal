# 09 Frontend Application

The frontend lives in:

```text
frontend/
```

It is a React/Vite application.

The frontend is the human UI. It should not be the only way to operate Axoria.

## Main Files

```text
frontend/src/main.tsx
React entrypoint.

frontend/src/App.tsx
Main app composition and most pages/components.

frontend/src/Sidebar.tsx
Navigation/sidebar shell.

frontend/src/api.ts
API client wrapper.

frontend/src/types.ts
Shared frontend API/domain types.

frontend/src/status-labels.ts
Human labels for backend states.

frontend/src/domain.ts
Frontend domain helpers.

frontend/src/lib/solana-wallet.ts
Browser wallet detection/signing helpers.

frontend/src/csv-parse.ts
CSV parsing helpers.

frontend/src/styles.css
Current design system/theme styles.
```

## API Client

`frontend/src/api.ts` defines the client.

Default API base URL:

```text
http://127.0.0.1:3100
```

Override with:

```text
VITE_API_BASE_URL
```

Session token storage:

```text
usdc_ops_v2.session_token
```

There is also a legacy key fallback:

```text
usdc_ops.session_token
```

## Current Page Structure

The frontend includes these major pages:

- Landing page.
- Login.
- Setup.
- Profile.
- Command center.
- Payments.
- Payment requests.
- Payment runs.
- Payment run detail.
- Approvals.
- Execution.
- Settlement.
- Proofs.
- Address book.
- Approval policy.
- Exceptions.
- Exception detail.
- Payment detail.

## Human Workflow In The UI

The intended journey is:

```text
Create/import requests
  -> review payment run/orders
  -> approval if required
  -> prepare execution
  -> sign/submit with wallet
  -> watch settlement
  -> resolve exceptions
  -> export proof
```

## Wallet Integration

Wallet integration lives in:

```text
frontend/src/lib/solana-wallet.ts
```

The frontend detects wallets installed in the browser and lets users select a wallet.

Execution signing flow:

1. User prepares execution packet.
2. Frontend builds transaction from packet.
3. User selects source wallet.
4. Frontend checks signer compatibility.
5. Wallet signs and submits.
6. Frontend attaches submitted signature to API.
7. Worker later observes and matches the signature.

The frontend does not hold private keys.

## CSV Import

CSV import is part of the input layer.

Current expected header shape:

```csv
payee,destination,amount,reference,due_date
```

The frontend sends CSV text to backend preview/import endpoints.

The backend should own final validation. Frontend validation is only for user experience.

## Current UI State

The current frontend is functionally meaningful but still evolving.

Recent direction:

- More institutional-grade layout.
- Separate pages for batch and individual payments.
- Better payment lifecycle narrative.
- Less terminal-like UX over time.

Important product direction:

```text
The UI should not expose every backend field equally.
It should show the next operational decision.
```

## Important Frontend Components

The main component file includes many local components. Important ones include:

- `AppShell`
- `Sidebar`
- `PaymentsPage`
- `PaymentRequestsPage`
- `PaymentRunsPage`
- `PaymentRunDetailPage`
- `PaymentDetailPage`
- `ApprovalsPage`
- `ExecutionPage`
- `SettlementPage`
- `ProofsPage`
- `AddressBookPage`
- `PolicyPage`
- `ExceptionsPage`
- `PaymentTable`
- `UnifiedPaymentsTable`
- `RunPaymentsTable`
- `ActionPaymentTable`
- `PaymentRequestsTable`
- `PaymentRunsTable`
- `ExceptionsTable`
- `PaymentHero`
- `WorkflowRail`
- `ExecutionPanel`
- `RunExecutionPanel`
- `WalletPicker`

This is a lot for one `App.tsx`. Long-term, split by page and shared components.

## UI/UX Principles Going Forward

The UI should be built around operator questions:

- What needs my attention?
- What can I safely approve?
- What is ready to execute?
- What has been submitted?
- What settled?
- What failed or partially settled?
- What proof can I export?

Avoid UI that makes users reason through raw backend state labels.

## Product Screens That Matter Most

### Command Center

Should answer:

- pending approvals
- payments ready for execution
- settlement pending
- open exceptions
- recent completed payments

### Payment Run Detail

Should answer:

- what batch is this?
- total amount/count
- which payments are blocked?
- can I prepare a batch execution?
- what signatures/proofs exist?

### Payment Detail

Should answer:

- who is being paid?
- how much?
- from where?
- why?
- approval status
- execution status
- settlement status
- proof/timeline

### Exceptions

Should answer:

- what is broken?
- which payment is affected?
- what evidence exists?
- what action should I take?

### Address Book

Should answer:

- what wallets do we know?
- what destinations can we pay?
- which payees use which destinations?
- which addresses are trusted/restricted?

## Known Frontend Risks

- `App.tsx` is large and should be split.
- Some workflows may duplicate backend state transitions in frontend assumptions.
- Some screens still expose too much implementation detail.
- Wallet UX works but needs better error handling and compatibility messaging.
- The frontend should consume OpenAPI/types more systematically.

## Rule For Future Frontend Work

Before redesigning screens, define:

- page purpose
- primary action
- secondary actions
- immediately visible facts
- hidden/advanced facts
- empty state
- loading state
- error state

Do not start by changing colors or spacing.

