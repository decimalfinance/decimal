# AP Platform Roles & Access Rights — Vic.ai, Airbase, Melio

## 1. Airbase (spend management)

**Source-quality note**: Airbase was acquired by Paylocity; as of July 2026 the legacy help.airbase.com knowledge base dead-redirects and marketing pages redirect to paylocity.com. Findings below lean on third-party writeups (Stitchflow guides, review sites) and search snippets of the old help center — role names/counts are approximate.

### Predefined roles (~6, per secondary sources)
([Stitchflow manual](https://www.stitchflow.com/user-management/airbase/manual), [Stitchflow API guide](https://www.stitchflow.com/user-management/airbase/api))
- **Super Admin** — full platform access: user/role management, budget configuration, SSO/SCIM setup, billing. Only role that can configure SSO/SCIM and billing.
- **Admin** — manages users, budgets, vendors, approval workflows; sees all spend data; cannot touch billing/SSO config.
- **Accountant/Finance** — all transactions, reconciliation, ERP-integration functions; cannot manage users or approval policies.
- **Manager/Budget Owner** — approves spend within assigned budget(s); sees team/department spend; cannot approve outside assigned scope.
- **Employee/Requester** — submits purchase requests/reimbursements; sees only own transaction history.
- **Auditor/Read-Only** — view-only across transactions and reports.

SCIM default: newly provisioned users default to Employee/Requester.

### Permission surface / granularity
- No documented per-permission toggles — access is "role + scope overlay," not a matrix. Flagged as a **limitation**: "some users end up with broader access than their function requires." (Stitchflow)
- Scope layered via: **budget assignment** (manual, post-invite), **department assignment**, **approval workflow designation**.
- A newer "Advanced User Management" tier is marketed as adding "granular permissions by function and entity," but specifics unverifiable (page redirects to Paylocity).

### AP pipeline gating
- **Capture/coding**: Accountant/Finance has GL coding; ML-assisted predictive GL coding "learns from past accountant corrections" (search-snippet, unverified).
- **Approval**: multi-step, by amount threshold, department, vendor category, GL account, combinations; conditional routing ("route to VP Finance if >$25k and vendor is new"). ([workflowautomation.net review](https://workflowautomation.net/reviews/airbase))
- **Payment execution**: ACH/check/wire/virtual card from platform; policy limits auto-block over-threshold transactions.
- **Bank data visibility**: not documented in any accessible source.

### Custom roles
**Not supported** — fixed role model; customization only via budget/department scoping.

---

## 2. Melio (SMB bill pay)

### Predefined roles (six)
Per [The different user roles in Melio](https://help.meliopayments.com/en/articles/3804400-the-different-user-roles-in-melio) and [Melio Roles & Permissions](https://help.melio.com/hc/en-us/articles/5856324646684-Melio-Roles-Permissions):

- **Owner** — one per account; full control; invites Contributors/Accountants/Admins; approves payments.
- **Admin** — same as Owner except cannot modify the Owner's role.
- **Accountant** — schedules payments, adds other Accountants/Contributors, connects accounting software; can be given a payment limit requiring Admin approval; **cannot** approve payments made by Contributors or other Accountants (separation of duties).
- **Contributor** — schedules payments and adds vendors; can be configured to require approval above a set amount.
- **Approver** *(newer)* — reviews/approves or declines specific payments/bills; **cannot create or edit** payments; sees ONLY the bills/payments they're assigned to approve (scoped visibility, not account-wide).
- **Viewer** *(newer)* — read-only: payments, statuses, basic reports.

### Permission surface / granularity
- Role-level, not object-level — framed as coarse "compare roles" in Settings, no matrix. ([Secure payments academy page](https://meliopayments.com/academy/secure-payment-process/))
- Approver is notably **scoped** — designed around "access only to bills and payments they need to approve."
- Accountant/Contributor can carry a **personal payment limit** requiring escalation — a per-user threshold layered on the role.

### AP pipeline gating
- **Bill capture**: Owner/Admin/Accountant/Contributor add vendors and bills; Approver and Viewer cannot create.
- **Approval config**: "Only the owner, admins, and accountants can set up approval workflows" ([workflow article](https://help.melio.com/hc/en-us/articles/12097954053788-Create-and-manage-approval-workflows-for-your-team)); the Approver role executes approvals but doesn't configure policy.
- **Payment execution**: gated by role + personal limits + workflow layer.
- **Bank data visibility**: not explicitly documented per role.

### Approval workflows
- Gated to Core-tier subscriptions and above.
- Triggers: **payment amount** threshold, **payment scheduler** (who initiated), **vendor** identity (e.g., international vendors).
- **Up to 3 approval levels** per workflow, each requiring 1, 2, or 3 approvers.
- Multiple independent workflows can be layered. Batch approve/reject, email/mobile approval.
- Only Owner/Admin can edit/delete workflows.

### Custom roles
Not supported — Melio evolves by **adding new fixed roles over time** (Approver, Viewer were later additions) rather than exposing a role builder. ([Expanded user roles](https://meliopayments.com/academy/team-roles/))

---

## 3. Vic.ai (AI-first AP automation)

Best-documented; Intercom help center largely fetchable.

### Predefined roles — three functional modules
Per [User Roles & Permissions](https://intercom.help/vicai/en/articles/5141557-user-roles-permissions):

**Admin roles**
- **Organization Administrator** — manages user permissions across the org and all subsidiary companies; granting it requires contacting Vic.ai support.
- **Company Administrator** — scoped to one company; manages Autonomous Approval Flows, PO-mismatch processes, configuration, master data.
- **Vendor Manager** — narrowly scoped to the Vendor Management page only.

**Invoice & PO processing roles**
- **Accountant** — full invoice-tab access: upload, edit, initiate approval, post, export, transfer.
- **Invoice Approver** — scoped to the Approval section only; reject/modify/approve invoices.
- **View-only** *(Q2 2025)* — observe invoices/attachments only; for "business stakeholders or auditors." ([Q2 2025 launch](https://www.vic.ai/blog/q2-product-launch-from-automation-to-agentic-ai))
- **PO Mismatch Approver** — reviews line-item mismatches outside tolerance.

**Payment roles**
- **Payment Initiator** — creates payment batches from posted bills.
- **Payment Approver** — reviews/approves payment batches, cannot initiate.

### Permission surface / granularity
- Permissions assignable **per company/subsidiary** independently — different role combos per legal entity for the same user, bulk "Edit Multiple" tooling. ([User Management](https://intercom.help/vicai/en/articles/5257047-user-management-add-edit-remove-users))
- CSV export of all org users + permissions = the practical audit surface.
- **Custom roles supported** — "clone and create a custom role based on the existing Accountant role" language; roles are cloneable/editable templates. ([Bill.com sync article](https://intercom.help/vicai/en/articles/3182013-updating-bill-com-permissions-to-sync-with-vic-ai))

### AP pipeline gating
- **Capture/coding**: the AI does first-pass OCR/classification/GL-coding; the Accountant role reviews/edits/posts rather than coding from scratch.
- **Approval**: "Autonomous Approval Flows" — configured once by an admin; approvers assignable **by individual or by role**; integrates with 50+ HRIS systems to auto-assign routing by role/department/team, self-updating as org structure changes. ([Q3 2024 press release](https://www.globenewswire.com/news-release/2024/08/22/2934103/0/en/Vic-ai-Launches-Dynamic-Role-Based-Approval-Flows-for-Enhanced-AP-Efficiency.html)) "Autopilot" completes approval steps once AI confidence hits a threshold — humans stay in the loop for exceptions. ([Autonomous Approval Flows](https://www.vic.ai/products/autonomous-approval-flows))
- **Payment (VicPay)**: Payment Initiator batches already-approved bills; Payment Approver signs off separately — invoice approval and payment approval are **two separate gates by design**.
- **Bank data**: Vendor Portal (Q2 2025) lets vendors self-serve their own banking details, verified via **Plaid** — bank-detail entry moves outside the internal role system into a vendor-trust flow, reducing internal exposure.

### Approval workflows
- Threshold rules on vendor, amount, GL account, PO mismatch tolerance; "Contains" operator (Q1 2026) for partial-match routing; auto-escalation on stalls; real-time path recalculation when invoice dimensions change. ([Q1 2026 release](https://www.vic.ai/blog/q1-2026-product-release-expanding-autonomy-across-the-ap-lifecycle))

### The AI-first design abstraction (key insight for Decimal)
Vic.ai's human roles are defined **relative to what the AI already did**:
- **Accountant** = reviews/corrects AI output, not a first-pass coder.
- **Invoice Approver** = lighter than Accountant because the AI already normalized/coded the invoice.
- **View-only** = added because automation increased the population of people who only *observe* the pipeline.
- **Autopilot** functions as a fourth, non-human "role" in the approval chain — confidence thresholds gate autonomous action, and permission guardrails decide which steps the AI may autopilot vs which stay human-gated.
- Takeaway for Decimal: as the OCR/GL-coding agent improves, the Accountant-equivalent role shifts from *doing* coding to *reviewing AI coding*; a view-only role becomes necessary; "confidence gates autonomy, permissions decide who/what can be on autopilot" maps directly onto Decimal's agent-with-tools + code-enforced-gate architecture.

---

## Cross-platform summary

| | Airbase | Melio | Vic.ai |
|---|---|---|---|
| # predefined roles | ~6 (weak sourcing post-acquisition) | 6 | 8 across 3 modules |
| Scoping mechanism | Budget + department overlay | Per-bill scoping (Approver), payment limits | Per-company/subsidiary, HRIS-driven |
| Custom roles | No | No (adds fixed roles over time) | Yes — clone-and-edit |
| Approval routing basis | Amount/dept/vendor/GL threshold | Amount/scheduler/vendor, up to 3 levels | Role/dept/team via HRIS + AI confidence autopilot |
| Payment vs. invoice approval | Combined in one policy engine | Combined | Explicitly separate (Invoice Approver vs Payment Approver) |
| AI's role in the permission model | Assistive (suggests GL codes) | None | Structural — AI occupies the coding step; human roles defined relative to AI output |
