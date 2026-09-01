# Test bench — the contract between Claude Code (CLI) and Claude Code desktop

Purpose: changes get verified by an agent driving the real product in a browser,
not by Zaid clicking around. The CLI side ships code and writes a **test brief**;
the desktop side runs the bench, executes the brief, and files a **report**.
Zaid only reads reports.

## The stack (safe by construction)

The bench is a **separate stack** from the one Zaid runs. Different ports,
different database — they can run at the same time and cannot see each other.

| | bench (`make bench`) | Zaid's (`make dev`) |
|---|---|---|
| API | http://127.0.0.1:3200 | :3100 — **never touch** |
| Frontend | http://localhost:5274 | :5174 — **never touch** |
| Database | `usdc_ops_bench` | `usdc_ops_local` — **never touch** |

Both bench processes hot-reload (`tsx watch` / vite): after a code change you
normally need NO restart — just reload the page. `make test` uses a third
database (`usdc_ops_test`) and never touches either stack.

**Fake Squads chain:** the bench runs with `SQUADS_FAKE_CHAIN=true` — treasury
creation and the whole release ceremony (propose → approve → submit → execute
→ settled) run against an in-memory chain: any signature string is accepted,
no real USDC is required, no Solana RPC is hit. Ceremony steps are API-driven
(the browser signing flow expects a real chain). Fake multisigs live in
process memory: after an API restart, re-create the treasury. Config
validation refuses this flag in production.

## Commands (run from the repo root)

```
make bench                # start (or restart) the bench, wait for health, print status
make bench-stop           # stop ONLY the bench — leaves :3100/:5174 alone
./scripts/bench.sh status # ports, database, fake-chain flag
./scripts/bench.sh logs   # last 40 lines of the api log
```

`make bench` is idempotent: it starts, restarts and reports in one word.
Logs and pids live in `.bench/` (gitignored).

Note: `make stop` stops **everything**, including Zaid's stack. Use
`make bench-stop` unless you mean to take the whole machine down.

## Signing in and seeding (no real emails, ever)

Developer sign-in is the **real** sign-in. There is no parallel auth path: the
only concession to testing is that an account on the reserved
`@dev.decimal.test` domain is created already verified, because no inbox exists
to read a verification code from. Everything else — password rules, sessions,
org creation, invites — behaves exactly as it does for a customer.

- **Browser**: http://localhost:5274/**dev-login** (never linked from the
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

## Inbound invoice email (no provider account needed)

Customers forward bills to `<org-slug>@<INBOUND_EMAIL_DOMAIN>`. In production
Resend posts a Svix-signed webhook to `/webhooks/resend/inbound`; the bench
drives the **same handler** through a dev-only simulate endpoint, so no Resend
account, no MX records, and no public ingress are required.

```
curl -s localhost:3200/webhooks/resend/inbound/simulate \
  -H 'content-type: application/json' \
  -d @api/tests/fixtures/inbound-email/email-received.basic.json
```

Before sending, edit the fixture: set `secret` to `DEV_AUTH_SECRET` from
`api/.env`, and change `data.to` to the org's real address (get it from
`GET /organizations/:id/inbound-email/address`, or the "Forward by email"
dialog on Bills). The `from` must be an **active member's** email — that is the
sender policy, not a bug.

Fixtures in `api/tests/fixtures/inbound-email/`:

| Fixture | What it exercises |
|---|---|
| `email-received.basic.json` | happy path — one PDF becomes a bill in `needs_review` |
| `email-received.stranger.json` | sender not on the team → recorded, ignored, no bill |
| `email-received.unknown-org.json` | address matches no org |
| `email-received.no-attachments.json` | plain mail with nothing to read |
| `email-received.multi-attachment.json` | inline logo skipped, .docx skipped, PDF ingested |
| `email-received.outlook-signature.json` | a 3 KB `image001.png` sent as a real attachment, not inline — skipped by size and name once the bytes arrive, PDF beside it still ingests |

`attachmentBytes` maps an attachment id to base64 bytes, which the fetcher
consults before any network call. To use a real invoice instead of the tiny
sample: `base64 -i your-invoice.pdf | tr -d '\n'` and paste it in.

Only signature verification is bypassed — org resolution, sender authorization,
dedupe, persistence, the fetch queue and the sweep are all the real code paths.
Sending the same fixture twice should return `{"status":"deduped"}` and create
nothing new.

**The sender gets told when their email makes no bill.** Only ever a recognised
member, never a stranger, and once per message. On the bench nothing actually
leaves the machine unless `RESEND_API_KEY` and `RESEND_FROM_EMAIL` are set;
either way, `inbound_email_messages.sender_notified_at` records whether a
notice went out, and the `inbound_email.sender_notified` log line says which
one. `email-received.no-attachments.json` is the quickest way to see it.

**Feature flags:** the webhook 404s unless `INBOUND_EMAIL_DOMAIN` and
`RESEND_INBOUND_WEBHOOK_SECRET` are both set in `api/.env` (they must be set
together, and the domain must be a dedicated subdomain — never the domain we
send from). The simulate endpoint additionally needs `DEV_AUTH_SECRET`.

## The brief → report loop

1. CLI Claude finishes a change and writes a brief to
   `synthetic_data/testbench/briefs/NNN-<slug>.md`: what changed, exact steps,
   expected result per step, and what would count as a failure.
2. Zaid (or a scheduled run) hands desktop Claude one line:
   *"Run the latest test brief in synthetic_data/testbench/briefs/ per TESTBENCH.md."*
3. Desktop Claude: `make bench` (idempotent — starts or restarts) → executes
   the brief in the browser and/or API → writes
   `synthetic_data/testbench/reports/NNN-<slug>.md` with **PASS/FAIL per step**,
   expected-vs-saw for every failure, and exact repro steps. Blunt honesty;
   bugs are the deliverable. Screenshots can't be saved to disk from the
   in-app browser — describe what was seen instead.
4. CLI Claude reads the report and fixes; the brief gets re-run until green.

## Ground rules for the desktop side

- Never touch :3100, :5174, or the `usdc_ops_local` database — that is Zaid's
  stack, in his browser. The bench is :3200 / :5274 / `usdc_ops_bench`.
- Never touch decimal.finance or anything under Cloudflare — that's production.
- Fresh orgs have no vendors/categories: create counterparties via API first
  if the brief involves vendor/category behavior (or the brief will say so).
- If the bench won't start, paste the tail of `.bench/api.log` into the
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
