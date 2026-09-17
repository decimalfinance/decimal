# 06 Squads v4 Capability Map

This document maps what the Squads v4 program can do, what Decimal currently exposes, and what remains if we want Squads to become the foundation layer for treasury automation.

Sources inspected:

- Squads v4 source cloned from `https://github.com/Squads-Protocol/v4` at commit `edbca83427b10cbe58bf65fc9b597e8eb7b17cc1`.
- Squads program Rust source under `programs/squads_multisig_program/src`.
- Installed SDK/IDL under `api/node_modules/@sqds/multisig`.
- Decimal implementation under `api/src/squads/treasury.ts`, `api/src/routes/treasury-wallets.ts`, `api/src/routes/proposals.ts`, `api/prisma/schema.prisma`, and `api/src/api-contract.ts`.

## Mental Model

Squads v4 is not just a multisig wallet. It is a program for controlled execution from vault PDAs.

The important layers are:

1. `Multisig`: the governance account. It stores members, permissions, threshold, timelock, current transaction index, stale transaction index, and optional rent collector.
2. `Vault`: a PDA controlled by the multisig. It is the treasury address that holds SOL or SPL tokens.
3. `Transaction`: either a config transaction, a vault transaction, or a batch.
4. `Proposal`: the voting state attached to a transaction index.
5. `Execution`: once enough votes approve and the timelock is released, a member with execute permission can execute the transaction.

Decimal should treat Squads as the source of truth for treasury authority. Decimal's database should store product context, proposal intent, payment metadata, and proof state, but the actual permission model lives on-chain.

## Core Program Accounts

- `Multisig`: members, permission masks, threshold, timelock, config authority, transaction counters, stale index, rent collector.
- `Proposal`: status plus approve/reject/cancel vote arrays for a transaction index.
- `ConfigTransaction`: one or more governance/config actions to apply to the multisig.
- `VaultTransaction`: one executable transaction message from a vault.
- `Batch`: parent account for multiple vault batch transactions under one proposal.
- `VaultBatchTransaction`: one executable transaction inside a batch.
- `TransactionBuffer`: temporary on-chain buffer used to assemble large vault transaction messages.
- `SpendingLimit`: delegated spending allowance from a vault, with mint, amount, period, permitted members, and optional allowed destinations.
- `ProgramConfig`: global Squads program config for authority, creation fee, and treasury.

## Member Permissions

Squads member permissions are a bitmask:

- `Initiate = 1`: can create config transactions, vault transactions, batches, and activate drafts.
- `Vote = 2`: can approve, reject, or cancel proposals.
- `Execute = 4`: can execute approved config/vault/batch transactions.

Important invariants enforced by the program:

- No duplicate members.
- Every member permission mask must be valid.
- There must be at least one member with `Initiate`, one with `Vote`, and one with `Execute`.
- Threshold must be greater than zero.
- Threshold cannot exceed the number of voting members.
- Timelock cannot exceed `7,776,000` seconds, roughly three months.
- Stale transaction index cannot exceed transaction index.

These invariants are why Decimal must validate proposed config actions before returning a signable transaction. Bad proposals waste signatures and fail on-chain.

## Proposal Lifecycle

Program states:

- `Draft`: proposal exists but is not open for voting.
- `Active`: proposal is open for approve/reject votes.
- `Approved`: approval threshold was reached.
- `Rejected`: enough rejections made approval impossible.
- `Executed`: approved proposal was executed.
- `Cancelled`: approved proposal was cancelled by enough voters.
- `Executing`: deprecated/transient state.

Vote behavior:

- Approve is only allowed while `Active`.
- Reject is only allowed while `Active`.
- Cancel is only allowed after `Approved`.
- An approve vote removes the same member's prior reject vote.
- A reject vote removes the same member's prior approve vote.
- Once approvals reach threshold, the proposal becomes `Approved`; remaining voters cannot keep voting because the proposal is no longer `Active`.
- Once rejections reach cutoff, the proposal becomes `Rejected`.
- Cutoff is `number_of_voters - threshold + 1`.

Staleness behavior:

- Config changes that alter governance-critical state call `invalidate_prior_transactions()`, which bumps `staleTransactionIndex` to the current transaction index.
- Stale config proposals cannot execute.
- Stale active/draft proposals cannot be voted on.
- Approved vault transactions and approved batches can still execute even if they become stale later.

## Full Squads v4 Instruction Surface

### Program Config

These are global program-admin instructions, not normal user treasury operations:

