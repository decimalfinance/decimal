# AP Workbench — Screen 2: Bills Workbench (the operator's home)

Date: 2026-07-06 · Status: design, round 1 — for the Claude Design → screenshot-critique loop.
Depends on: ap-page-map.md (A1), approval-lifecycle.md (macro states), ap-workbench-screen1 (the row → review-screen destination), target-architecture.md (payment/rail states).
Vocabulary: SESSION-NOTES §2. Layout assumes the left sidebar (per screen-1 ruling). Visual-first: avatars, pills, states — not prose.

## 0. The job of this screen

This is the page the operator opens every morning and the page the review screen returns to. One question: **what needs me, and where is everything else?** It is a triage surface, not a spreadsheet — the design succeeds if a finance operator with 40 open bills knows in three seconds what to touch first.

Not this screen's job: approving (that's the approvals inbox, screen 4 — different persona), configuring rules, paying. This screen *routes attention*; it doesn't make decisions.

## 1. The spine: lifecycle states as the primary navigation

The macro states from the engine, grouped into what the operator actually thinks in. Top-of-page **segment tabs** (not a dropdown — these are the operator's mental buckets, always visible with live counts):

| Tab | Engine states behind it | The operator's question |
|---|---|---|
| **Needs review** ● | captured → needs_verification | "what did we receive that I haven't checked?" |
| **In approval** | pending_approval, returned_for_info, on_hold | "what's with the approvers?" |
| **To pay** | approved → awaiting_release, scheduled | "what's cleared and queued to go out?" |
| **Done** | paid, reconciled/synced | "what's settled?" |
| **Needs attention** ⚠ | held_duplicate, match_exception, returned payout, rejected, unresolvable | "what's stuck or wrong?" |

Design rules:
- **Needs review** is the default tab and carries the accent dot; **Needs attention** carries the only warning color on the page — those two are where the operator's time goes.
- Counts are live and are the point ("Needs review 7"). A zero-count tab goes quiet, not hidden (predictable position matters more than tidiness).
- This is deliberately fewer than the raw engine states — the lifecycle doc has ~10 macro states; the operator sees five buckets. Sub-states surface as the row's status pill, not as top-level tabs.

## 2. The row — what one bill shows

A row is scannable left-to-right as a sentence: *who · what · how much · when · where it is · who's holding it.*

- **Vendor** — avatar + name (the anchor; everything else modifies it).
- **What** — one-line description or the top line item ("Cloud hosting — July"); the memory the operator recognizes it by.
- **Amount** — right-aligned, base currency; foreign bills show base with the original quiet beneath ("$18,400 · €17,000").
- **Due** — date, and **this is where the discount thread lives**: a bill with an expiring early-pay discount shows a small amber-urgent chip ("2% off — 4 days," from screen 1's terms parse). Overdue shows red. This column is why "sort by due" is the default within a tab.
- **State pill** — the sub-state ("Waiting on Priya", "Approved", "Duplicate?", "Payment returned"). Where a person is the blocker, the pill carries their avatar — the "waiting on a human" fact made a face.
- **Age** — quiet ("2d ago"); becomes visible-urgent past a threshold (a bill sitting in review for a week is a problem the design should surface).

Row click → the relevant screen: Needs-review rows open the review screen (screen 1) at that bill; In-approval/Done rows open bill detail (screen 3, read-only). The workbench never opens an editor for a bill that's left verification.

## 3. Attention mechanics (the triage layer)

- **Default sort within every tab: most urgent first** — a computed priority, not just date: expiring discounts and overdue climb, then due-date, then age. State it honestly in a sort control the operator can override ("Sorted by what's most urgent · change").
- **Needs attention** rows each state the fix in plain words as the pill ("Looks like a duplicate — review", "Payment came back — needs a new method"), and clicking goes straight to the resolution surface, not a generic detail page.
- A slim **"waiting on you" callout** at the very top only when the operator personally has verification work queued — the one nudge, never a wall of them.

## 4. Filters & search (secondary to the tabs)

Tabs are the primary cut; filters refine within. Keep the set small and finance-real: vendor, amount range, date range, "has a discount expiring," assignee/who's-waiting. Search is vendor-name and invoice-number first (what operators actually remember). No filter should be needed to do the daily job — the tabs already do it; filters are for questions, not for work.

## 5. Bulk actions (bounded — this is not where money moves)

Multi-select enables only the safe, non-authority operations: assign to a teammate, add a label, export, "mark as not a bill" (with reason). **No bulk approve, no bulk pay** — those are authority acts and live behind their own single-item ceremonies. Bulk exists to organize the queue, never to exercise judgment across it.

## 6. Empty & first-run

- True zero (new org): the empty state IS intake setup (page-map A4) — the AP email address to forward to, a big upload target, "forward your first bill to ap@…". The workbench and intake onboarding are the same screen when there's nothing in it.
- Empty tab (e.g., nothing in Needs attention): a calm one-liner ("Nothing stuck — you're clear"), not an illustration-heavy dead end.

## 7. What's deferred (don't design yet)

- The **cash/timing view** (bills sorted by pay-early savings vs cash on hand) — that's the payment-timing engine's surface; the discount chip here is the only foreshadowing v1 gets.
- Saved views / custom filters — power-user feature, post-v1.
- Cross-entity switching — waits on multi-hierarchy.

## 8. For the critique round (Fuyo)

React with screenshots against: (1) five tabs as the spine vs a single list with filters (Bill.com leans list+filters; Ramp leans states — we lean states, is five the right number?); (2) the row sentence — is "waiting on Priya" with a face the right blocker treatment, or too busy?; (3) the urgency sort as default (honest and useful, or unpredictable?); (4) whether Needs review and Needs attention carrying the only accent/warning colors reads as clear focus or as under-designed. Screenshot targets: Bill.com bills list, Ramp Bill Pay list, Melio dashboard (SMB-simple benchmark), Stampli's queue.
