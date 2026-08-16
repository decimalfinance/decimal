# Who can see and act on a bill — Synthesis

**Date:** 2026-08-16. **Inputs:** two research passes in this folder —
`record-level-scoping.md` (10 products) and `out-of-chain-intervention.md`
(degraded search tooling, see its own strength assessment).
**Trigger:** Zara is the owner of Testing Labs. She has nothing to do with any
bill's approval chain, yet she can see every bill and edit every bill. If the
owner can do that, the approval cycle is decoration.

This supersedes nothing in `roles-research/SYNTHESIS-decimal-roles.md` — that
document mapped the FEATURE surface (which screens a role gets). This one is
about the RECORD surface (which bills), which that round explicitly deferred.

---

## 1. Where we already match or beat the market

Worth stating first, because it narrows the work a lot.

**Material change invalidates collected approvals.** Of ten products, exactly
one — Ramp — has a clean unconditional rule ("editing total, vendor or payment
details will always restart the approval chain and cannot be disabled"). Coupa
has the mechanism (a named `restart_approvals` action) but an unconfirmed
trigger. Xero and NetSuite let you edit an approved bill freely and only
protect the status flag. Six others are simply undocumented — checked page by
page and confirmed silent, not assumed.

We already do the Ramp thing: `applyMaterialChange` recompiles silently before
any decision and invalidates + restarts after one, and `updateBillFacts`
refuses material fields outright and refuses any edit once the bill leaves
review/draft. This is the strongest part of our design and it should not be
touched.

**Delegation checks the delegate.** Coupa's rule — the delegate must hold
equal-or-greater permission, time-boxed, logged with a reason — is the
best-sourced precedent in the intervention research. Our `delegate` and
`add_approver` both re-run the SoD veto against the TARGET at assignment time
and refuse an ineligible one. Same conclusion, reached independently.

**Approving is enforced by task assignment, not by role.** The engine refuses
anyone who is not the task's assignee. That is stronger than a route-level role
check, and stronger than what most of the market documents.

**Approvers cannot quietly rewrite the bill.** Melio and Concur don't let
approvers edit at all; Ramp locks amount, vendor and payment details in the
approver's view. We land in the same place by a different route.

## 2. Where we are the outlier

**Record scoping: we are Xero.** Seven of ten products scope the approver to
only the bills routed to them by default — Ramp, Tipalti, Stampli, Melio, QBO
(Advanced), Coupa, Concur. Xero is the documented outlier where anyone who can
approve sees and can approve every bill in the org. We are Xero: `bills.view`
is one capability over every bill in the workspace, and there is no per-record
scoping anywhere in the system.

**Assigned-to-me is the only near-universal axis.** Department/cost-centre is
enterprise-only (NetSuite, Ramp Plus, Coupa). Legal entity is enterprise-only.
Project-level scoping is done by nobody. Vendor and amount mostly drive
ROUTING, not visibility. So the scoping axis to build is the one everybody has,
and the rest are a trap at our stage.

**Nobody ships "small team, so everyone sees everything."** No product
documents an automatic widen-for-small-teams default. Stampli's own writing
argues explicitly against it and prescribes compensating controls instead, even
at two or three people. Our system behaves that way at every team size, and it
was never a decision — it is the absence of one.

**The owner/admin bypass is undocumented as a pattern anywhere.** PCAOB AS 2401
treats management override of controls as inherently hard to detect and
triggers specific audit procedures when suspected. What no source anywhere
addresses is the sharper question: whether a standing ability to override is
ITSELF a deficiency, independent of ever using it. Nobody has published an
answer. That means it is our call, not a lookup.

## 3. The gap that research could not close

**What happens when a chain resolves to nobody eligible.** Asked of every
product in scope; came back completely empty. Not a weak inference — an actual
absence of retrievable documentation, from Bill.com, Coupa, ServiceNow, Concur
and the rest. Block, escalate, auto-approve, assign an admin, fall back to the
owner: no evidence either way.

Melio is the one product with anything nearby, and its own documentation
contradicts itself — one article says bills pending when the last approver is
removed "proceed without approval," another says they get stuck. That is the
same bug class we have, shipped, in a product with real customers. Which is a
fair signal that this is genuinely unsolved rather than something we failed to
find.

We currently conscript the org owner. `compile.ts` says so deliberately, citing
a past deadlock, and reasons that "a recorded self-approval behind the R1
opt-in ceremony beats a silent pass."

**Recommendation, first draft — WRONG, corrected below.** The original argument
here was: stop inventing an approver, refuse to route, name the fix.
Conscripting the owner is how the owner ends up on every chain, and a
self-approval nobody chose is a silent pass with a name attached.

**What building it showed (2026-08-16).** Both halves of that were wrong.

*It is not a silent pass.* The conscripted task cannot be actioned until the
owner relaxes R1 through the Protections ceremony — owner-only, password
re-auth, a written reason, hashed acknowledgment, all on the record. That is a
deliberate decision by a named person, which is precisely what the argument
demanded. Removing the fallback deletes the only route a genuinely one-person
organization has to ever pay a bill, and the test that documents that path
(`approvals-flow.test.ts`, solo owner relaxes then approves) failed the moment
the fallback came out.

*It is not why the owner is on every chain.* Tier 3 only fires when tiers 1 and
2 find nobody, and tier 2 sweeps every non-requester admin. In Testing Labs the
bills route to Marcus and Priya; Zara is on none of them. The fallback fires in
decimal labs, where the owner is also the submitter and the only admin — which
is the case where refusing to route helps least.

**The actual defect was the dead end, not the conscription.** The engine's
refusal was correct and arrived as a 409 on the only button offered, naming a
rule code. The fix shipped instead: `viewer.cannotApprove` runs the same veto
check up front, so the screen says which rule, why it applies to you, and what
an admin can change — before you press anything.

## 4. The abstraction

Four questions are currently collapsed into one. They should stay apart:

| Question | Mechanism | State |
|---|---|---|
| Could this person ever do X? | role capability | built |
| May they do it to THIS bill? | **record scope** | **missing** |
| Is it their turn right now? | task assignment | built, engine-owned |
| Who decides who decides? | routing config + delegate/add/reassign | built |

The missing one is record scope, and it needs exactly one axis to start:

- **`all`** — the AP work surface. Reviewer, Payer, Accountant, Viewer/auditor,
  and admins. These jobs are defined by needing the whole queue.
- **`involved`** — the Approver. Bills routed to them, plus bills they
  submitted, entered, or were asked a question about.

That is one enum on a role, not a permissions engine. Department and entity
scoping stay unbuilt; the research says they are enterprise-tier and we would
be building them for nobody.

The governing principle for the fourth row, which resolves the Zara problem
without weakening admins:

> **An administrator changes who decides. An administrator never supplies the
> decision.**

Reassign, delegate, add an approver, recall and restart — all legitimate, all
recorded, all already built. "Approve it myself because I am the owner" is the
thing that voids the control, and it is the only power an admin should not
have.

## 5. Build order

1. **Record scope on the Approver role.** The approvals inbox already scopes
   correctly; the bills list and bill detail are what leak. One enum, one
   filter, two screens.
2. ~~Stop the owner fallback conscripting an approver.~~ **Superseded — see the
   correction in §3.** The fallback stays; what shipped is `cannotApprove`, so
   the refusal is legible before the click instead of a 409 after it.
3. **Assign the roles.** They exist and nobody holds one — every org is running
   on "owner bypasses everything" and "no roles means viewer." The roles layer
   is built and switched off, which is why the product feels like it has no
   access model.
4. Later, and only on evidence of need: department scoping, field-level
   masking, custom roles.

**Status 2026-08-16:** 1, 2 (as corrected) and 3 are shipped on
`feat/approver-actions`.

## 6. Confidence

Strongest: the material-change comparison (Ramp quoted directly), the 7-of-10
approver scoping count, Coupa's delegation constraints (three sources), PCAOB
AS 2401.

Thin: Bill.com throughout — their help centre was unreachable all session (TLS
failure), so their findings rest on public API docs alone. Coupa's help portal
needs SSO. NetSuite and Bill.com's actual default scope could not be confirmed.

Unanswered: the zero-eligible-approver fallback (§3), whether standing override
is itself a deficiency (§2), and any frequency data for how often out-of-chain
intervention really happens.

If §3 needs evidence rather than judgement, the cheap path is not more
scraping — it is a trial signup on Bill.com, Coupa or Ramp and twenty minutes
in the admin-side approval screens.