- `programConfigInit`
- `programConfigSetAuthority`
- `programConfigSetMultisigCreationFee`
- `programConfigSetTreasury`

Decimal should not expose these in product UI. They belong to the Squads program operator.

### Multisig Creation

- `multisigCreate`: deprecated.
- `multisigCreateV2`: creates a multisig with members, threshold, timelock, config authority, rent collector, treasury fee handling, and config validation.

Decimal uses `multisigCreateV2`.

### Direct Controlled-Multisig Config

These require `configAuthority` to sign. They are for controlled multisigs:

- `multisigAddMember`
- `multisigRemoveMember`
- `multisigSetTimeLock`
- `multisigChangeThreshold`
- `multisigSetConfigAuthority`
- `multisigSetRentCollector`
- `multisigAddSpendingLimit`
- `multisigRemoveSpendingLimit`

Decimal creates autonomous multisigs with no config authority, so normal Decimal treasuries should not use these direct instructions. Decimal should use config proposals instead.

### Config Transactions

- `configTransactionCreate`: creates a proposal transaction containing one or more config actions.
- `configTransactionExecute`: executes an approved config transaction.

Supported config actions:

- `AddMember`
- `RemoveMember`
- `ChangeThreshold`
- `SetTimeLock`
- `AddSpendingLimit`
- `RemoveSpendingLimit`
- `SetRentCollector`

There is no separate `ChangePermissions` action. Changing member permissions must be modeled as a remove-and-add flow or another safe composition, because the stored `Member` includes key plus permissions.

### Vault Transactions

- `vaultTransactionCreate`: stores a transaction message to execute from a vault.
- `vaultTransactionExecute`: executes an approved vault transaction.

Vault transactions support:

- arbitrary Solana instructions
- address lookup tables
- multiple instructions in one transaction
- ephemeral signer PDAs
- any vault index

Decimal currently uses this for USDC payment proposals and small payment runs.

### Transaction Buffers

- `transactionBufferCreate`
- `transactionBufferExtend`
- `transactionBufferClose`
- `vaultTransactionCreateFromBuffer`

Buffers let a member assemble a large vault transaction message in chunks and later convert it into a normal vault transaction. The program validates final hash and final size. This is useful when a transaction message is too large to pass comfortably in a single instruction.

Decimal does not currently use transaction buffers.

### Native Squads Batches

- `batchCreate`
- `batchAddTransaction`
- `batchExecuteTransaction`

Native Squads batches are not the same thing as Decimal payment runs.

In Squads:

- `batchCreate` creates one batch parent at one transaction index.
- `proposalCreate` attaches a proposal to that batch.
- `batchAddTransaction` can add multiple `VaultBatchTransaction` accounts while the proposal is still `Draft`.
- `proposalActivate` moves the batch proposal from `Draft` to `Active`.
- once approved, `batchExecuteTransaction` executes the next batch item in order.
- the proposal becomes `Executed` only after every batch transaction is executed.

This is the correct Squads primitive for large or sequential batch workflows. Decimal currently does not use native Squads batch accounts; our payment run proposal is one `VaultTransaction` containing multiple transfer instructions, capped at eight rows.

### Proposal Operations

- `proposalCreate`
- `proposalActivate`
- `proposalApprove`
- `proposalReject`
- `proposalCancel`
- `proposalCancelV2`

Decimal currently creates active proposals directly (`draft = false`) and supports approve/reject/execute. It does not expose draft activation or cancellation yet.

### Spending Limits

- `spendingLimitUse`

Spending limits allow selected members to transfer SOL or SPL tokens from a vault without a fresh vote each time, bounded by:

- mint
- amount
- reset period: `OneTime`, `Day`, `Week`, `Month`
- permitted members
- optional permitted destinations

Spending limits themselves are added or removed through config actions.

For Decimal's AI CFO direction, spending limits are one of the most important unimplemented primitives. They let the organization approve a bounded automation policy once, then let an agent or operator execute small payments within that policy without starting a full multisig vote for every payment.

### Account Cleanup / Rent Reclamation

- `configTransactionAccountsClose`
- `vaultTransactionAccountsClose`
- `vaultBatchTransactionAccountClose`
- `batchAccountsClose`

These close terminal or stale transaction/proposal accounts and reclaim rent to the multisig rent collector. They require the multisig to have a rent collector.

Decimal stores `rentCollector` during treasury creation, but does not expose cleanup actions.

## What Decimal Currently Implements

### Treasury Creation

Implemented:

