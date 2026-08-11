# Resolving a flag

Decisions taken 2026-08-11, from a review screen that showed three flags and
offered no way to answer any of them. The footer read "Resolve the flagged
issue above before sending" — a promise the UI could not keep.

## The shape

**Resolutions belong on the flag, not in the footer.** A flag states what is
wrong; the same block states what you can do about it. A global footer button
cannot, because the right answer differs per flag.

## The governing principle

**It must be hard for a bill to fail** — to end up in a state with no exit.
Every flag that blocks must offer at least one action that unblocks it, and
every action must lead somewhere. A bill stuck because nobody can resolve it is
the same failure as a bill paid wrongly, arriving more slowly.

This constrains the authority rules below more than it first appears. Each
approval requirement we add is a new way to get stuck: if only an admin can
answer "is this us?" and no admin looks, the bill is now stuck *behind the
resolution* rather than behind the flag. Requests must therefore be tracked
tasks that remind and escalate — never an open-ended wait on someone's
attention. The engine already does this (`request_info` + `sweepTimers`:
remind, then escalate, never auto-deny), so the rule is to route these through
it rather than invent a second mechanism.

## Who may resolve what

| Resolution | Who | Why |
|---|---|---|
| **This is us** — the bill names a company we trade as | **Owner/admin only** | It permanently changes what the org answers to, for every future bill. That is an identity claim about the organization, not a judgement about one invoice. |
| **Request "this is us"** | Any approver | An approver who recognizes the name can put the question to an admin, but cannot decide it. Becomes a tracked task, so it escalates rather than waits. |
| **Not ours** | Not a lone regular approver — admin, or a second pair of eyes | Killing a real payable is as costly as paying a false one; the vendor simply chases later. It deserves the same care as approving. |
| **Ask someone** | Any approver | Asking is never the dangerous act. It should be the cheapest thing on the screen. |

## "This is us" teaches, it does not silence

The valuable half. Adding the name to an org-level trading-names list clears the
flag *and stops it firing again for that name*. A one-time correction instead of
a recurring false positive — which matters more since hardening the matcher
made real subsidiaries and DBAs likelier to trip it.

A dismissal that has to be repeated every month trains people to click through
flags, which costs more than the flag saves.

## "Ask someone" is a system, not a button

Choosing who to ask is the feature. The reply loop, the parked state and the
escalation already exist in the engine; what is new is the routing and what we
learn from it.

Every ask records who was asked, about what, and whether they answered. Over
time that is real signal: who actually supplies missing bill details, who
answers quickly, who is asked most about a given vendor or category. That
becomes the default suggestion — "ask Priya, she answered the last four
questions about this vendor" — which is the AI-native part. Not extracting
fields, which everyone does, but knowing who to route a question to.

Deliberately not built yet: the suggestion. Record the data first, suggest once
the data says something. A suggestion built on nothing is a guess with a
confident face.

## Order

1. `organizations.trading_names` — the store (no metadata column exists today)
2. `namesLookRelated` consults org name **and** trading names
3. Generalize `overrideDuplicateFlag` into a flag-resolution mechanism any
   blocking flag can use, with the authority rules above
4. Review payload carries the viewer's task, so the page can offer Ask
5. Render resolutions on each blocking flag; remove the footer's promise
6. Record ask-routing data; suggest later
