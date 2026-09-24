# CLAUDE.md

Guidance for Claude Code and other agents working in this repository. Keep it short and true. If a command or path here is wrong, fix it in the same commit you noticed it.

## What this is

Decimal is an accounts-payable product. A bill arrives by upload or forwarded email, a model extracts it into structured fields, a person checks it, each line is coded to a ledger account, an approval flow routes it, and approved bills sync to QuickBooks Online.

**Built and live:** extraction, bill review, GL coding, the approval engine with its Flow Builder and policies, roles, QuickBooks sync, inbound email, the agent test bench, and the exception agent (it investigates duplicate flags and recommends a resolution; a person confirms).

**Frozen:** payment execution (Squads treasury on Solana, USDC). The code is wired and tested but has not been developed since mid-August 2026, and no real payment has ever executed. Do not extend it, and do not describe it as working, without a product decision.

## Read before you build

| Doing this | Read this first |
|---|---|
| Anything non-trivial | `docs/ARCHITECTURE.md` |
| Creating or editing any page | `frontend/src/pages/PAGE-PLAYBOOK.md`. Mandatory. |
| Verifying a change in the browser | `TESTBENCH.md` |
| Generating test invoices | `TESTING-INVOICES.md` |
| Looking for the next thing to build | `docs/OPEN-WORK.md` |
| Resuming payment work | `docs/reference/` |

## Commands

Run from the repo root. These six are the whole surface. Check `make help` if in doubt.

| Command | What it does |
|---|---|
| `make dev` | Postgres, API on `:3100`, frontend on `:5174`, against `usdc_ops_local`. |
| `make bench` | Background hot-reloading stack for agents: API `:3200`, frontend `:5274`, database `usdc_ops_bench`, fake Squads chain. |
| `make test` | API typecheck, API tests against `usdc_ops_test`, frontend build. |
| `make reset` | Wipes dev and bench data. Schema stays. |
| `make stop` | Stops everything including Docker. |
| `make help` | Lists the above. |

`make bench-stop` stops only the bench and leaves `:3100` and `:5174` alone. `dev` and `bench` run side by side on purpose.

**Never run `tsx --test` or `npm test` directly inside `api/`.** It inherits the dev database URL, and the tests truncate every table. This wiped the dev database once. Always use `make test`.

**Never touch `:3100`, `:5174` or `usdc_ops_local` from an agent session.** That is the human's stack. Use the bench.

## Rules that are easy to get wrong

- **The schema is SQL-first.** Edit `postgres/init/*.sql`, keep every file idempotent because they re-run on every startup, then update `api/prisma/schema.prisma` to match. There are no Prisma migrations.
- **The `approval` schema is outside Prisma on purpose.** Reach it only through raw SQL in `api/src/approvals/store.ts`.
- **Money is bigint minor units.** USDC raw is dollars × 10^6. Never floats.
- **Validate JSON payloads with Zod** at the boundary.
- **ESM imports use `.js` extensions** even in `.ts` source.
- **Frontend:** copy the `Members.tsx` skeleton, use only the classes in `frontend/src/styles/decimal/`, grep before typing a class name, never hardcode colours, spacing or fonts. Text fills its container, so no `max-width` on prose. The look is a clean institutional bank, never crypto neon.
- **Product vocabulary:** "bill", "approval", "approvers", "team members", "Category". Never "multisig", "vote", "wallet" or "GL code" in operator-facing copy. A bill is a `PaymentOrder` only in code.
- **Approvals never auto-deny.** Overdue tasks escalate. A rejected bill goes back to review and is never terminal.

## Config and secrets

Committed, non-secret config: `config/api.config.json` and `frontend/src/public-config.json`. Secrets live in `api/.env`, which is gitignored. `config.ts` refuses the fake-chain and dev-auth flags in production.

Dev sign-in for testing: the `/dev-login` page, or `POST /auth/dev/login` and `POST /auth/dev/seed` with `DEV_AUTH_SECRET` from `api/.env`. Only `@dev.decimal.test` addresses work.

`synthetic_data/` and `outputs/` are gitignored. Never commit regenerable fixtures or pitch material.

## Working agreement

- Commit as you go. Commits are part of done. Do not accumulate uncommitted work.
- Ship UI changes with a test brief, as described in `TESTBENCH.md`.
- When you change how a subsystem works, update its section in `docs/ARCHITECTURE.md` in the same commit.
