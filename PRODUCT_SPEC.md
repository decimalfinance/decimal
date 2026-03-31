# Product Spec

## Working Name

`USDC Ops Layer`

This name is internal. The product definition matters more than the brand right now.

## One-Line Definition

`USDC Ops Layer` is a real-time Solana USDC monitoring, classification, and reconciliation system for teams that move money and need to understand exactly what happened onchain.

## Why This Product

The market is large, but most stablecoin opportunities require one or more of:

- large balance sheet risk,
- regulatory complexity,
- banking relationships,
- deep liquidity bootstrapping,
- or distribution that we do not have today.

This product does not require any of those to start.

It is small enough to build as an MVP, useful enough for real users, and close enough to existing Solana data rails that execution risk is acceptable.

## What We Are Building

We are building a product that answers this operational question:

`What happened to my USDC on Solana, who was involved, how much moved, and how should I interpret it?`

The product will:

- watch USDC movements on Solana in real time,
- group updates by transaction,
- decode balances and amount changes,
- label known entities when possible,
- classify movements into operational event types,
- and expose those events through a UI and API for operations and finance workflows.

## System Shape

The system is split into two planes:

- `data plane`
- `control plane`

### Data Plane

The data plane is responsible for:

- ingestion from Yellowstone,
- normalization,
- classification,
- replay,
- and event storage.

This plane is implemented in `Rust` and writes event data into `ClickHouse`.

### Control Plane

The control plane is responsible for:

- workspace onboarding,
- watched addresses,
- labels,
- internal business objects,
- mappings,
- and product-facing APIs.

This plane is implemented in `TypeScript` and stores onboarding/configuration state in `Postgres`.
The control-plane API framework is `Express`, and database access is handled through `Prisma`.

### Storage Decision

`ClickHouse` holds:

- raw observations
- canonical events
- workspace-scoped serving events
- reconciliation outputs

`Postgres` holds:

- workspaces
- watched addresses
- labels
- business objects
- mappings
- onboarding state

This separation is intentional. Event data is append-heavy and analytical. Onboarding/configuration data is transactional and relational.

## What We Are Not Building

We are not building:

- a stablecoin issuer,
- a payments processor,
- a wallet for consumers,
- a merchant checkout product,
- a DeFi yield product,
- a generic blockchain analytics dashboard,
- a compliance platform,
- or a trading signal engine.

Those may become adjacent opportunities later, but they are out of scope for the MVP.

## Core User

The primary user is:

`an operations or treasury person at a Solana-native company that receives, sends, or manages USDC`

Examples:

- a payments app monitoring treasury wallets,
- a wallet team tracking settlement flows,
- a protocol team watching treasury and liquidity movements,
- a market making or OTC team monitoring known counterparties,
- a finance team trying to reconcile onchain USDC activity.

## End Users

Primary end users:

- treasury teams,
- operations teams,
- finance and reconciliation teams,
- protocol ops teams,
- market structure / liquidity ops teams.

Secondary end users:

- founders at small fintech or payment apps,
- risk teams,
- analytics teams that need a structured USDC event feed.

Non-users for MVP:

- retail traders,
- consumers,
- general-purpose crypto researchers,
- pure compliance teams,
- merchants directly.

## User Pain Point

The pain is not lack of raw blockchain data.

The pain is that raw Solana USDC activity is too noisy and too operationally expensive to interpret.

Today, a team often cannot quickly answer:

- Did we receive or send USDC?
- Which wallets changed?
- Which transaction caused it?
- Was this a transfer, swap, pool interaction, or treasury move?
- Which known entity was on the other side?
- What should finance log for reconciliation?

The current alternatives are weak:

- explorers are manual,
- raw RPC data is noisy,
- internal scripts are fragile,
- and generic analytics tools are not built around ops workflows.

## Jobs To Be Done

### Primary Job

When USDC moves on Solana, help me understand and reconcile it quickly without manually inspecting raw transactions.

### Functional Jobs

- monitor watched wallets and entities,
- detect USDC inflows and outflows,
- group writes into transaction-level events,
- identify known counterparties,
- classify events into a small taxonomy,
- export records for finance and ops,
- and provide a clean audit trail.

### Emotional Jobs

- reduce uncertainty,
- reduce fear of missing a money movement,
- reduce time spent manually checking explorers,
- increase confidence in treasury and ops decisions.

## Product Promise

For any watched USDC movement on Solana, the product should turn raw account updates into a human-readable operational event within seconds.

## MVP Scope

The MVP is intentionally narrow.

### Chain And Asset Scope

