# Open work

Things that were researched and designed but not built. Everything else in `approvals and research/` has shipped. Compiled 2026-09-17 by checking each research recommendation against the code. Delete an item when it ships.

## Has a real bug behind it

- **A unified "not a bill" screen.** A statement of account reached the review screen looking payable. Statements, credit notes, receipts, quotes and purchase orders are detected today, but there is no single interface for "what is this and what should I do with it". Design: `approvals and research/intake-research/not-a-bill-interface.md`.

## Designed, not built

- **Auto-approve fast path in the Flow Builder,** and vendor or category conditions on flow rules. Source: `flow-research/SYNTHESIS-decimal-flows.md`, P2.
- **Advisory AI chip** that tells an approver whether a bill looks routine. Same source, P3.
- **Documentation and memo rules** as a policy type. Source: `policy-research/SYNTHESIS-decimal-policies.md`, P2.
- **Budgets.** Same source, P3.
- **Class and Location pass-through to QuickBooks, bulk coding, and a coding accuracy view.** Source: `gl-coding-research/SYNTHESIS-decimal-gl-coding.md`, P2.
- **Intake actions not yet checked against the code:** retract approval, mark as synced, vendor-level hold. Source: `intake-research/findings.md`.

## Deferred on purpose

Revisit only when a customer needs them: custom roles, department or entity scoping, field masking, GL-account scoping per role. Source: `roles-research/` and `access-research/` synthesis docs.

## Open product question

**How Decimal pays a bill.** See the frozen section of `docs/ARCHITECTURE.md`.

## Known dead weight still in the tree

- Tables `coding_rules` and `accounting_vendor_maps`, with their Prisma models. Nothing reads or writes them.
- API endpoints with no caller: `GET /organizations`, the `/destinations` aliases, the raw `/approvals` submit, read and release routes, `/audit-log`, `/ops-health`.
- `.claude/settings.json` allowlists browser tool names that no longer exist.
