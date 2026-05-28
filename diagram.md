# Decimal Payment Routing Diagram

This is the current backend behavior, not the final target algorithm.

## Target Payment Algorithm

This is the flow we should move toward: every payment goes through one router.
The router decides whether the payment can be executed by an agent through a spending limit,
or whether it must become a Squads proposal for member voting.

```mermaid
flowchart TD
  A["Payment input<br/>manual / CSV / invoice / API / agent"] --> B["Normalize into PaymentOrder"]

  B --> C{"Can identify counterparty<br/>and destination wallet?"}
  C -->|"No"| R["Needs review"]
  C -->|"Yes"| D{"Counterparty wallet trusted?"}

  D -->|"No"| R
  D -->|"Yes"| E{"Payment details pass<br/>policy checks?"}

  E -->|"No"| R
  E -->|"Yes"| F["Green payment"]

  R --> RR["Attach review reason<br/>missing wallet / untrusted wallet / policy issue"]
  RR --> HR{"Human approves?"}

  HR -->|"No"| X["Cancel / reject payment"]
  HR -->|"Yes"| F

  F --> G{"Matching active<br/>spending limit exists?"}

  G -->|"Yes"| H{"Payment fits limit?"}
  H -->|"Yes"| I["Agent executes directly<br/>via Squads spendingLimitUse"]
  H -->|"No"| J["Create Squads proposal<br/>for member voting"]

  G -->|"No"| J

  I --> K["Submit transaction"]
  K --> L["RPC verifies settlement"]

  J --> M["Proposal active"]
  M --> N{"Voting result"}
  N -->|"Rejected"| X
  N -->|"Approved"| O["Execute proposal"]
  O --> L

  L -->|"Settled"| S["Payment complete"]
  L -->|"Pending"| P["Executed<br/>verification pending"]
  L -->|"Mismatch"| Z["Exception<br/>needs investigation"]
```

## Target Router Pseudocode

```ts
async function routePayment(paymentOrderId: string) {
  const payment = await loadPaymentOrder(paymentOrderId);

  if (!payment.destinationWallet) {
    return markNeedsReview(payment, 'missing_destination_wallet');
  }

  if (!isTrustedCounterpartyWallet(payment.destinationWallet)) {
    return markNeedsReview(payment, 'counterparty_wallet_not_trusted');
  }

  const policyDecision = await evaluatePaymentPolicy(payment);
  if (policyDecision.status !== 'pass') {
    return markNeedsReview(payment, policyDecision.reason);
  }

  const spendingLimit = await findBestMatchingSpendingLimit(payment);
  if (spendingLimit && await canUseSpendingLimit(payment, spendingLimit)) {
    return executeWithSpendingLimit(payment, spendingLimit);
  }

  return createSquadsPaymentProposal(payment);
}
```

## Target Mental Model

Every payment has exactly one of three routing outcomes:

| Outcome | Meaning |
| --- | --- |
| `needs_review` | The payment is not safe or complete enough for automation. A human must clear or reject it. |
| `agent_executed` | The payment matched an active spending limit and the agent executed it directly. |
| `proposal_created` | The payment did not qualify for direct execution, so it entered the Squads voting path. |

The user should not have to choose between "submit", "advance", "create proposal", and "execute with spending limit".
The backend router should make that decision.

## Target State Vocabulary

```mermaid
stateDiagram-v2
  [*] --> needs_review
  [*] --> ready

  needs_review --> ready: human clears review
  needs_review --> cancelled: human rejects

  ready --> executing: spending limit route selected
  ready --> proposed: proposal route selected

  executing --> executed: tx submitted
  proposed --> executed: proposal executed

  executed --> settled: RPC verifies transfer
  executed --> exception: RPC mismatch

  exception --> settled: manually resolved / verified
```

Suggested product states:

- `needs_review`
- `ready`
- `proposed`
- `executing`
- `executed`
- `settled`
- `exception`
- `cancelled`

We can keep the DB state smaller if needed, but the router should internally reason with these states.

## Main Payment Flow

