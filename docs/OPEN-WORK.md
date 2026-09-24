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
