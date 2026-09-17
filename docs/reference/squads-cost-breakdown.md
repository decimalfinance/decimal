# Squads v4 Cost Breakdown For Decimal

This document explains the lamport/SOL cost model for using Squads v4 inside
Decimal. It covers treasury creation, config proposals, payment proposals,
voting, execution, spending limits, vaults, and token-account creation.

Sources:

- Solana transaction fees: https://solana.com/docs/core/fees
- Solana rent exemption RPC: https://solana.com/docs/rpc/http/getminimumbalanceforrentexemption
- Squads v4 program: https://github.com/Squads-Protocol/v4
- Squads SDK used by Decimal: `@sqds/multisig`

## Mental Model

Squads does not charge "per instruction" in the way a traditional API charges
per request. On Solana, lamports are spent because of:

- Transaction signature fees.
- Optional priority fees.
- Rent deposits for newly created accounts.
- Explicit program fees, if the program has one configured.
- Token account creation, especially associated token accounts.

Compute units matter, but compute units do not automatically become lamport
cost unless a priority fee is attached. Compute is primarily a transaction
capacity and scheduling constraint.

## Base Solana Costs

| Item | Cost |
| --- | ---: |
| Base transaction fee | `5,000 lamports * number_of_signatures` |
| Priority fee | `ceil(compute_unit_limit * compute_unit_price_micro_lamports / 1_000_000)` |
| Rent exemption | Use `getMinimumBalanceForRentExemption(data_len)` |
| Current rent estimate | about `(data_len + 128) * 6,960 lamports` |
| SPL associated token account rent | about `2,039,280 lamports` |

The rent estimate is useful for reasoning, but production code should always
ask RPC for the exact value with `getMinimumBalanceForRentExemption`.

## Squads Program Fee

Squads v4 has a program config account that can define a multisig creation fee.
At the time this was checked, both devnet and mainnet returned:

| Network | Squads multisig creation fee |
| --- | ---: |
| Devnet | `0 lamports` |
| Mainnet | `0 lamports` |

This should not be assumed forever. If Squads changes program config, Decimal
should read it from chain.

## Account Rent Table

These values come from the Squads SDK account byte-size calculations and Solana
rent exemption estimates.

| Account / State | Bytes | Rent Lamports | SOL |
| --- | ---: | ---: | ---: |
| Multisig, 1 member | 165 | 2,039,280 | 0.002039280 |
| Multisig, 3 members | 231 | 2,498,640 | 0.002498640 |
| Multisig, 10 members | 462 | 4,106,400 | 0.004106400 |
| Proposal capacity, 1 member | 166 | 2,046,240 | 0.002046240 |
| Proposal capacity, 3 members | 358 | 3,382,560 | 0.003382560 |
| Proposal capacity, 10 members | 1030 | 8,059,680 | 0.008059680 |
| Config transaction: change threshold | 88 | 1,503,360 | 0.001503360 |
| Config transaction: add member | 119 | 1,719,120 | 0.001719120 |
| Config transaction: remove member | 118 | 1,712,160 | 0.001712160 |
| Config transaction: add spending limit, 1 destination | 232 | 2,505,600 | 0.002505600 |
| Config transaction: add spending limit, 5 destinations | 360 | 3,396,480 | 0.003396480 |
| Config transaction: remove spending limit | 118 | 1,712,160 | 0.001712160 |
| Spending limit account, 1 agent + 1 destination | 203 | 2,303,760 | 0.002303760 |
| Spending limit account, 1 agent + 5 destinations | 331 | 3,194,640 | 0.003194640 |
| Vault transaction: 1 USDC transfer | 285 | 2,874,480 | 0.002874480 |
| Vault transaction: 2 USDC transfers | 340 | 3,257,280 | 0.003257280 |
| Vault transaction: 8 USDC transfers | 670 | 5,554,080 | 0.005554080 |
| SPL associated token account | 165 | 2,039,280 | 0.002039280 |

## Decimal Actions And Who Pays

