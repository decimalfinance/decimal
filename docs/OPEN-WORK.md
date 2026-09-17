# Open work

Things that were designed but never built. Compiled 2026-09-17 by checking the old research recommendations against the code. Delete an item when it ships.

## Designed, not built

- **Auto-approve fast path in the Flow Builder,** and vendor or category conditions on flow rules.
- **Advisory chip for approvers** that says whether a bill looks routine. A `signal` already reaches the bill detail screen. The open part is making it a considered, trustworthy recommendation.
- **Documentation and memo rules** as a policy type: require a note or attachment above a threshold.
- **Budgets.**
- **Class and Location pass-through to QuickBooks, bulk coding, and a coding accuracy view.**
- **Multi-invoice PDFs.** One upload that contains several bills should offer to split into several bills.
- **Intake actions to check against the code before building:** retract an approval, mark as synced, vendor-level hold.

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
