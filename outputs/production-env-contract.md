# Axoria Runtime Contract

This is the simplified runtime model for Axoria.

Do not think in terms of "a lot of secrets." Think in terms of:

- **real secrets**
- **plain config**
- **public frontend values**

## File layout

### Config files

These are committed and non-secret:

- [config/api.config.json](/Users/fuyofulo/code/stablecoin_intelligence/config/api.config.json)
- [config/worker.config.json](/Users/fuyofulo/code/stablecoin_intelligence/config/worker.config.json)
- [config/frontend.public.json](/Users/fuyofulo/code/stablecoin_intelligence/config/frontend.public.json)

### Secret env files

These should remain local or deploy-time only:

- [api/.env.example](/Users/fuyofulo/code/stablecoin_intelligence/api/.env.example)
- [yellowstone/.env.example](/Users/fuyofulo/code/stablecoin_intelligence/yellowstone/.env.example)
- repo root [`.env`](/Users/fuyofulo/code/stablecoin_intelligence/.env) for local tooling only

Frontend should not need a secret env file anymore.

## 1. Real secrets

These must never go in git, docs, screenshots, or frontend `VITE_*` env vars.

### Required now

| Variable | Used by | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | API | Connects the backend to Postgres |
| `CONTROL_PLANE_SERVICE_TOKEN` | API + Yellowstone worker | Lets the worker call internal backend routes |

### Optional / provider-dependent

| Variable | Used by | Purpose |
| --- | --- | --- |
| `YELLOWSTONE_TOKEN` | Yellowstone worker | Auth for Yellowstone provider, if required |
| `SOLANA_RPC_URL` | API | Private RPC if you put a paid key on the backend |
| `CLICKHOUSE_PASSWORD` | Yellowstone worker / ClickHouse | Only if ClickHouse is protected with auth |

## 2. Plain config

These are not secrets. They are deployment settings.

### API config file

| Variable | Purpose |
| --- | --- |
| `HOST` | Bind host |
| `PORT` | API port |
| `CLICKHOUSE_URL` | ClickHouse base URL |
| `CLICKHOUSE_DATABASE` | ClickHouse database name |
| `CORS_ORIGIN` | Comma-separated list of allowed frontend origins |
| `TRUST_PROXY` | Set `true` behind Cloudflare / reverse proxy |
| `PUBLIC_API_URL` | Canonical public API URL used in OpenAPI |
| `RATE_LIMIT_ENABLED` | Enable request rate limiting |
| `PUBLIC_RATE_LIMIT_WINDOW_MS` | Rate limit window |
| `PUBLIC_RATE_LIMIT_MAX` | Rate limit max requests |

`NODE_ENV` still stays in the runtime env because it is standard process mode, not business config.

### Worker config file

| Variable | Purpose |
| --- | --- |
| `YELLOWSTONE_ENDPOINT` | Yellowstone gRPC endpoint |
| `CLICKHOUSE_URL` | ClickHouse base URL |
| `CLICKHOUSE_DATABASE` | ClickHouse database name |
| `CLICKHOUSE_USER` | ClickHouse username |
| `CONTROL_PLANE_API_URL` | Public or private API URL the worker calls |
| `WORKSPACE_REFRESH_INTERVAL_SECONDS` | Reserved for matching context refresh cadence |

## 3. Public frontend values

These are **not secrets**. They now live in the committed frontend public config file.

| Variable | Purpose |
| --- | --- |
| `apiBaseUrl` | Frontend -> API base URL |
| `solanaRpcUrl` | Browser-side Solana RPC URL |

## Important frontend warning

The frontend now reads its public RPC from [frontend.public.json](/Users/fuyofulo/code/stablecoin_intelligence/config/frontend.public.json):

```env
solanaRpcUrl=https://solana-mainnet.g.alchemy.com/v2/...
```

is **not private** once the frontend is built and deployed.

If you keep using a private-provider URL in the frontend:

- treat it as a **public client key**
- enforce provider-side restrictions if available
- do not rely on secrecy

If you want a truly private RPC key:

- keep it only on the backend as `SOLANA_RPC_URL`
- do not expose it through frontend public config

## Minimum production secret set

For the deploy you are planning, the minimum real secret set is:

```env
DATABASE_URL=postgresql://...
CONTROL_PLANE_SERVICE_TOKEN=<long-random-secret>
```

And maybe these, depending on providers:

```env
YELLOWSTONE_TOKEN=...
SOLANA_RPC_URL=https://solana-mainnet.g.alchemy.com/v2/...
```

That is the actual secret surface. Everything else is config.

## Recommended storage

### Local developer machine

- Repo root [`.env`](/Users/fuyofulo/code/stablecoin_intelligence/.env):
  - local tooling only
  - example: `COLOSSEUM_COPILOT_PAT`

### API deployment env

- `DATABASE_URL`
- `CONTROL_PLANE_SERVICE_TOKEN`
- `SOLANA_RPC_URL` if private
- `NODE_ENV`
- API plain config comes from `config/api.config.json`

### Yellowstone worker env

- `CONTROL_PLANE_SERVICE_TOKEN`
- `YELLOWSTONE_TOKEN` if needed
- `NODE_ENV`
- worker plain config comes from `config/worker.config.json`

### Frontend deploy env

- no secret envs required
- public runtime settings come from `config/frontend.public.json`

## Immediate operational rule

Use this rule:

- if it reaches the browser, it is public
- if it authenticates infra, it is a secret
- if it only changes runtime behavior, it is config

## Immediate cleanup rule

Never put these in git again:

- provider tokens
- Postgres connection strings
- service-to-service auth tokens
- real RPC secrets

The old Colosseum Copilot token was previously committed in git history and had to be rotated. Treat that as the baseline lesson for future changes.