| Decimal Action | Squads Instructions | New Accounts | Who Pays | Lamport Cost |
| --- | --- | --- | --- | --- |
| Create treasury | `multisigCreateV2` | `Multisig` | creator | multisig rent + 2 signatures + Squads creation fee |
| Register extra vault | none, PDA derivation only | none | nobody | `0` on-chain |
| Create config proposal | `configTransactionCreate` + `proposalCreate` | `ConfigTransaction` + `Proposal` | proposer | both rents + 1 signature |
| Create payment proposal | `vaultTransactionCreate` + `proposalCreate` | `VaultTransaction` + `Proposal` | proposer | both rents + 1 signature |
| Approve proposal | `proposalApprove` | none normally | voter | 1 signature |
| Reject proposal | `proposalReject` | none normally | voter | 1 signature |
| Execute config proposal | `configTransactionExecute` | maybe `SpendingLimit` | executor | 1 signature + maybe spending-limit rent |
| Execute payment proposal | `vaultTransactionExecute` | maybe recipient ATA | executor | 1 signature + maybe ATA rent |
| Agent spending-limit payment | `spendingLimitUse` | maybe recipient ATA | agent | 1 signature + maybe ATA rent |
| Close proposal / transaction accounts | close instructions | closes old accounts | closer | 1 signature, rent returned |

## Treasury Creation

Decimal currently creates Squads treasuries with `multisigCreateV2`.

For a 2-of-3 treasury:

| Component | Lamports |
| --- | ---: |
| Multisig account rent, 3 members | 2,498,640 |
| Base transaction fee, 2 signatures | 10,000 |
| Squads multisig creation fee | 0 |
| Total | 2,508,640 |

That is about `0.002508640 SOL`.

The Squads vault address is a PDA. Creating an additional vault index does not
itself allocate a new Squads account. Decimal can register another vault PDA in
the database with no on-chain cost. The cost appears later when token accounts
are created for that vault.

## Payment Proposal Cost

A normal Squads payment proposal creates:

- One `VaultTransaction` account.
- One `Proposal` account.
- One transaction signature from the proposer.

For a 1-payment proposal on a 3-member multisig:

| Component | Lamports |
| --- | ---: |
| VaultTransaction rent, 1 USDC transfer | 2,874,480 |
| Proposal rent, 3-member capacity | 3,382,560 |
| Base transaction fee, 1 signature | 5,000 |
| Total create-proposal cost | 6,262,040 |

Voting and execution are separate transactions:

| Action | Lamports |
| --- | ---: |
| One approve vote | 5,000 |
| One reject vote | 5,000 |
| Execute proposal, recipient ATA exists | 5,000 |
| Execute proposal, recipient ATA missing | 2,044,280 |

For a 2-of-3 payment where the recipient ATA already exists:

| Component | Lamports |
| --- | ---: |
| Create payment proposal | 6,262,040 |
| Two approve votes | 10,000 |
| Execute payment | 5,000 |
| Total | 6,277,040 |

If the recipient ATA does not exist, add `2,039,280` lamports.

Total with missing recipient ATA:

```text
6,277,040 + 2,039,280 = 8,316,320 lamports
```

## Batch Payment Proposal Cost

Decimal's current batch path creates one Squads `VaultTransaction` that contains
multiple transfer instructions. It does not use Squads batch accounts yet.

For an 8-payment batch on a 3-member multisig:

| Component | Lamports |
| --- | ---: |
| VaultTransaction rent, 8 USDC transfers | 5,554,080 |
| Proposal rent, 3-member capacity | 3,382,560 |
| Base transaction fee, 1 signature | 5,000 |
| Total create-proposal cost | 8,941,640 |

Full 2-of-3 batch if all recipient ATAs already exist:

| Component | Lamports |
| --- | ---: |
| Create batch payment proposal | 8,941,640 |
| Two approve votes | 10,000 |
| Execute batch | 5,000 |
| Total | 8,956,640 |

If all 8 recipient ATAs are missing:

```text
8 * 2,039,280 = 16,314,240 lamports
8,956,640 + 16,314,240 = 25,270,880 lamports
```

That is about `0.025270880 SOL`.

## Config Proposal Cost

Config proposals are used for treasury governance changes such as adding
members, changing threshold, adding an agent, or adding/removing spending
limits.

### Add Member

For a 3-member multisig:

| Component | Lamports |
| --- | ---: |
| ConfigTransaction rent, add member | 1,719,120 |
| Proposal rent, 3-member capacity | 3,382,560 |
| Base transaction fee, 1 signature | 5,000 |
| Total create-proposal cost | 5,106,680 |

Then add vote and execute fees:

```text
5,106,680 + 10,000 for two votes + 5,000 execution = 5,121,680 lamports
```

After this executes, the multisig has more members, so future proposal accounts
need more capacity and rent increases.

### Change Threshold

For a 3-member multisig:

