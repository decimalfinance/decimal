# API

## Purpose

This service is the TypeScript control-plane API built with `Express` and `Prisma`.

It owns the control plane in `Postgres`:

- workspaces
- watched addresses
- labels
- business objects
- address-to-object mappings

It also exposes read-side endpoints backed by `ClickHouse` for:

- workspace operational events
- reconciliation rows
- event participants

## Start

1. Install dependencies

```bash
cd api
npm install
```

2. Generate the Prisma client

```bash
npm run prisma:generate
```

3. Run the API

```bash
npm run dev
```

## Environment

See [.env.example](/Users/fuyofulo/code/stablecoin_intelligence/api/.env.example).

## Current Routes

- `GET /health`
- `GET /workspaces`
- `POST /workspaces`
- `GET /workspaces/:workspaceId/onboarding`
- `GET /workspaces/:workspaceId/addresses`
- `POST /workspaces/:workspaceId/addresses`
- `GET /workspaces/:workspaceId/labels`
- `POST /workspaces/:workspaceId/labels`
- `GET /workspaces/:workspaceId/address-labels`
- `POST /workspaces/:workspaceId/address-labels`
- `GET /workspaces/:workspaceId/objects`
- `POST /workspaces/:workspaceId/objects`
- `GET /workspaces/:workspaceId/address-object-mappings`
- `POST /workspaces/:workspaceId/address-object-mappings`
- `GET /workspaces/:workspaceId/events`
- `GET /workspaces/:workspaceId/events/:workspaceEventId/participants`
- `GET /workspaces/:workspaceId/reconciliation`
