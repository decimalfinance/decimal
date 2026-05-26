# Synthetic Vendor Wallet Directory

This directory is the public side of Decimal's synthetic AP dataset.

`wallet-directory.json` contains vendor names, emails, categories, trust states,
and real Solana devnet public keys. Synthetic invoices are generated from this
directory, so regenerated invoices keep stable wallet addresses.

The matching private keys are intentionally not stored here.

Private key registry:

```text
api/.secrets/synthetic-wallet-directory.private.json
```

That file is gitignored by `api/.secrets/`. It is local-only test key material.

Regenerate or extend the directory:

```bash
cd api
node scripts/generate-synthetic-wallet-directory.mjs
cd ..
node synthetic_data/generate.mjs
node synthetic_data/render-invoice-pdfs.mjs --limit 12 --mode invoice
```

