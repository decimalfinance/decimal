# Backend Handoff: Drop Auto-Approve On Proposal Creation

Owner: codex / backend
Frontend status: blocked on this landing first
Scope: stop bundling a `proposalApprove` instruction in proposal-creation transactions. Every voter — including the proposer — should cast their vote as a deliberate, separate action.

## Why

Today every proposal-create endpoint accepts an `autoApprove?: boolean` flag (default `true`) and, when set, appends `multisig.instructions.proposalApprove(creator)` into the same `VersionedTransaction` as `configTransactionCreate` / `vaultTransactionCreate` + `proposalCreate`.

Two product reasons to remove it:

1. **The proposer should opt in to their own vote.** Treasury actions are sensitive enough that even the person initiating them should affirm with a separate signature. Bundling the vote into create makes that decision invisible.
2. **Keep the proposal in `Active` longer.** Squads flips `proposal.status` from `Active` → `Approved` the instant a vote crosses threshold. With auto-approve on, a 2-of-2 sees `1 of 2` approvals immediately, leaving zero room for the proposer to change their mind. With it off, the proposer can review the on-chain proposal account before voting.

We previously discussed "let voters vote while active even after threshold is met" — that's not achievable because Squads enforces the status transition at the program level inside the same approve instruction. Removing auto-approve is the only handle we control.

## Changes

### 1. Drop the parameter from the create schemas

In `api/src/routes/treasury-wallets.ts`:

```ts
const createSquadsAddMemberProposalSchema = z.object({
  creatorPersonalWalletId: z.string().uuid(),
  newMemberPersonalWalletId: z.string().uuid(),
  permissions: z.array(squadsPermissionSchema).min(1),
  newThreshold: z.number().int().min(1).max(65_535).optional(),
  memo: z.string().optional().nullable(),
  // autoApprove: z.boolean().optional(),   <-- remove
});

const createSquadsChangeThresholdProposalSchema = z.object({
  creatorPersonalWalletId: z.string().uuid(),
  newThreshold: z.number().int().min(1).max(65_535),
  memo: z.string().optional().nullable(),
  // autoApprove: z.boolean().optional(),   <-- remove
});

const createSquadsPaymentProposalSchema = z.object({
  paymentOrderId: z.string().uuid(),
  creatorPersonalWalletId: z.string().uuid(),
  memo: z.string().optional().nullable(),
  // autoApprove: z.boolean().optional(),   <-- remove
});
```

### 2. Drop the `autoApprove` branch in the instruction builders

In `api/src/squads-treasury.ts`:

- `createSquadsConfigProposalIntent` (used by add-member + change-threshold): the `...(args.autoApprove ? [proposalApprove(...)] : [])` spread inside the `instructions` array — remove it. `autoApprove` field on the input type goes too.
- `createSquadsPaymentProposalIntent`: same pattern (`...(input.autoApprove ?? true ? [proposalApprove(...)] : [])`) — remove.
- `createSquadsAddMemberProposalIntent` / `createSquadsChangeThresholdProposalIntent` input types: drop `autoApprove?`.

After this change, every `proposal-create-intent` endpoint produces a transaction that does exactly:

```text
configTransactionCreate (or vaultTransactionCreate)
proposalCreate
```

No third instruction. The proposal lands in `Active` state with zero votes recorded, regardless of multisig threshold or signer set.

### 3. Update tests

`api/tests/control-plane.test.ts` currently asserts add-member/change-threshold lifecycle under `autoApprove: true`. Update the test to:

- Stop sending `autoApprove` in the request body.
- After create, before the existing approve-intent step, the `Proposal` mock should report zero approvals (`approved: []`) and the proposer should be in `pendingVoters`.
- The creator (and any other voters) then approve via the existing `approve-intent` flow.
- Execute proceeds as today once threshold is met.

The 1-of-1 case becomes: create → creator approves → creator executes → sync. Three signed transactions instead of two.

### 4. (No new endpoint needed)

The `approve-intent` endpoint already supports the proposer voting after create. Nothing to add.

## What Frontend Will Do After This Lands

Three places need updates, all on me to handle in a follow-up commit:

1. **Treasury `AddMemberDialog` / `ChangeThresholdDialog`** — remove the auto-execute chain that exists for 1-of-1 multisigs (currently `create+autoApprove → execute → sync` in two signed transactions). With auto-approve off, the creator must vote first. The dialog will land at "awaiting your vote" after the create tx, with a "Cast vote" CTA that points at the proposal detail page where they approve/reject and then execute.
2. **Payment proposal create flow** — same: after create, navigate to the proposal detail page so the proposer can cast their vote before any execute step is possible.
3. **Proposal cards / tables** — the proposer now appears in `pendingVoters` immediately after create, and the `canCastVote` gate I just landed will surface the Approve/Reject buttons for them.

These frontend changes are non-blocking on each other; I can ship them once codex signals this backend change is in.

## Validation

- `npm run build` (api)
- `make test-api`
- A 2-of-2 manual run-through: create proposal → status `Active`, `0 of 2` approvals, both voters in `pendingVoters` (including the creator). Creator votes → `1 of 2`. Other voter votes → `2 of 2`, status `Approved`. Execute lands.
- A 1-of-1 manual run-through: create proposal → `0 of 1` approvals. Creator votes → `1 of 1`, status `Approved`. Creator executes.

## Out Of Scope

- Don't touch `proposalApprove`'s callable — voters still need that endpoint.
- Don't try to keep voting open after threshold met. Squads enforces the status transition on chain; this is not a frontend or backend toggle.
- Don't add a new "are you sure" gate on create. The lack of an auto-vote already does that work — the creator now has to actively sign the approve tx.