- Create a Squads v4 treasury intent using `multisigCreateV2`.
- Select multiple organization personal wallets as members at creation.
- Configure per-member `initiate`, `vote`, and `execute` permissions.
- Configure threshold and timelock.
- Use the creator personal wallet as signer/rent payer.
- Confirm the creation signature through RPC.
- Persist the vault PDA as a `TreasuryWallet`.
- Store Squads metadata in `treasury_wallets.properties_json`.
- Sync on-chain members into `organization_wallet_authorizations`.
- View live treasury detail/status from on-chain state.

Relevant API:

- `POST /organizations/:organizationId/treasury-wallets/squads/create-intent`
- `POST /organizations/:organizationId/treasury-wallets/squads/confirm`
- `GET /organizations/:organizationId/treasury-wallets/:treasuryWalletId/squads/detail`
- `GET /organizations/:organizationId/treasury-wallets/:treasuryWalletId/squads/status`
- `POST /organizations/:organizationId/treasury-wallets/:treasuryWalletId/squads/sync-members`

### Config Proposals

Implemented:

- Create add-member config proposal.
- Optionally combine add-member with threshold change.
- Create change-threshold config proposal.
- List config proposals for a treasury.
- List config proposals across organization treasuries visible to the current on-chain member.
- Read one config proposal.
- Approve config proposals.
- Execute config proposals.
- Enforce visibility: only users with a personal wallet that is an on-chain member can see that treasury's Squads proposals.
- Enforce action permissions by checking on-chain member permission masks.

Relevant API:

- `POST /organizations/:organizationId/treasury-wallets/:treasuryWalletId/squads/config-proposals/add-member-intent`
- `POST /organizations/:organizationId/treasury-wallets/:treasuryWalletId/squads/config-proposals/change-threshold-intent`
- `GET /organizations/:organizationId/treasury-wallets/:treasuryWalletId/squads/config-proposals`
- `GET /organizations/:organizationId/treasury-wallets/:treasuryWalletId/squads/config-proposals/:transactionIndex`
- `POST /organizations/:organizationId/treasury-wallets/:treasuryWalletId/squads/config-proposals/:transactionIndex/approve-intent`
- `POST /organizations/:organizationId/treasury-wallets/:treasuryWalletId/squads/config-proposals/:transactionIndex/execute-intent`
- `GET /organizations/:organizationId/squads/proposals`

### Decimal Proposal Mirror

Implemented:

- `decimal_proposals` table as the local product mirror of Squads proposals.
- Proposal metadata stores program ID, multisig PDA, proposal PDA, transaction PDA, transaction index, semantic payload, and signatures.
- Generic proposal listing/detail for Decimal-backed Squads proposals.
- Generic approve, reject, and execute intent endpoints for Decimal proposals.
- Confirm proposal submission signature by RPC.
- Confirm proposal execution signature by RPC.
- Idempotent confirmation retry for execution signatures.
- RPC settlement verification for payment proposals.

Relevant API:

- `GET /organizations/:organizationId/proposals`
- `GET /organizations/:organizationId/proposals/:decimalProposalId`
- `POST /organizations/:organizationId/proposals/:decimalProposalId/confirm-submission`
- `POST /organizations/:organizationId/proposals/:decimalProposalId/confirm-execution`
- `POST /organizations/:organizationId/proposals/:decimalProposalId/approve-intent`
- `POST /organizations/:organizationId/proposals/:decimalProposalId/reject-intent`
- `POST /organizations/:organizationId/proposals/:decimalProposalId/execute-intent`

### Payment Vault Proposals

Implemented:

- Create one Squads vault transaction proposal for a single USDC payment order.
- Create one Squads vault transaction proposal for a payment run containing up to eight payment orders.
- Build the inner vault transaction as SPL token transfers from the vault's USDC ATA to destination token accounts.
- Omit destination ATA creation from the inner vault transaction because the vault PDA should not pay rent.
- Prepend destination ATA creation to the outer execution transaction, paid by the executor wallet.
- Verify executed payment settlement by fetching the execution signature through RPC and checking expected token-account deltas.
- Mark linked payment orders/runs as settled only when deltas match.
- Export payment proof packets from local state.

Relevant API:

- `POST /organizations/:organizationId/treasury-wallets/:treasuryWalletId/squads/vault-proposals/payment-intent`
- `POST /organizations/:organizationId/treasury-wallets/:treasuryWalletId/squads/vault-proposals/payment-run-intent`

Important limitation:

- Decimal payment runs currently use one `vaultTransactionCreate` with multiple transfer instructions. They do not use Squads `batchCreate` / `batchAddTransaction` / `batchExecuteTransaction`.

