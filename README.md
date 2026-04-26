# Axoria

Axoria is a stablecoin payment operations layer for Solana.

It helps teams define expected USDC movement, route approvals, hand off execution, reconcile onchain settlement, and export proof packets.

## What it does

- single payment requests
- batch payment runs from CSV
- single expected collections
- batch collection runs from CSV
- approval policy and approval inbox
- non-custodial execution handoff
- signer-ready Solana USDC transfer packets
- reconciliation and exception handling
- JSON proof packets for payments and collections

## Core workflows

### Payments

```text
Request / CSV Run
  -> Order
  -> Approval
  -> Execution Handoff
  -> Onchain Settlement
  -> Reconciliation
  -> Proof
```

### Collections

```text
Expected Collection / CSV Run
  -> Receiving Wallet + Optional Expected Payer
  -> Onchain Receipt
  -> Match / Source Review
  -> Proof
```

## Architecture

- `frontend/` — React + Vite operator UI
- `api/` — Express + Prisma control plane
- `yellowstone/` — Rust ingestion worker
- `Postgres` — durable control-plane state
- `ClickHouse` — observed transfer and reconciliation data

Current deployment:

- frontend on Vercel
- backend API, PostgreSQL, ClickHouse, and Yellowstone worker on a MacBook
- Cloudflare Tunnel exposing `api.axoria.fun`

## Repo structure

```text
frontend/     operator UI
api/          control-plane API
yellowstone/  Solana ingestion worker
postgres/     bootstrap SQL
clickhouse/   bootstrap SQL
config/       non-secret runtime config
outputs/      notes and handoff docs
```

## Local development

Install dependencies:

```bash
cd api && npm install
cd ../frontend && npm install
cd ../yellowstone && cargo fetch
```

Run everything:

```bash
make dev
```

Useful commands:

```bash
make test
make test-api
make test-worker
make test-frontend
make infra-up
make infra-down
make help
```

## API

Useful endpoints:

- `GET /health`
- `GET /capabilities`
- `GET /openapi.json`

Main route groups:

- auth
- organizations and workspaces
- treasury wallets, counterparties, destinations, collection sources
- payment requests, payment orders, payment runs
- collection requests, collection runs
- approvals, reconciliation, exceptions, proofs

## Proof packets

Axoria exports JSON proof packets for:

- payment orders
- payment runs
- collection requests
- collection runs

These are meant to capture operational truth, not just raw chain activity.

## Configuration

Committed non-secret config:

- `config/api.config.json`
- `config/worker.config.json`
- `config/frontend.public.json`

Local secrets:

- `api/.env`
- `yellowstone/.env`
- root `.env`

If it reaches the browser, it is public.

## Status

Built:

- auth
- org and workspace setup
- payment and collection workflows
- batch CSV flows
- approval routing
- execution preparation
- reconciliation
- proof exports

Not built:

- custody
- fiat rails
- bank integrations
- full enterprise infra

Axoria is an operations and proof layer, not a custodian.

## More docs

- [api/README.md](/Users/fuyofulo/code/stablecoin_intelligence/api/README.md)
- [postgres/README.md](/Users/fuyofulo/code/stablecoin_intelligence/postgres/README.md)
- [config/README.md](/Users/fuyofulo/code/stablecoin_intelligence/config/README.md)
- [system_explained/README.md](/Users/fuyofulo/code/stablecoin_intelligence/system_explained/README.md)