- Solana only
- USDC only

### Data Scope

- real-time only for MVP
- no historical backfill requirement for initial version

### User Scope

- single workspace or single user is acceptable for V1
- no multi-tenant complexity required on day one

### Feature Scope

The MVP must include:

- watched address list,
- live USDC event feed,
- transaction grouping,
- token account decoding,
- amount change computation,
- basic entity labeling,
- basic event classification,
- CSV export,
- and a minimal API or machine-readable output.

The MVP does not need:

- authentication complexity,
- billing,
- ML,
- alerting rules engine,
- mobile app,
- deep protocol coverage,
- cross-chain support,
- or role-based access control.

## Event Model

The core object in the system is an `event`.

An event should contain:

- timestamp,
- slot,
- transaction signature,
- watched entity or wallet involved,
- source token account,
- destination token account,
- source owner if known,
- destination owner if known,
- amount delta,
- asset,
- label(s),
- event type,
- confidence level,
- raw references for auditability.

## Event Types For MVP

The initial taxonomy should stay small:

- `wallet_transfer`
- `exchange_deposit`
- `exchange_withdrawal`
- `pool_deposit`
- `pool_withdrawal`
- `swap_related_movement`
- `treasury_rebalance`
- `mint`
- `burn`
- `unknown`

If a transaction cannot be confidently classified, it must be labeled `unknown` rather than guessed.

## Entity System

The second core object is an `entity`.

We need a small but reliable label registry for:

- watched wallets,
- token accounts,
- protocol vaults,
- pool accounts,
- treasury wallets,
- known exchange deposit wallets,
- and internal addresses defined by the user.

Each label should carry:

- entity name,
- entity type,
- confidence,
- source of truth,
- and notes.

The label system must distinguish between:

- user-defined labels,
- hardcoded / curated labels,
- and inferred labels.

## UX Definition

The product UX should feel like an operations console, not a research terminal.

### Core Screen

The main screen is a live event feed.

Each row should answer:

- what happened,
- how much USDC moved,
- which transaction did it,
- which entities were involved,
- and how confident the system is.

### Expected User Flow

1. User adds a small set of watched wallets or entities.
2. Product starts streaming USDC events related to them.
3. Product groups the underlying writes by transaction.
4. Product shows one interpreted event record.
5. User filters by event type, entity, amount, or confidence.
6. User exports the records when needed.

### UX Principles

- show interpreted events first, raw details second,
- preserve traceability back to raw transaction data,
- never invent precision,
- prefer `unknown` over false confidence,
- make large money movements obvious,
- keep the interface useful for someone doing operations at speed.

## Why Someone Uses It Instead Of Existing Tools

They do not want to stitch together:

- Solscan,
- transaction signatures,
- token account state,
- internal spreadsheets,
- and handwritten notes.

They want one place where USDC activity becomes:

- readable,
- grouped,
- labeled,
- and exportable.

## Why Someone Pays For It Later

Because it saves time and reduces operational mistakes.

The future paid value is:

- faster reconciliation,
- fewer missed movements,
- less manual triage,
- cleaner treasury visibility,
- and a structured record of stablecoin operations.

## Distribution Hypothesis

The first users will likely come from:

- small Solana fintech teams,
- payment products,
- protocol teams,
- and operators already living in Telegram, Discord, and explorers.

The product must be obviously useful from a short demo, not from a long sales pitch.

## Success Criteria For MVP

The MVP is successful if a real user can:

- add watched wallets,
- see live USDC events within seconds,
- understand what happened without opening an explorer,
- and export a useful record for ops or finance.

More concretely:

- a user can identify the relevant transaction from the event feed,
- a user can tell inflow vs outflow correctly,
- a user can distinguish basic event classes,
- and the output is good enough to assist reconciliation.

## Non-Negotiable Product Principles

- Scope stays narrow.
- USDC only until the product is obviously useful.
- Solana only until the product is obviously useful.
- Interpretation must remain auditable.
- We do not sell fake certainty.
- We do not add ML to cover for weak foundations.

## Build Sequence

The build sequence should be:

1. Canonical event pipeline
2. Amount delta computation
3. Label registry
4. Event classification
5. Simple operator UI
6. Export and API layer

If we skip that order, the product will become confused quickly.

## Product Boundaries

When a new idea comes up during development, we should test it against one question:

`Does this help an operations or treasury user understand and reconcile USDC movement on Solana right now?`

If the answer is no, it is out of scope for the MVP.

## Revision Rule

This document is the current source of truth for product scope.

We should only change it when we make an explicit product decision, not casually while building.
