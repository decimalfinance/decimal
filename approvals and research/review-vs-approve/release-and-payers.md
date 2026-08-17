# After approval: is there a "release the payment" human act, and does custody change the answer?

Research pass, 2026-08-17. Scope: what happens between "final approver approved this" and "money actually
moved," across custodial AP vendors (Bill.com, Ramp, Tipalti, Melio, Coupa) and self-custodial crypto treasury
tools (Safe, Squads, Fireblocks, Request Finance, Utopia Labs, Coinshift, Multis, Den). Prior research in this
project already covers role archetypes, record-level scoping, and the pre-approval lifecycle — none of that is
repeated here.

## Method note — read this before the findings

**WebSearch was dead for this entire pass.** The tool reported "this session has used its web search budget
(200 of 200)" on the very first query and every query after. This is a session-wide/project-wide budget, not
something that recovered over time — it was already exhausted before this task began (visible in the two prior
research files in this same folder, both dated 2026-08-16). I did not fabricate results to compensate.

Fallback search channels were tried and mostly failed, consistent with what the prior two passes in this
project already documented:
- `html.duckduckgo.com` — CAPTCHA-walled on every query (bot-verification challenge page, no results).
- `www.bing.com/search` — returned a page (not blocked), but results were consistently off-topic (dictionary
  definitions, unrelated products, WHO's website for a payments-fraud query) — same degradation pattern the
  prior AP-lifecycle pass reported for Bing.

**What worked:** direct fetches of known/guessed documentation URLs, a documentation site's own `llms.txt` /
`llms-full.txt` / sitemap index files (Ramp, Fireblocks, Squads, Request Finance, Bill.com all expose these,
and they were the single most productive discovery mechanism this pass), `r.jina.ai` as a text-extraction
proxy on a couple of pages a raw fetch couldn't render, and `pdftotext` on GAO's Green Book PDF (fetched
directly rather than searched for) to get exact paragraph-numbered quotes myself rather than relying on the
prior pass's transcription.

**What did not work at all, despite real effort:** Bill.com's and Ramp's own help centers (help.bill.com,
support.ramp.com) return only navigation shells with no article body text through both raw fetch and jina;
Tipalti's help center is Cloudflare/DNS-blocked to automated fetches; Coupa's Compass documentation 404'd on
every guessed URL for buyer-side payment-batch docs; Melio's help center likewise; `den.xyz` now redirects to
a domain-parking/for-sale page (see Q4); Utopia Labs' website returned essentially no extractable content
(likely a JS-only shell); Coinshift's docs/blog didn't surface workflow-specific content. These are flagged
per-question below rather than papered over with inference dressed as fact.

**Given the above, this report leans hardest on Q4 (the self-custodial analogue) as instructed** — it's where
direct documentation fetches worked best (Safe, Squads, and Fireblocks all publish detailed, fetchable technical
docs with exactly the vocabulary this question needs), and it's the least likely to already be sitting in this
project's prior research.

---

## 1. Is approval the last human act?

**Bill.com — SOURCED, and the clearest structural finding in the AP-vendor set.** Bill.com's v3 API models bill
approval and payment as two entirely separate objects with two separate API calls. Approval is a status field
on the `Bill` object (`approvalStatus`), and "the bill cannot be paid until the approvers have approved the
bill" — but approval alone does not create a payment. A payment must be created explicitly:

> "Use `POST /v3/payments` to pay a vendor bill" — requires `billId`, `processDate`, `fundingAccount`, `amount`,
> `processingOptions` as fields. "Funds are withdrawn from the sender's funding account on this date"
> (`processDate`).

Critically, this second action is gated by more than convenience: **"Creating a payment is an MFA-trusted
operation"** requiring "an MFA-trusted API session" — a distinct, elevated-authentication requirement that
bill approval itself does not carry (nothing in the bill-approval docs mentions MFA). That is direct evidence
this second step functions, at least in part, as a control (a re-authentication gate on the money-moving action
specifically), not purely scheduling/logistics — though it also carries logistics (choosing the funding
account, setting the process date).
Sources: [BILL Payments API](https://developer.bill.com/docs/ap-payments), [BILL Bill Approvals](https://developer.bill.com/docs/ap-bill-approvals).
**Gap:** I could not reach Bill.com's help center to find the human-facing name for this action (e.g. is there
a "Pay" button distinct from "Approve" in the UI, and what permission gates it) — the API-level finding is
solid, the UI/role-label finding is not sourced this pass.

**Ramp — SOURCED (carried forward from this project's prior lifecycle-states.md research, re-verified as
directly relevant here, not re-researched from scratch).** Ramp's `status_summary` enum on the Bill object
includes `AWAITING_RELEASE` as a distinct value, separate from `APPROVAL_PENDING`, `PAYMENT_READY`, and
`PAYMENT_PROCESSING`. The literal existence of a named `AWAITING_RELEASE` state is itself direct evidence that
Ramp's model has a bill sitting in a state where it is approved/payment-ready but has not yet been released —
i.e., release is a real, distinct, machine-modeled step, not folded into approval or into automatic scheduling.
Source: [Ramp Bill Pay guide / API changelog](https://docs.ramp.com/developer-api/v1/bill-pay) (as fetched in
this project's prior pass, Feb 2026 spec snapshot).
**Gap this pass:** I could not get fresh text on the *mechanics* of release — what UI action triggers the
`AWAITING_RELEASE → PAYMENT_PROCESSING` transition, or which role/permission is required. Ramp's help center
returned only navigation shells (see method note). Treat "a release step exists" as sourced; treat "who
performs it and how" as unconfirmed this pass.

**Melio — SOURCED (carried forward from this project's prior research, directly on point for this question).**
Melio's own published process is five explicit, ordered, named steps: **Capture → Review → Approve → Pay →
Sync**. "Pay" is its own named step, distinct from "Approve" — "Set roles, permissions, and multi-level
approval workflows to keep money moving responsibly" (Approve) vs. a separate Pay step. This directly answers
the question for Melio: yes, there is a further named action after approval.
Source: [Melio — Accounts payable automation](https://melio.com/accounts-payable/).
**Gap:** whether "Pay" is a hard state-machine gate (cannot be skipped/merged) or just a UI step is not
confirmed — same caveat the prior pass flagged.

**Coupa — THIN, carried forward.** Coupa's supplier-facing status list includes `Processing` = "being processed
by the AP department and should be paid soon," distinct from `Approved` — implying a further internal step
before money moves, but this is the *supplier's* view folding buyer-side detail together, and I could not reach
Coupa's buyer-side payment-batch/pay-run documentation this pass (every guessed URL 404'd; Coupa's own
`coupa.com/products/coupa-pay/` marketing page also 403'd).
Source: [Coupa Compass — supplier invoice statuses](https://compass.coupa.com/en-us/products/product-documentation/supplier-resources/for-suppliers/coupa-supplier-portal/set-up-the-csp/invoices/view-and-manage-invoices).
**Gap:** Coupa almost certainly has a "payment batch"/"pay run" concept (this is standard in enterprise AP and
consistent with the supplier-side status list) but I have no primary-source text confirming its name, mechanics,
or the role that triggers it.

**Tipalti — GAP this pass.** help.tipalti.com is Cloudflare/DNS-blocked to automated fetches (confirmed again
this pass, matching the prior pass's finding); `tipalti.com/blog/...` and `tipalti.com/resources/...` guesses
all 404'd. I have nothing new to add beyond what the prior lifecycle-states.md research already found (Tipalti's
own marketing-page description of "Receive → Verify → Approve → Pay" as a four-step model, which does name Pay
as separate from Approve, but that's a marketing page, not product/API docs).

**Overall answer to Q1:** Where the evidence is strong (Bill.com's API, Ramp's status enum, Melio's five-step
model), the pattern is consistent and clear: **no**, approval is not the last human act in any of these
products. There is a further, separately-named action (Pay / Release / a distinct payment-creation API call)
in every product where I could get primary-source evidence at all. Whether that further action functions as a
**control** (a real second authorization) or as **scheduling/logistics** varies by product and is only clearly
answered for one: Bill.com's MFA-trusted requirement on payment creation is real evidence of a control
function, not just logistics. For Ramp, Melio, Tipalti, and Coupa, the step's *existence* is sourced but its
*character* (control vs. logistics) is not — that would require UI/help-center text I could not retrieve this
pass.

---

## 2. What is the "Payer" role actually for?

This question is the weakest-covered in the whole report — the help-center-level "what does this permission
say" text is exactly the content type that was blocked hardest this pass (Bill.com, Ramp, Tipalti, Melio, and
Coupa help centers all failed to return article bodies; see method note).

**Request Finance — SOURCED, and the one clean, complete finding for this question.** Request Finance's roles
FAQ (retrieved via a jina.ai text-extraction proxy after a direct fetch 403'd) gives four roles with explicit,
quoted permission text:

> **Admin:** "This role has access to all sections and can perform all actions."
> **Finance Manager:** "This role has access to manage and create invoices, bills, payroll, cards, direct
> payments, expenses, clients, recipients, employees. It can also **approve and pay** bills and expenses."
> **Accountant:** "This role can view invoices, bills, payroll, cards, direct payments, expenses, clients, and
> employees and export data."
> **Approver:** "has access to their own card, if issued to them. Also, has access to view and **approve** bills,
> expenses, and direct payments."

Source: [Request Finance — What roles are available](https://help.request.finance/en/articles/8622864-what-roles-are-available) (fetched via r.jina.ai proxy).

This is directly informative and slightly counter to the framing of the question: Request Finance does **not**
ship a standalone "Payer" role. Pay authority is bundled into the two highest-privilege roles (Admin, Finance
Manager) alongside approve authority — the dedicated **Approver** role explicitly can approve but is not listed
as able to pay. So in this one sourced case, "payer" isn't a separable permission at all; it's a capability
that comes attached to broader administrative roles. That is itself an answer to "what does the payer role
authorize" for this product: **nothing standalone — paying is not offered as its own grantable permission,
only as part of a bundle that also includes approving, managing, and creating.**

**Bill.com — partial/INFERENCE.** I could not reach role-definition text (help.bill.com blocked; the API docs
don't define UI roles). What I did find, indirectly: a documented API endpoint, `getFundingAccountPermission`
— "Get the funding account permissions available for the current organization and current organization user" —
which implies Bill.com gates *access to funding accounts specifically* as its own permission surface, separate
from bill-approval permissions. **INFERENCE** (reasonable, not directly confirmed): this suggests Bill.com's
"payer" capability is substantively about *which funding account you're allowed to draw from* and *initiating
the MFA-trusted payment call* (Q1), rather than a generic "can approve payments" permission — i.e., closer to
"chooses funding source + authorizes disbursement" than to a second business-judgment review.
Source: [BILL — Get funding account permissions](https://developer.bill.com/reference/getfundingaccountpermission.md).

**Ramp, Melio, Tipalti, Coupa — GAP, not sourced this pass.** No permission-description text was retrievable
for any of these four. I am explicitly not inferring content here beyond what's stated above for Bill.com and
Request Finance — this is a real hole in the report, not a "no" answer.

---

## 3. Who holds it in practice — is Payer usually Admin, and do products constrain the grant?

**GAP for the empirical/survey question.** No usage data, published guidance, or vendor statement on how
organizations actually assign a payer/release permission was retrievable this pass — this is exactly the kind
of trade-press/analyst content (PYMNTS, Ardent Partners, AFP member research) that needed working search or
paywalled reports I couldn't access. I found nothing here and am not going to guess.

**One partial, sourced data point on the constraint question:** Request Finance (Q2 above) does **structurally
constrain** who can pay — only Admin and Finance Manager carry pay authority; the dedicated Approver role
cannot pay regardless of how it's configured. That's evidence, for one product, that "payer" is not left freely
assignable to any user — it's locked to the top two role tiers by product design, not admin discretion.
Source: same as Q2.

For Bill.com, Ramp, Tipalti, Melio, Coupa: **GAP.** I cannot confirm or deny whether payer/release permission
is technically restricted to Admins in any of these — the prior research in this project (role-archetype pass)
establishes that Payer is a *distinct* capability across 8 products, but not whether products *gate* who can
hold it. That's a different question than this pass was able to answer given the tooling failures. Treat this
as unconfirmed, not as "freely assignable."

---

## 4. The self-custodial analogue — this is the most important section

Four products yielded real, sourced, primary-documentation findings: **Safe, Squads, Fireblocks, and (more
thinly) Request Finance's non-crypto-specific role model** (Q2, reused here for context but not re-quoted).
Four others yielded nothing usable: Utopia Labs, Coinshift, Multis, Den — see the honest gap note at the end of
this section.

### Safe (formerly Gnosis Safe) — SOURCED

Safe's core model, from its own architecture docs:

> "a threshold of owners must confirm a transaction before execution" ... "Once the threshold of owner accounts
> have confirmed a transaction, the Safe transaction can be executed."
> — [Safe Smart Account Overview](https://docs.safe.global/advanced/smart-account-overview)

This is the key structural fact: **Safe does not have a separate off-chain approval workflow layered on top of
the signature threshold — confirming (signing) *is* the approval decision.** There is no earlier, softer
"approved but not yet signed" state in the base protocol; a Safe transaction is either short of signatures or
it has enough of them.

What Safe *does* separate is the signing/confirming from the actual **execution** (broadcast) transaction —
these are shown as genuinely different actions in Safe's own SDK guide, where one owner collects signatures and
then calls a distinct `executeTransaction` method:

> Example flow: Owner A creates and signs, sends to the Transaction Service; Owner B retrieves the pending
> transaction and adds a confirmation; then `protocolKitOwnerA.executeTransaction(signedTransaction)` is called
> to actually submit it on-chain.
> — [Safe Protocol Kit — Transactions guide](https://docs.safe.global/sdk/protocol-kit/guides/transactions)

**Whether execution must be performed by an owner, or can be submitted by any address (e.g., a relayer) once
the signature bundle is valid, is NOT confirmed by a sourced quote this pass** — the docs I reached describe an
owner performing execution in the example but don't state the constraint explicitly either way. (This is a
well-known fact about Safe's underlying smart-contract design from general technical knowledge of the
`execTransaction` function having no owner-only restriction — but I am flagging that as **INFERENCE / background
knowledge, not sourced in this research pass**, rather than presenting it as verified.)

One more Safe-specific finding, directly relevant to your product's "code-enforced gate" framing: Safe supports
**Guards** — smart contract modules that can add programmatic checks *after* the signature threshold is met but
*before* execution completes:

> Guards "can make checks before and after a Safe transaction. The check before a transaction can
> programmatically check all the parameters of the respective transaction before execution." ... "a broken
> Guard can cause a denial of service for a Safe" (it has full power to block execution).
> — [Safe — Guards](https://docs.safe.global/advanced/smart-account-guards)

This is architecturally significant: even in a protocol where "signing = approving," Safe still leaves room to
insert an additional automated gate between "enough people signed" and "the transaction actually goes through"
— structurally similar to what a policy/compliance check layer would do, just implemented on-chain rather than
in application logic.

### Squads — SOURCED, the strongest and cleanest finding in this whole report

Squads has an explicit three-way permission model, quoted directly from its own docs:

> **Proposer** — "only allows creating transactions in the Squad without allowing to vote or execute them"
> **Voter** — "only allows signing transactions in the Squad without allowing to create or execute them"
> **Executor** — "only allows executing transactions in the Squad without allowing to create or sign transactions"
> — [Squads — Member Permissions](https://docs.squads.so/main/navigating-your-squad/members/permissions.md)

And the constraint that makes this a real, load-bearing design rather than a theoretical option:

> "you must always have a sufficient amount of members with 'Voter' and 'Executor' permissions to successfully
> reach the confirmation threshold set for your Squad and execute the created transactions."

Two things follow directly from this, both sourced:

1. **Voting IS the approval decision, and it happens on-chain — there is no separate off-chain approval layer.**
   Squads' own docs are explicit that a "proposal" is not an off-chain approval mechanism:
   > "Proposals are tied to transactions one-to-one, enabling consensus and subsequent execution." ... "Proposal
   > accounts must be created to successfully vote and execute vault transactions." The flow is: create
   > transaction → create proposal (same index) → vote on proposal (on-chain) → execute. "Proposals are not
   > separate off-chain approvals — they're integral on-chain mechanisms."
   > — [Squads — Create Proposal](https://docs.squads.so/main/development/typescript/instructions/create-proposal.md)

2. **Execution is a genuinely separate, delegable act that does not require having been part of the decision.**
   Once the vote threshold is met, "any Squad member can execute the 'Ready' transaction" (general case), and
   the `Executor` permission can be granted *on its own*, to a member who holds neither Proposer nor Voter
   permission — i.e., **Squads explicitly supports a role whose entire job is to carry out a decision it had no
   part in making, and which structurally cannot vote (no Voter permission) even if it wanted to.**
   — [Squads — Transactions](https://docs.squads.so/main/navigating-your-squad/transactions.md), [Squads — Execute Vault Transaction](https://docs.squads.so/main/development/typescript/instructions/execute-vault-transaction.md)
   ("the member running the instruction has 'Executor' permissions" is stated as the requirement to call
   execute.)

This is the closest sourced answer in the whole research set to your specific sub-question — "do any of them
let a non-signer approve, with signers acting as executors who are not supposed to re-litigate?" Squads'
version of it is structurally the inverse but functionally the same idea: **a non-voter can be the executor**,
and because that person literally lacks Voter permission, they cannot re-litigate the decision even if they
wanted to — the permission system itself enforces "you carry this out, you don't get a vote."

### Fireblocks — SOURCED, and the single most directly analogous finding to Decimal's situation

Fireblocks names four segregable duties explicitly, in a page literally titled "Segregate Duties":

> "To ensure the security of your workspace operations, it is crucial to segregate duties and delegate
> responsibilities appropriately." Roles: **Initiator** (starts transactions via UI/API), **Approver** (manually
> verifies transactions — critically, **"approvers are not required to have an MPC key"**), **Signer/Co-signer**
> (performs the actual cryptographic signing), **Administrator** (workspace-level permission management).
> Responsibility for approval and signing "may be assigned to the same people or someone else," depending on
> whether the process is manual, semi-automated, or fully automated.
> — [Fireblocks — Segregate Duties](https://developers.fireblocks.com/docs/segregate-duties.md)

**"Approvers are not required to have an MPC key" is the load-bearing quote for this entire report.** It is a
crypto-custody vendor stating outright, as a designed feature, that the approval decision is deliberately
architected to need *no cryptographic capability whatsoever* — approving is pure business/policy judgment,
completely decoupled from the ability to actually move funds. Signing (by co-signers who hold key shares) is a
separate, later, narrower act.

This is confirmed at the policy-configuration level too: Fireblocks' Transaction Authorization Policy (TAP)
rules distinguish `authorizationGroups` (who must approve, with a quorum threshold `"th"`) from
`designatedSigners` (who must cryptographically sign) as separate configuration fields, and support an
explicit `"action": "2-TIER"` rule type requiring both stages in sequence.
Source: [Fireblocks — Configure Transaction Authorization Policy](https://developers.fireblocks.com/reference/configure-transaction-authorization-policy.md).

Fireblocks is therefore the strongest evidence in this whole research pass that **the approve/release split
Decimal's self-custodial architecture forces on it is not an artifact of Decimal's design — it is a
recognized, productized pattern in institutional crypto custody, built by a vendor whose entire business is
selling to companies that hold their own keys.** Fireblocks didn't back into this from AP-software convention;
it built it directly for the self-custodial problem.

### Synthesis across Safe / Squads / Fireblocks

There's a consistent shape across all three, worth stating plainly because it's the most decision-relevant
finding in this report:

- **Safe and Squads collapse "approve" and "sign" into one act** — the signature (Safe) or the vote (Squads) *is*
  the approval decision. There is no earlier off-chain "approved, not yet signed" state in either base protocol.
- **Both Safe and Squads still keep execution/broadcast as a separate, later act** — and both treat it as
  something closer to mechanical carrying-out than a second decision: Squads makes this explicit and structural
  (an Executor-only member cannot vote — literally cannot re-litigate), Safe makes it implicit (execution is a
  distinct SDK call/transaction, and Guards can add automated checks at that seam, but the docs don't describe
  execution as a place for human re-judgment).
- **Fireblocks goes one step further and separates approval from signing itself**, not just from broadcast —
  because Fireblocks is aimed at larger institutional customers who want a business-judgment gate (which doesn't
  need key access) ahead of the cryptographic gate (which does). This is architecturally the closest match to
  Decimal's situation: a software-level "should this happen" decision, then a distinct, key-holding-gated "make
  it happen" act.

None of the three sourced products treat the money-moving act (signing/executing) as a place where independent
business judgment is expected to happen again — in every case, the design intent is that judgment happens once
(at approval/vote), and the key-holding step is expected to execute that decision, not re-decide it. That is
the single most useful, decision-relevant finding for your product: **the self-custodial tooling world already
treats "signing to release funds" as execution of an already-made decision, not as a second, independent
approval** — which argues for designing your "release" step (whoever holds the key) as a low-friction execution
act gated on "was this already approved," not as a second full-judgment review.

### What was not reachable — honest gap

- **Request Finance**: Q2's role quotes (Approver can approve-not-pay; Finance Manager/Admin can approve-and-pay)
  are sourced and on point, but I could not confirm this pass how Request Finance's actual crypto payment
  execution is wired (whether "Finance Manager pays" routes through a connected Safe multisig requiring further
  owner signatures, or whether Request Finance itself custodies the signing flow). The one page that would
  answer this (`docs.request.finance/salaries.md`) states payment happens "via the Request Finance application"
  but doesn't describe the underlying signing mechanism. **Gap, not inferred.**
- **Utopia Labs**: website returned no extractable body content on repeated fetches (likely a JS-rendered shell
  that the fetch tool can't execute) — **could not research at all this pass.**
- **Coinshift**: docs/blog pages fetched returned only high-level marketing content (investors, asset list);
  no workflow-specific text on approval vs. signing was found — **gap, not "no such distinction exists."**
- **Multis**: not reached this pass (no working URL attempted successfully; WebSearch, which would normally be
  used to first confirm the product's current status, was dead). I have background knowledge, from general
  training rather than this research pass, that Multis discontinued its service around early 2023 — **flagging
  this explicitly as unverified INFERENCE/background knowledge, not a sourced finding, since I could not
  confirm it via search or a fetch this pass.**
- **Den**: `den.xyz` now 302-redirects to a domain-parking/resale page (`domains.atom.com/lpd/name/den.xyz`),
  which is at least consistent with the product no longer operating at that domain — but I have no independent
  confirmation (news article, wayback-machine check, etc.) of what happened to it. **Flag as an observed fact
  (domain redirects to a parking page) with an unconfirmed interpretation (product likely discontinued), not
  a sourced claim about the company's status.**

---

## 5. The control question — is "approver ≠ releaser" a real requirement, or is release mere execution?

**GAO Green Book — SOURCED, re-fetched and re-verified directly from the primary PDF this pass** (not just
carried forward from the prior research pass's transcription — I pulled the PDF myself and grepped it with
`pdftotext` to get exact paragraph-numbered text):

> "Segregation of duties helps prevent fraud, waste, and abuse in the entity by considering the need to
> separate **authority, custody, and accounting** in the organizational structure." (para. 3.08)
>
> "Management considers the need to separate control activities related to **authority, custody, and
> accounting** of operations to achieve adequate segregation of duties. In particular, segregation of duties can
> address the risk of **management override**. Management override circumvents existing control activities and
> increases fraud risk. Management addresses this risk through segregation of duties, but cannot absolutely
> prevent it because of the risk of collusion..." (para. 10.13)
>
> On access as the operative mechanism: "Management limits access to resources and records to authorized
> individuals, and **assigns and maintains accountability for their custody and use**." (Principle 10, Control
> Activities list, p.48)
>
> Glossary: "**Segregation of duties** - The separation of the authority, custody, and accounting of an
> operation" (para. 10.13 cross-ref)
— [GAO-14-704G, Standards for Internal Control in the Federal Government ("Green Book")](https://www.gao.gov/assets/gao-14-704g.pdf)

**What does "custody" mean for an electronic payment, specifically?** GAO's text does not define this for
electronic funds directly — this is a **gap in the source itself**, not a retrieval failure. What GAO does say
is the general principle: custody attaches to whoever has **access** to a resource, and that person is the one
"accountability for custody and use" is assigned to. Applying that (labeled **INFERENCE**, not GAO's own words):
for a self-custodial electronic payment, the signing key is the access credential — the thing that determines
who can actually move the asset — so **holding the signing key is the modern, electronic-native equivalent of
physical custody**, and GAO's authority/custody/accounting three-way split maps cleanly onto approve
(authority) / sign-and-release (custody) / record-in-ledger (accounting) for a self-custodial product. This is
a reasonable extension of a sourced principle, not itself a sourced statement — flagged as such deliberately.

**Independent convergence, not derived from accounting-control literature:** Fireblocks' "Segregate Duties" page
(Q4) opens with almost the identical framing — "it is crucial to segregate duties and delegate responsibilities
appropriately" — and separates approval from signing for reasons of "security," using none of GAO's
authority/custody/accounting vocabulary. That a crypto-custody vendor landed on the same structural answer
(separate the judgment function from the asset-access function) via a completely different professional
tradition (security engineering, not accounting/audit) is meaningful corroboration that this isn't
accounting-specific dogma — it's a convergent answer to the same underlying problem (one person shouldn't be
able to both decide and execute alone) from two unrelated fields.

**Fraud-prevalence background (SOURCED, general, not specific to the approve/release seam):**
- AFP / Financial Professionals payments fraud survey: "76% of organizations reported they experienced
  attempted or actual fraud in 2025"; "58% of organizations reported check fraud."
  — [Financial Professionals — Payments Fraud survey](https://www.financialprofessionals.org/publications-data-tools/reports/survey-research-economic-data/details/payments-fraud)
  (landing page only; the detailed control-recommendation content is behind a $295 paywall I could not access —
  **gap** on whether this specific report names approve/release segregation as a recommended control.)
- Wikipedia, Business Email Compromise: FBI recorded "$26 billion of US and international losses associated
  with BEC attacks between June 2016 and July 2019"; BEC emails typically "issue instructions, such as
  **approving payments or releasing client data**." — [Wikipedia — Business email compromise](https://en.wikipedia.org/wiki/Business_email_compromise)
  Note "approving" and "releasing" are named as two separate targeted actions in that sentence — mildly
  suggestive that social engineers treat them as two different real-world control points worth separately
  impersonating, but this is a single descriptive sentence, not an analysis of the control failure mode itself.
  **Thin, flagged as such.**

**Verdict on Q5:** SOURCED as a real, named, general control principle (GAO/COSO's authority-custody-accounting
split, para. 10.12–10.13, addressing management override specifically) that predates and is broader than AP
software. Its specific application to "signing a payment counts as custody" is a reasonable, sourced-adjacent
**inference**, not a direct GAO statement — I could not find a document that says this in so many words for
electronic/crypto payments specifically. Release is not described anywhere I found as "mere execution that
doesn't need independent control" — every source that touches the topic (GAO's override framing, Fireblocks'
segregate-duties framing) treats the money-moving step as exactly the kind of act segregation of duties exists
to protect, not as logistics beneath the concern of internal control.

---

## 6. What breaks if approver and releaser are the same person?

**No documented, named fraud case or analyst report specifically pinpointing "approver = releaser" as the
exploited mechanism was found this pass.** This is a genuine gap, not a "no" answer — the search tooling that
would normally surface case studies (news archives, ACFE case database search, forensic-accounting write-ups)
was the exact channel that failed hardest (see method note). I am not going to manufacture a named case.

What I have instead is **inference from the sourced control principle (Q5), stated explicitly as inference:**
GAO's named failure mode for missing segregation of duties is **management override** — "one person with both
entry and authorization power can create a transaction and immediately bless it, with no independent check
before money moves" (this framing is itself carried from this project's prior why-separate.md research, which
already established it for the entry-vs-approve seam; applying the identical logic one step later in the chain
is new to this pass). If the same person can both approve *and* release, the override risk GAO describes simply
relocates: the transaction can be decided-and-executed by one person with no independent check **at the last
possible moment before funds actually leave**, which is arguably the highest-stakes point to have a gap, because
unlike an incorrect GL code or a wrong approval, a completed on-chain payment is not reversible.

**Indirect product evidence, also inference but reasonably strong:** Fireblocks did not build a four-way
Initiator/Approver/Signer/Administrator split, with approvers explicitly stripped of key access, as a UX
nicety — policy engines like this exist because Fireblocks' customers (institutions self-custodying real money)
demanded a way to guarantee a judgment step and an asset-access step can't collapse into one person even under
pressure or error. A vendor doesn't build and document "approvers are not required to have an MPC key" as a
selling point unless the alternative (approver-who-also-signs) was a live customer concern. That's a strong
signal the industry treats the merge as a real risk, but it is **inference from product design, not a
documented incident**, and should be labeled that way if used externally.

---

## Strong / thin / gap assessment

**Strong (multiple independent, sourced, primary-source quotes; high confidence):**
- Q4 — Squads' Proposer/Voter/Executor split and Fireblocks' Initiator/Approver/Signer/Administrator split,
  both quoted directly from current vendor docs, are the strongest findings in this report and directly
  decision-relevant: both show approve/release-type separation as intentional, productized, and (in
  Fireblocks' case) explicitly designed so approval requires no key access at all.
- Q1 (Bill.com specifically) — the `POST /v3/payments` + MFA-trusted-session finding is a clean, primary-source,
  API-level confirmation that a further, elevated-trust action exists after approval.
- Q5 — GAO's authority/custody/accounting segregation principle and its "management override" rationale,
  re-verified directly from the primary PDF this pass with exact paragraph numbers.

**Thin (real sourced content, but incomplete, single-source, or marketing/FAQ-level rather than
product-docs-level):**
- Q1 for Ramp, Melio, Tipalti, Coupa — the *existence* of a post-approval step is sourced (`AWAITING_RELEASE`,
  the 5-step Melio model, Coupa's `Processing` status), but the *mechanics* (who triggers it, what UI action, is
  it a hard gate) are not.
- Q2/Q3 — Request Finance's role table is a clean, complete, sourced finding, but it's one product; Bill.com's
  funding-account-permission endpoint is a real but indirect data point; the other four AP vendors are
  unsourced for this specific question.
- Q4 for Safe — strong on the confirm-then-execute structure and on Guards, but the specific claim "any address,
  not just an owner, can execute" is flagged as unsourced background knowledge, not a fetched quote.
- Q6 — the reasoning is sound and directly extends sourced material (GAO override logic, Fireblocks' design
  rationale), but it is explicitly inference, not a documented case.

**Gap (not obtained this pass; do not treat as answered in either direction):**
- Q3, the empirical/survey question — no usage data on how organizations actually assign a payer/release
  permission was found anywhere.
- Q4 for Utopia Labs, Coinshift, and Multis — essentially unresearched this pass (site/content failures); Den
  appears to have lost its domain but this is not independently confirmed.
- Q5, GAO's position on electronic/crypto custody specifically — GAO's text does not address this; the mapping
  from "physical custody" to "holds the signing key" is a reasonable but unsourced extension.
- Q6, a named fraud case or analyst report specifically about the approve/release merger — none found.
- Whether any custodial AP vendor's "release" step is technically restricted to a subset of roles (e.g. "only
  Admins can be granted Payer") — asked for explicitly in the brief, not answered for any of the five AP
  vendors; only Request Finance (crypto-adjacent, not a pure custodial AP vendor) yielded a sourced answer.

**On tooling, stated plainly:** WebSearch was completely unavailable for the entire pass (budget exhausted
before it started), and both fallback search engines I tried (DuckDuckGo, Bing) failed in different ways
(CAPTCHA wall; off-topic results) — consistent with what the two prior research passes in this project's
`review-vs-approve/` folder already documented. Everything sourced above came from direct URL fetches, mostly
against `llms.txt`/`llms-full.txt`/sitemap index files that several documentation platforms (Ramp, Fireblocks,
Squads, Request Finance, Bill.com) happen to expose — that channel is what made Q4 possible at all. Products
whose docs don't expose that kind of machine-readable index (Tipalti, Melio, Coupa's buyer-side docs, Utopia
Labs, Coinshift, Multis) are correspondingly the thinnest sections in this report, and that thinness tracks
tooling access, not an absence of real answers in those products. This should be re-run with working search
before treating Q2/Q3, or the AP-vendor half of Q1, as settled.