| Component | Lamports |
| --- | ---: |
| ConfigTransaction rent, change threshold | 1,503,360 |
| Proposal rent, 3-member capacity | 3,382,560 |
| Base transaction fee, 1 signature | 5,000 |
| Total create-proposal cost | 4,890,920 |

Then add vote and execute fees.

### Add Spending Limit

For a 3-member multisig with a spending limit that allows one destination:

| Component | Lamports |
| --- | ---: |
| ConfigTransaction rent, add spending limit | 2,505,600 |
| Proposal rent, 3-member capacity | 3,382,560 |
| Base transaction fee, 1 signature | 5,000 |
| Total create-proposal cost | 5,893,160 |

Execution creates the actual `SpendingLimit` account:

| Component | Lamports |
| --- | ---: |
| SpendingLimit account rent, 1 agent + 1 destination | 2,303,760 |
| Execute transaction fee | 5,000 |

So the full cost is:

```text
create proposal + votes + execute + spending limit rent
```

For a 2-of-3 case:

```text
5,893,160 + 10,000 + 5,000 + 2,303,760 = 8,211,920 lamports
```

## Spending-Limit Payment Cost

Spending limits are the cheap path for trusted, repetitive, low-risk payments.

The agent does not create a proposal. It directly uses `spendingLimitUse`.

| Case | Lamports |
| --- | ---: |
| Recipient ATA exists | 5,000 |
| Recipient ATA missing | 2,044,280 |

This is much cheaper than a normal proposal because there is no `Proposal` or
`VaultTransaction` rent.

This is why Decimal should route small trusted payments through spending limits
when policy allows it.

## Rent Reclaim

Some costs are deposits, not permanent fees.

| Account | Reclaimable? | Notes |
| --- | --- | --- |
| Multisig | Not while treasury exists | Rent remains locked for treasury lifetime |
| Proposal | Yes | Can be closed after final state |
| ConfigTransaction | Yes | Can be closed after final state |
| VaultTransaction | Yes | Can be closed after final state |
| SpendingLimit | Yes, when removed/closed | Rent can be reclaimed after spending limit removal |
| Associated token account | Yes, but awkward | Only if token account is closed by authority/owner |

Decimal should eventually add cleanup jobs or admin actions to close finalized
Squads proposal/transaction accounts and reclaim rent.

## Compute Units

Compute units are not stable enough to hardcode as a product price table.

They vary with:

- Member count.
- Number of transfer instructions.
- Whether associated token accounts already exist.
- Whether address lookup tables are used.
- Whether the transaction is a config transaction, vault transaction, or
  spending-limit use.
- Current runtime/program behavior.

For user-facing estimates, Decimal should show:

```text
required SOL = signature fees + rent for accounts that will be created + optional priority fee
```

If Decimal starts using priority fees, then the additional lamport cost is:

```text
priority_fee_lamports = ceil(compute_unit_limit * compute_unit_price_micro_lamports / 1_000_000)
```

## Recommended Product Estimator

Decimal should eventually expose a backend estimator endpoint before signing:

```http
POST /organizations/:organizationId/treasury-accounts/:treasuryId/estimate-cost
```

The endpoint should:

1. Build the transaction or proposal intent.
2. Determine which accounts will be created.
3. Call `getMinimumBalanceForRentExemption` for those account sizes.
4. Check whether recipient ATAs already exist.
5. Optionally simulate the transaction to estimate compute units.
6. Return a clear SOL budget before the user signs.

Example response shape:

```json
{
  "network": "devnet",
  "baseFeeLamports": 5000,
  "priorityFeeLamports": 0,
  "rentLamports": 6257040,
  "ataRentLamports": 2039280,
  "totalLamports": 8301320,
  "items": [
    {
      "label": "Vault transaction account rent",
      "lamports": 2874480
    },
    {
      "label": "Proposal account rent",
      "lamports": 3382560
    },
    {
      "label": "Recipient associated token account rent",
      "lamports": 2039280
    },
    {
      "label": "Transaction signature fee",
      "lamports": 5000
    }
  ]
}
```

## Product Implications

- Normal Squads proposals are safe but rent-heavy.
- Spending-limit execution is dramatically cheaper for trusted low-value
  payments.
- Batches are efficient compared to creating one proposal per payment.
- Missing recipient ATAs can dominate execution cost.
- Proposal and transaction-account rent should be reclaimed later.
- Decimal should not surprise users with rent. The UI should estimate required
  SOL before proposal creation or execution.

