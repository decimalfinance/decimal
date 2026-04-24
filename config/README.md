# Axoria Config

This directory contains **non-secret runtime configuration**.

Rules:

- committed config goes here
- secrets go in `.env` files or deploy-time env vars
- frontend values here are public because they ship to the browser

Files:

- `api.config.json`
  - API host/port, public URL, CORS, ClickHouse location, rate-limit settings
- `worker.config.json`
  - Yellowstone endpoint, ClickHouse location, control-plane API URL
- `frontend.public.json`
  - frontend API base URL and browser RPC URL

Secrets that must **not** go here:

- `DATABASE_URL`
- `CONTROL_PLANE_SERVICE_TOKEN`
- `YELLOWSTONE_TOKEN`
- private backend `SOLANA_RPC_URL`
- `CLICKHOUSE_PASSWORD`