```mermaid
flowchart TD
  A["Payment input<br/>manual / CSV / invoice"] --> B{"Can resolve or create<br/>counterparty wallet?"}

  B -->|"No"| B1["No executable payment<br/>Invoice: skipped row<br/>CSV: failed row"]
  B -->|"Yes"| C["Create PaymentOrder"]

  C --> D{"Counterparty wallet<br/>trust state?"}

  D -->|"blocked"| X["Blocked<br/>cannot proceed"]
  D -->|"restricted"| R["Needs human review"]
  D -->|"unreviewed"| R
  D -->|"trusted"| E["Draft / green payment"]

  R --> R1{"Human clears review?"}
  R1 -->|"No"| CXL["Cancelled or stays blocked"]
  R1 -->|"Yes"| E

  E --> F{"Auto advance enabled?"}
  F -->|"No"| WAIT["Wait for user / agent retry"]
  F -->|"Yes"| G["Agent advance"]

  G --> H{"Active Squads proposal<br/>already exists?"}
  H -->|"Yes"| P["Return existing proposal"]
  H -->|"No"| I{"Source treasury exists?"}

  I -->|"No"| ST["Needs source treasury"]
  I -->|"Yes"| J{"Source is Squads v4?"}

  J -->|"No"| U["Unsupported source treasury"]
  J -->|"Yes"| K{"Asset is USDC?"}

  K -->|"No"| BLK["Blocked"]
  K -->|"Yes"| L["Agent creates Squads<br/>payment proposal"]

  L --> M["Proposal active<br/>members vote / reject"]
  M --> N{"Threshold reached?"}

  N -->|"Rejected"| CXL
  N -->|"Approved"| O["Execute Squads proposal"]

  O --> Q["RPC verifies transfer"]
  Q -->|"settled"| S["Payment settled"]
  Q -->|"pending"| EX["Executed<br/>verification pending"]
  Q -->|"mismatch"| MM["Mismatch<br/>needs investigation"]
```

## Spending-Limit Path

This exists today, but it is not yet integrated into the main agent routing decision.
The frontend/backend must explicitly call the spending-limit execution endpoint.

```mermaid
flowchart TD
  A["PaymentOrder"] --> B{"Explicit spending-limit<br/>policy selected?"}

  B -->|"No"| P["Normal Squads proposal path"]
  B -->|"Yes"| C{"Policy active?"}

  C -->|"No"| X["Cannot execute"]
  C -->|"Yes"| D{"Amount <= policy limit?"}

  D -->|"No"| X
  D -->|"Yes"| E{"Destination allowlisted?"}

  E -->|"No"| X
  E -->|"Yes"| F{"Onchain spending limit<br/>has remaining amount?"}

  F -->|"No"| X
  F -->|"Yes"| G["Agent signs<br/>spendingLimitUse tx"]

  G --> H["Submit transaction"]
  H --> I["RPC settlement verification"]

  I -->|"settled"| S["Payment settled"]
  I -->|"pending"| PEND["Executed<br/>verification pending"]
  I -->|"mismatch"| M["Mismatch"]
```

## Current Important Gap

The main agent path does not automatically choose between:

- spending-limit execution
- Squads proposal creation
- human review

Right now, the normal agent advance path creates a Squads proposal for green payments.
Spending-limit execution is available, but separate.

## Current State Vocabulary

```mermaid
stateDiagram-v2
  [*] --> needs_review
  [*] --> draft

  needs_review --> draft: human clears review
  needs_review --> cancelled: human rejects

  draft --> proposed: agent creates Squads proposal
  proposed --> executed: proposal executed
  executed --> settled: RPC verifies transfer

  draft --> cancelled
  proposed --> cancelled
  executed --> cancelled
```

## Backend Files Behind This Flow

- `api/src/payments/invoice-intake.ts`: invoice extraction and review rules.
- `api/src/payments/csv-intake.ts`: CSV import and counterparty resolution.
- `api/src/payments/orders.ts`: `PaymentOrder` lifecycle and read model.
- `api/src/agents/payment-automation.ts`: agent advance into Squads proposal creation.
- `api/src/agents/spending-limit-execution.ts`: direct agent execution through Squads spending limits.
- `api/src/squads/treasury.ts`: Squads proposal, vote, execute, config, and spending-limit primitives.