### Personal Wallet Signing

Implemented:

- Personal wallets belong to users, not organizations.
- Privy managed personal wallet creation.
- Versioned transaction signing with a Privy-backed personal wallet.
- Local deletion/archive flow for Privy embedded wallets.
- Organization wallet authorization rows linking personal wallets to org treasury authority.

Relevant API:

- `POST /personal-wallets/managed`
- `POST /personal-wallets/:userWalletId/sign-versioned-transaction`
- `DELETE /personal-wallets/:userWalletId`

## What Decimal Does Not Implement Yet

### Treasury Config Surface

Missing:

- Remove member proposal.
- Change member permissions proposal.
- Set timelock proposal.
- Set rent collector proposal.
- Add spending limit proposal.
- Remove spending limit proposal.

Reason this matters:

- Without these, Decimal can create and grow a multisig but cannot fully administer it.
- Spending limits are required for bounded automation and AI-operated pipelines.

### Proposal Lifecycle Surface

Missing:

- Draft proposal creation.
- Proposal activation.
- Proposal cancellation / cancel v2.
- On-chain account cleanup/rent reclamation.
- Explicit stale proposal actions in API and UI.

Reason this matters:

- Draft mode is needed for native Squads batches because batch transactions are added while the proposal is draft.
- Cancellation and cleanup are needed for serious treasury operations.

### Native Batch Surface

Missing:

- `batchCreate`
- `batchAddTransaction`
- `batchExecuteTransaction`
- batch transaction close and batch account close

Reason this matters:

- Current Decimal payment runs are small single-transaction batches.
- Native Squads batches support larger, sequential payment runs under one approval.
- This is the correct path if Decimal wants payroll/vendor runs with many rows.

### Large / Arbitrary Transaction Surface

Missing:

- Transaction buffers.
- Vault transaction create from buffer.
- Generic arbitrary instruction proposal builder.
- Ephemeral signer support in product flows.
- Multi-vault support beyond default vault index.
- Non-USDC SPL payments.
- Native SOL payments.
- Address lookup table management as a user-facing concept.

Reason this matters:

- AI workflows will eventually need to propose arbitrary treasury actions, not only USDC transfers.
- Large proposals need buffers or native batches.

### Spending Limit Execution

Missing:

- Use spending limit to send SOL/SPL from a vault.
- Track remaining amount and reset periods in the product.
- Map Decimal policies/agents to Squads spending-limit members and destinations.
- Proof packets for spending-limit executions.

Reason this matters:

- Spending limits are the cleanest bridge between "multisig approval" and "agent automation."
- A safe AI CFO should not need unrestricted execute authority. It should operate inside explicit on-chain spending limits.

## Recommended Completion Order

1. Finish core treasury administration.
   Implement remove member, change permissions, set timelock, and set rent collector as config proposals.

2. Add proposal cancellation and stale/terminal cleanup.
   Operators need a clean way to cancel approved-but-unwanted proposals and reclaim rent from terminal proposals.

3. Implement spending limits end-to-end.
   Add/remove spending-limit config proposals, list spending limits, and use spending limits for bounded SOL/SPL transfers.

4. Replace Decimal's small payment-run vault transaction with native Squads batches where appropriate.
   Keep the current single `vaultTransaction` path for small batches, but add true Squads batch accounts for larger or sequential runs.

5. Add transaction buffers for large vault transactions.
   This unlocks bigger arbitrary proposals and reduces client-side constraints.

6. Generalize from payment proposals to arbitrary treasury proposals.
   The product should support "AI proposes a treasury action" where the action may be a payment, spending-limit setup, treasury config change, or arbitrary safe instruction bundle.

7. Expand asset and vault support.
   Add native SOL, other SPL tokens, and additional vault indexes only after the core Squads operations are stable.

## Strategic Takeaway

For Decimal's current direction, Squads should be the execution and governance foundation.

The highest-leverage missing Squads primitive is spending limits. It gives us a real path to agentic workflows without asking users to trust an AI with full treasury authority.

The second highest-leverage primitive is native Squads batches. It gives us a cleaner foundation for payroll and vendor runs than stuffing many transfers into one vault transaction.

The current implementation is a solid first layer:

- create treasury
- manage membership partly
- create payment proposals
- vote/reject/execute
- verify payment settlement by RPC

But "complete Squads integration" requires covering the rest of the config action surface, proposal lifecycle, spending limits, batches, and cleanup.
