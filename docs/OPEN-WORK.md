# Open work

Things that were designed but never built. Compiled 2026-09-17 by checking the old research recommendations against the code. Delete an item when it ships.

## Designed, not built

- **More exception investigators.** The exception agent investigates `possible_duplicate` only. Next, on the same framework (`api/src/exceptions/`): lines that do not sum, totals that do not reconcile, and statement or credit note. Each needs an eval set before it ships. This replaces the old "advisory chip" idea: an investigation of a specific flag, rather than a guess at whether a bill looks routine.
- **Evaluate the duplicate investigator on hard cases.** It is proven on one real pair (B4 against A2). The X-series — corrected reissues, recurring same-amount bills, reused numbers, a genuinely ambiguous pair — is requested from the invoice agent; run `api/scripts/exception-eval.mts` once it exists.
- **Documentation and memo rules** as a policy type: require a note or attachment above a threshold.
- **Budgets.**
- **Class and Location pass-through to QuickBooks, bulk coding, and a coding accuracy view.**
- **Multi-invoice PDFs.** One upload that contains several bills should offer to split into several bills.
- **Retract an approval** (an approver takes back their own sign-off; recall is the submitter's tool) and **mark as synced** (resolve a bill already entered in QuickBooks by hand). Neither exists. Vendor-level hold, once on this list, is built.
- **Team members, the rest of design 1a.** Removing someone from an organisation needs an endpoint and a rule for the approval tasks they hold: reroute them through the silent recompile, or refuse while they hold any. The design's remove menu and confirmation were left out until then. Invitation emails: the design says "They’ll get an email"; today the admin copies a link that is shown once (`sendInviteEmail` beside `sendVerificationEmail` would do it). Handing on the primary admin role has an endpoint (`/primary-admin/transfer`) but no place in the new page.
- **Approval rules, the rest of designs 1a to 1c.** The design's Decimal agent ("tell Decimal how bills should be approved") is left out: the flow assistant behind it (`/approvals/flow/assist`) can only add steps and amount splits, so it would misdescribe vendor, category and new-vendor splits. It comes back once it can make all four. The organisation keeps one draft, so two admins editing at once overwrite each other's changes (the last save wins) and the page doesn't say someone else is editing; a draft per person, or a note naming whoever saved last, would settle it.
- **Sign in, the rest of turn 7.** There is no way to reset a forgotten password (designs 7e to 7h): it needs a reset token, an endpoint and an email, so the "Forgot password?" link was left out. Check your email asks for the six-digit code Decimal sends, not the design's link. The design's 10-character password minimum isn't enforced: the server and the pages keep 8, so nobody already signed up is locked out. The Terms and Privacy line under Create an account waits for those pages. With the Resend settings in `api/.env`, every confirmation email fails because the sending domain (decimal.finance) isn't verified in Resend; the bench sends none and shows the code instead.
- **Organisation and Your account, the rest of designs 3a and 2b.** Your picture can't be changed: Decimal has nowhere to keep one, so the design's camera and its menu were left out and the picture is Google's or initials. The Password row's "Last changed" needs a column on `users`; it was left out because a new `users` column breaks a running API until `make dev` applies the schema again. The sentence under No self-approval ("When no one else can approve a bill, whoever sent it can, and the bill says so") was left out: the engine refuses a sender's own approval until the primary admin turns the rule off, and changing that is a product decision. Exceptions shows the last 90 days, 100 bills at most, with no paging.
- **Vendors, the rest of designs 1a and 2a.** "Also billed as" lists a vendor's other names, but nothing records which bill came in under which name, so the design's "on OT-118, 3 Mar" after each was left out; recording the bill when a name is added to `nameAliases` would bring it back. A vendor keeps no email or address of its own, so both pages show its newest bill's; a vendor record with its own contact would let a person correct it once. A bill's vendor record is set when it arrives and moves only when someone answers that two vendors are one company, so a bill whose file couldn't be read stays on the "Unreadable document" record (left off the list) after someone keys its vendor in: it shows on no vendor's page, and a hold on that vendor doesn't reach it. Keying in a vendor should move the bill onto that vendor's record, known or new.
- **Routes only the old pages called.** No screen has called these since the redesign, though each is still mounted and tested. Remove each, or give it a screen: `GET /bills/:id/draft` (the bill page reads `/detail`), `PATCH /bills/:id/facts`, `POST /bills/:id/comments`, `POST /bills/:id/ask/suggest-fields`, `POST /bills/:id/questions/:id/answer` and `/close` (a question is now a chat message), `GET /companion/ready` with `POST /bills/:id/confirm-as-read` (the quick pass), `GET /companion/chats`, `GET /inbound-email/messages`, `POST /approvals/flow/simulate`, `POST /approvals/pipeline/simulate` and `POST /inbox/seen-all`. Separately, the old Approval flow page's switch that let whoever entered a bill approve it (`org_settings.clerk_can_approve`) can no longer be set, but nothing on the new pages shows it or clears it: an organisation that turned it on has Separate entry and approval off for everyone.

## Deferred on purpose

Revisit only when a customer needs them: custom roles, department or entity scoping, field masking, GL-account scoping per role.

## Open product question

**How Decimal pays a bill.** The Solana and Squads payment code is frozen, not deleted. It was built when Decimal was a Solana product. Whether to keep, rewrite or remove it gets decided when payment work starts. See the frozen section of `ARCHITECTURE.md`.

## Where the research went

The repo used to carry a research folder: competitor studies and synthesis docs behind approvals, roles, access, policies, GL coding, intake, and review versus approve. Everything it recommended either shipped or is listed above, so it was removed to keep the repo technical.

Code comments still cite it, for example `roles-research/SYNTHESIS-decimal-roles.md §1F`. Those point at git history. The last commit that contains the folder is `c609124`:

```bash
git show "c609124:approvals and research/roles-research/SYNTHESIS-decimal-roles.md"
git ls-tree -r --name-only c609124 -- "approvals and research"
```
