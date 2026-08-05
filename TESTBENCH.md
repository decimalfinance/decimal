# Test bench — the contract between Claude Code (CLI) and Claude Code desktop

Purpose: changes get verified by an agent driving the real product in a browser,
not by Zaid clicking around. The CLI side ships code and writes a **test brief**;
the desktop side runs the bench, executes the brief, and files a **report**.
Zaid only reads reports.

## The stack (safe by construction)

| Thing | Test bench |
|---|---|
| API | http://127.0.0.1:3100 |
| Frontend | http://localhost:5174 (vite dev) |
| Database | `usdc_ops_local` |

Both bench processes hot-reload (`tsx watch` / vite): after a code change you
normally need NO restart — just reload the page. `make test-api` uses a third
database (`usdc_ops_test`) and never touches the bench either.

**Known flake — the fake chain flag drops:** if anything else claims port 3100
(e.g. `make dev`, which shares the port and does NOT set the flag), the API
serving the bench loses the fake chain. `make testbench-status` detects it
loudly (`fakechain: OFF`) — the fix is always `make testbench-restart-api`.
Check status at the START of every brief and after any long pause.

**Fake Squads chain:** the bench runs with `SQUADS_FAKE_CHAIN=true` — treasury
creation and the whole release ceremony (propose → approve → submit → execute
→ settled) run against an in-memory chain: any signature string is accepted,
no real USDC is required, no Solana RPC is hit. Ceremony steps are API-driven
(the browser signing flow expects a real chain). Fake multisigs live in
process memory: after an API restart, re-create the treasury. Config
validation refuses this flag in production.

## Commands (run from the repo root)

```
make testbench-up           # start postgres + api + frontend in background, wait for health
make testbench-status       # api/frontend up? dev auth configured?
make testbench-restart-api  # bounce the api only (rarely needed — it hot-reloads)
make testbench-down         # stop bench processes (prod untouched)
./scripts/testbench.sh logs # last 40 lines of the api log
```

Logs and pids live in `.testbench/` (gitignored).

## Signing in and seeding (no real emails, ever)

Developer sign-in is the **real** sign-in. There is no parallel auth path: the
only concession to testing is that an account on the reserved
`@dev.decimal.test` domain is created already verified, because no inbox exists
to read a verification code from. Everything else — password rules, sessions,
org creation, invites — behaves exactly as it does for a customer.

- **Browser**: http://localhost:5174/**dev-login** (never linked from the
  product, and it reports itself unavailable when the server has dev mode off).
  Two fields: a throwaway email on `@dev.decimal.test` and a password you
  choose. The account is created on first use and signs you in thereafter.
  The normal `/login` page has no developer affordance on it at all.
- **API**: registration and login are the ordinary `POST /auth/register` and
  `POST /auth/login` — a dev-domain address just comes back with
  `emailVerifiedAt` already set.
- **Fixtures**: `POST /auth/dev/seed` `{secret, organizationName, owner, members[]}`
  builds users + org + active memberships + role bundles in one call and returns
  a session token per persona — worth it because assembling that through real
  endpoints is a dozen round-trips. `secret` = `DEV_AUTH_SECRET` in `api/.env`.
  Roles: reviewer / approver / payer (any casing). Access: admin | member.
- Use `Authorization: Bearer <sessionToken>` to act as any persona over the API.

Both affordances are off unless `DEV_AUTH_SECRET` is set, which it never is in
production — there the reserved domain is just an ordinary domain.

## The brief → report loop

1. CLI Claude finishes a change and writes a brief to
   `synthetic_data/testbench/briefs/NNN-<slug>.md`: what changed, exact steps,
   expected result per step, and what would count as a failure.
2. Zaid (or a scheduled run) hands desktop Claude one line:
   *"Run the latest test brief in synthetic_data/testbench/briefs/ per TESTBENCH.md."*
3. Desktop Claude: `make testbench-up` (or `-status` if already up) → executes
   the brief in the browser and/or API → writes
   `synthetic_data/testbench/reports/NNN-<slug>.md` with **PASS/FAIL per step**,
   expected-vs-saw for every failure, and exact repro steps. Blunt honesty;
   bugs are the deliverable. Screenshots can't be saved to disk from the
   in-app browser — describe what was seen instead.
4. CLI Claude reads the report and fixes; the brief gets re-run until green.

## Ground rules for the desktop side

- Never touch port 3101, the `usdc_ops` database, decimal.finance, or anything
  under Cloudflare — that's production.
- Fresh orgs have no vendors/categories: create counterparties via API first
  if the brief involves vendor/category behavior (or the brief will say so).
- If the bench won't start, paste the tail of `.testbench/api.log` into the
  report rather than debugging blind.
- Report format: brief number, date, environment status line, then one section
  per brief step with PASS/FAIL. End with "Other observations" — anything odd
  you noticed outside the brief's scope is welcome.

## Browser-driving notes (learned in earlier runs)

- React controlled inputs (dev-login form and others) may ignore the MCP
  `form_input` tool: set values via the native `HTMLInputElement` value setter
  and dispatch `input`/`change` events instead — works every time.
- File uploads: inject a `DataTransfer` onto `#dec-bill-upload-input` and fire
  its `change` event; this exercises the real upload path.
- Document extraction takes ~10–15s per upload — wait before judging the
  review screen. The page polls and auto-advances when extraction finishes.
