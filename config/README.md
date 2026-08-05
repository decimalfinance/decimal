# Decimal Config

This directory contains **non-secret runtime configuration**.

Rules:

- committed config goes here
- secrets go in `.env` files or deploy-time env vars
- frontend values here are public because they ship to the browser

Files:

- `api.config.json`
  - API host/port, public URL, CORS, rate-limit settings
The frontend's own config lives at `frontend/src/public-config.json` (API base
URL only — the browser never needs an RPC URL, every client-side Solana call
goes through the backend proxy).

Secrets that must **not** go here:

- `DATABASE_URL`
- private backend `SOLANA_RPC_URL`
