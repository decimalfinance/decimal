# Test bench: how agents verify their own work

Purpose: every change is verified by an agent driving the real product on the
bench, not by Zaid clicking around. The agent that made the change proves it
with `scripts/drive`, a fresh `verifier` agent judges anything a person will see
or act on, and the evidence lands on disk. Zaid reads results, and is asked for
nothing except a real sign-in to Intuit or Xero.

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
- **Any other address** goes through Check your email, as a customer's does.
  The bench sends no email (`SEND_EMAIL=false`, set by `scripts/bench.sh`), so
  the page shows the six-digit code in a note and `POST /auth/register` returns
  it as `devEmailVerificationCode`. Use `@example.test` addresses for these:
  nobody receives mail there.
- **Fixtures**: `POST /auth/dev/seed` `{secret, organizationName, owner, members[]}`
  builds users + org + active memberships + role bundles in one call and returns
  a session token per persona — worth it because assembling that through real
  endpoints is a dozen round-trips. `secret` = `DEV_AUTH_SECRET` in `api/.env`.
  Roles: bill_clerk / approver / payer / viewer. Access: admin | member.
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

`attachmentBytes` maps an attachment id to base64 bytes, which the fetcher
consults before any network call. To use a real invoice instead of the tiny
sample: `base64 -i your-invoice.pdf | tr -d '\n'` and paste it in.

Only signature verification is bypassed — org resolution, sender authorization,
dedupe, persistence, the fetch queue and the sweep are all the real code paths.
Sending the same fixture twice should return `{"status":"deduped"}` and create
nothing new.

**Feature flags:** the webhook 404s unless `INBOUND_EMAIL_DOMAIN` and
`RESEND_INBOUND_WEBHOOK_SECRET` are both set in `api/.env` (they must be set
together, and the domain must be a dedicated subdomain — never the domain we
send from). The simulate endpoint additionally needs `DEV_AUTH_SECRET`.

## Driving the app: `scripts/drive`

The Claude browser tools cost a model round trip per click, so a ten-step check
took minutes. `drive` runs a headless Chrome from code: a page loads in under a
second, a whole flow (upload, the model reading the bill, the bill page) runs in
about 8 s, and the result comes back as JSON. `node scripts/drive/drive.mjs help`
is the reference.

```
node scripts/drive/drive.mjs status                 # bench up? which Chrome? which teams?
node scripts/drive/drive.mjs seed                   # a fresh team of six; the default from now on
node scripts/drive/drive.mjs upload <pdf> --as maya # a bill through the real endpoint, read by the model
node scripts/drive/drive.mjs shot bills inbox       # screenshots plus the screen as data
node scripts/drive/drive.mjs run <flow.mjs>         # a flow; or run -e '<code>' inline
node scripts/drive/drive.mjs smoke                  # every route in App.tsx as every person
```

- **People:** ava (owner), omar (admin), maya (bill clerk), daniel (approver),
  priya (second approver), lena (viewer); `--as nobody` is signed out. Each
  `seed` is a new organisation, so two checks running at once never see each
  other's bills.
- **Steps find things by their words**, as a person would: `d.click('Send for
  approval')`, `d.fill('Total due', '412.00')`, `d.see('In approval')`. A miss
  fails at once and lists what *is* on screen.
- **Facts come from data, looks from screenshots.** `d.read()` returns the
  screen (headings, buttons, fields with values, text); `d.api()` reads back
  what was stored. `d.shot()` saves a PNG; open it with Read to look at it.
- **Evidence:** every run writes `run.json` and its screenshots to
  `.bench/evidence/<slug>/`; a failing step also saves `fail.png`.
- **A crash is a state, not a white page.** `kit/ErrorBoundary.tsx` shows "This
  page couldn’t be shown" and puts the error in `data-app-crash` (React catches
  it, so it is not an uncaught page error); drive fails the step and names the
  error. To check a crash on purpose, `await d.breakApi(regex)` makes matching
  API reads return `{}`, `d.expectCrash()` waits for the crash page without
  failing, and `await d.breakApi(null)` mends the API for the recovery. Uncaught errors outside
  React, and any step that failed, fail the run.
- **Lasting flows** that prove a feature live in `scripts/drive/flows/` (start
  from `bill-comes-in.mjs`) and get committed with the feature.

## Verifying a change

1. **The author proves it.** Before committing a change a person will see,
   drive it: a flow with a `d.check` per thing that should now be true, run on
   a fresh team. Done means the flow passes and the evidence exists. "It
   compiles" and "the test passed" are not evidence that a screen works.
2. **Shared UI, the frame or routing changed:** also run `drive smoke`.
3. **A fresh agent judges.** For a new flow or a changed screen, spawn the
   `verifier` agent (`.claude/agents/verifier.md`) with a brief: what should
   now be true, in product words, never how the code does it. It writes its own
   flow, runs it, and writes `synthetic_data/testbench/reports/<slug>.md` with
   PASS/FAIL per claim and evidence paths. The author fixes and re-asks until
   it is green. The author never grades their own work.
4. **Zaid is not in the loop**, except a real sign-in to Intuit or Xero. Then
   the report says exactly what to click, with the password and a direct link,
   and everything around the sign-in is verified by the agent.

## Ground rules for any agent on the bench

- Never touch :3100, :5174, or the `usdc_ops_local` database: that is Zaid's
  stack, in his browser. The bench is :3200 / :5274 / `usdc_ops_bench`. drive
  refuses Zaid's ports.
- Never touch decimal.finance or anything under Cloudflare: that's production.
  Never drive Xero's or Intuit's own websites.
- A fresh organisation has no vendors, and starts with the built-in categories
  in `api/src/accounting/default-chart.ts`.
- If the bench won't start, read `./scripts/bench.sh logs` before debugging.

## Notes from earlier runs

- An empty organisation's Bills page uploads on drop and opens the bill once it
  is read. Once there are bills, upload through **Upload a bill**; the file joins
  the dialog's list, **Upload 1 file** sends it, and the page stays on the list.
- The model takes about 6–30 s to read a bill: `d.see('$312.40', { timeout: 120000 })`.
- Members get 403s on the frozen payment pages (wallets, proposals, spending
  limits). `drive smoke` lists them as console warnings, not failures.
