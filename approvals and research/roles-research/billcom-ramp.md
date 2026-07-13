# Bill.com (BILL) — User Roles & Access Rights

## 1. Predefined roles

BILL ships with **six predefined roles**: Administrator, Accountant, Clerk, Approver, Payer, Auditor. (https://help.bill.com/direct/s/article/360000024183, https://developer.bill.com/docs/organizations-users, https://developersupport.bill.com/hc/en-us/articles/213911186-User-Role-Profile)

- **Administrator** — Full org access: user management, settings, approvals, accounting-sync config, banking. Has signing authority on the bank account (can authorize bill payments). At least one active Administrator must exist on the account at all times. (https://help.bill.com/direct/s/article/360000024183, https://www.bill.com/product/accounts-payable-controls)
- **Accountant** — Manages the payables process (enters bills, syncs to the accounting system) but **cannot pay bills**, cannot manage users, and cannot view/manage banking information. Commonly assigned to external bookkeepers/accounting firms. (https://help.bill.com/direct/s/article/360000024183, https://www.mindspaceoutsourcing.com/how-to-provide-bill-com-access-to-your-accountant/)
- **Clerk** — Narrowest data-entry role: permission only to enter (and edit) bills/invoices. No approval, no payment, no settings/user access. (https://help.bill.com/direct/s/article/360000024183)
- **Approver** — Reviews bills and vendor credits before they're authorized for payment; can approve/deny with notes, individually or in bulk. Per-user **dollar thresholds** are configurable by an Administrator. Approvers participate without ever seeing bank account details or accounting-system functions — this is BILL's explicit separation-of-duties design. (https://help.bill.com/direct/s/article/360000024183, https://www.bill.com/accountant-resource-center/articles/ap-setup-reference-guide-the-approver-role)
- **Payer** — Only pays bills; cannot enter or approve bills, cannot manage users/settings. Can only pay up to the already-approved bill amount, enforcing separation between approval and execution. (https://help.bill.com/direct/s/article/360000024183)
- **Auditor** — View-only role: can see all account and transaction information (including payment history/reports) but cannot edit, approve, or execute anything. Still counts as a billable user. (help.bill.com/direct/s/article/360000024183 and /115005904243)

Note: one third-party guide (Stitchflow) also lists a "Controller" role (AP/AR + chart of accounts + sync, no user mgmt) — this doesn't appear in BILL's own docs/API role list, so it's likely an account-type-specific or legacy label rather than a current standard role; treat the six above (Administrator/Accountant/Clerk/Approver/Payer/Auditor) as canonical. (https://www.stitchflow.com/user-management/bill.com/manual vs https://developer.bill.com/docs/organizations-users)

## 2. Permission surface / granularity

Access is controlled via a `roleId` assigned per user at the org level (API: `Organizations & Users`, `User Role Profile`, `List user role profiles`). (https://developer.bill.com/docs/organizations-users, https://developer.bill.com/v2/reference/org-basic-listprofile)

Gated areas/objects:
- Bills & vendor credits (enter, edit, approve, view)
- Vendors (create/manage)
- Payments (schedule, execute)
- Banking / funding accounts (view, manage — restricted to Administrator by default)
- Accounting sync (Accountant, Administrator)
- Reports (broad visibility for Administrator/Auditor; narrower for others)
- User management (Administrator only, or custom role with "manage users"/"manage roles" permission)
- Risk/KYC verification initiation (Administrator)
(https://developer.bill.com/docs/organizations-users, https://help.bill.com/direct/s/article/360000024183)

Granularity for the six fixed roles is coarse — each is a bundled set of capabilities, not independently toggleable, apart from the Approver's per-user dollar threshold. **Custom roles** (see #5) add fine-grained, per-checkbox control: "access to several items or workflow process in the BILL system, in any combination, can be enabled or prohibited for that role." (https://www.bill.com/product/accounts-payable-controls)

BILL also layers a **Dual Control** feature on top of roles for sensitive actions — one user initiates, a second (different) user must approve — independent of the base role model. (https://www.bill.com/product/accounts-payable-controls)

## 3. How roles gate the AP pipeline

- **Enter/review bill details**: Clerk and Accountant (and Administrator) enter bills; Approver reviews (views invoice number, vendor, due date, amount, line items, approval history) but does not enter/edit.
- **Approve**: Approver (and Administrator/Accountant, per API docs, if role permits) — approves/denies up to configured threshold; sees no bank/payment details.
- **Execute/release payment**: Payer (and Administrator) only; Payer capped at the already-approved amount, cannot alter it.
- **See bank details / payment history**: Administrator (full), Auditor (view-only, full visibility including payment history/reports); Accountant, Clerk, Approver, Payer are explicitly walled off from banking information — this is BILL's headline separation-of-duties pitch ("participate in Payables... without having to provide them access to your bank account"). (https://help.bill.com/direct/s/article/360000024183, https://www.bill.com/product/accounts-payable-controls)

So: **Approver ≠ Clerk ≠ Payer** — Clerk only writes bill data, Approver only reads bill data + makes an approve/deny decision within a $ limit, Payer only executes payment on already-approved amounts. None of the three alone can both create and pay a bill.

## 4. Approval workflows/policies and roles

- Approval chains can be built from **individual users, "approver groups" (a set of users where any one approval satisfies the step), or a combination of both** — not purely role-based, but role membership (Administrator/Accountant/Approver) gates who is even eligible to be placed in an approval chain. (developer.bill.com/docs/ap-bill-approvals, help.bill.com/direct/s/article/360000017963)
- **Enhanced approval policies** route bills automatically by criteria: vendor, location, department, GL account, and amount thresholds, and assign specific approvers/approver-groups per rule. (https://www.bill.com/product/accounts-payable-controls)
- Only Administrators (or a custom role with "edit company preferences"/"manage roles" permission) can create/edit approval policies. (help.bill.com/direct/s/article/360000017963)
- Policy changes are **forward-only** — they don't retroactively apply to existing bills/credits. (https://www.bill.com/product/accounts-payable-controls)
- Users with Administrator, Accountant, or Approver roles are the ones permitted to perform bill-approval operations at all (per API docs), i.e., role is a prerequisite filter before someone can be wired into a chain.

## 5. Custom roles

Yes — supported, **plan-gated** ("Custom roles may also be available for more granular permissions settings, depending on the account's price plan"). (https://help.bill.com/direct/s/article/360000024103)
- Created by an Administrator, or by a user with a custom role that itself has "manage roles" permission.
- Grants/denies access to individual workflow items/processes "in any combination" — i.e., a permission-matrix model layered on top of (not replacing) the six base roles.
- The base six roles themselves are not user-editable — customization happens by defining wholly new custom roles.

## 6. Design abstractions worth stealing

- **Role = a station in the pipeline**, named after the job function, not a generic access tier: Clerk (data entry) → Approver (judgment/gate) → Payer (execution). This maps 1:1 to the "enter → approve → pay" AP pipeline, so the mental model is self-explanatory even to non-technical users.
- **Hard wall between decision-making and money movement**: Approver never sees banking info; Payer never sees/edits the bill amount; this is marketed explicitly as the reason customers don't need to grant AP staff "access to your bank account or accounting system functions."
- **Read-only role for oversight** (Auditor) is a first-class citizen, not an afterthought — useful for external auditors/investors who need full visibility with zero write risk.
- **Approver dollar threshold as a per-user attribute**, not a separate policy object — keeps the common case (route by amount) simple while still allowing full policy engine for edge cases.
- **"At least one Administrator always active"** invariant prevents lockout — a good guardrail to copy.

---

# Ramp — User Roles & Access Rights

## 1. Predefined roles

Ramp's model is **two-layer**: a single **base role** (exactly one) plus optional **add-on roles** (stackable, additive). (https://support.ramp.com/hc/en-us/articles/360042579734-User-roles-overview)

Base roles:
- **Admin / Owner** — Super-user; full, non-customizable access to all of Ramp: issue spend, manage users, company controls, integrations, accounting. Owner is the top-level variant.
- **Employee** — Standard team member; minimal, mostly non-customizable permissions: use own cards/funds, request spend, submit receipts/reimbursements. No company-data or settings access.
- **Accounting** ("Bookkeeper") — Access to company Ramp activity data for bookkeeping: integrate accounting software, code transactions, sync data, view financial statements. Cannot issue spend, pay, or manage users. Intended for accountants/BPO partners/controllers.
- **IT Admin** — Manages integrations, provisioning, account security; edits People/Company Settings/Developer API/integration config. Cannot view expenses, access Bill Pay, or manage accounting integrations by default.
- **View-Only Admin** (Ramp Plus only) — Read-only access to all company data/transactions/users/settings; cannot edit, issue, or request anything.
- **Guest** (Ramp Plus only) — Temporary workers/contractors; virtual cards + reimbursement requests only.

Add-on roles (layered on top of a base role):
- **Manager** (compatible with Employee, Accounting, IT Admin, Owner, Admin) — Oversees own team's spend: invite team members, request spend for direct reports, view team transactions/alerts. Cannot issue spend directly or view full card numbers.
- **Finance Admin** (compatible with Accounting base role only) — "Manage all of the company's financial products, expenses, bills, vendors, and treasury accounts": full visibility/edit across expenses, Spend Programs, Bill Pay, vendors, treasury/Ramp Banking, connects/configures accounting integrations, configures approval workflows. Cannot edit user management (read-only view of users), cannot invite/deactivate/delete users or assign roles, cannot restructure departments/locations. (https://support.ramp.com/hc/en-us/articles/44831157299987-User-role-deep-dive-Finance-Admin)
- **Accounts Payable** (compatible with Employee, Accounting, Admin, Owner) — "Grants access to Bill Pay": default = draft-bill CRUD, view submitted/recurring bills, edit vendor details, view vendor intelligence. Customizable add-ons: submit bills to kick off approval workflow, edit/archive submitted bills & payments, view payment details (scheduling, method, bank account info), sync bills to ERP, edit Bill Pay settings, adjust approval-chain routing. Multi-entity scoping is supported (Ramp Plus/beta). (https://support.ramp.com/hc/en-us/articles/4413380025363-Accounts-Payable-Role-on-Ramp)
- **Assistant** (any role) — Acts on behalf of assigned users (submit expenses, book travel) but cannot see data for unassigned users.
- **Custom Roles** (Ramp Plus only; compatible base: Employee, Accounting, IT Admin) — Freely defined permission sets.

**Permission model is additive**: if any assigned role (base or add-on) grants a permission, the user has it. Admin/Owner cannot take add-on roles (already superset). Guest can only add View-Only Admin. (https://support.ramp.com/hc/en-us/articles/360042579734-User-roles-overview)

## 2. Permission surface / granularity

Ramp documents **nine+ product areas** with per-permission toggles marked Customizable (C) or Implied (I): Expenses, Accounting, User Management, Vendors, Request Funds, Bill Pay, Travel, Ramp Banking/Banking, Approvals, Rewards. (https://support.ramp.com/hc/en-us/articles/36992823234323-Customizing-Roles-and-Permissions)

Notable granularity/bundling rules:
- Vendor **create** and **delete** are bundled — can't grant one without the other.
- Entity-level (multi-entity) restriction is only available for Finance Admin, Accounting, and Accounts Payable roles; Admin/Owner always retain cross-entity access.
- Bill Pay itself decomposes into fine-grained toggles: view/create/edit draft bills, submit (kicks off approval), edit/archive submitted bills+payments, view payment details (scheduling/method/bank info), sync to ERP, edit Bill Pay settings, edit approval routing. (https://support.ramp.com/hc/en-us/articles/4413380025363-Accounts-Payable-Role-on-Ramp)

## 3. How roles gate the AP pipeline

- **Enter/review bill details**: Accounts Payable role (default: create/edit drafts, view submitted bills); vendor owners get default view-only access to bills tied to their vendor.
- **Approve**: Approvers (assigned in the workflow builder, by role/group or specific person) see "invoice, line items, and approval history" but by default **cannot see payment info** (bill total amount editability, payment details, vendor can be locked from their edit view; admins can loosen this in Bill Pay Settings > Permissions). (https://support.ramp.com/hc/en-us/articles/42995022042515-Employee-Roles-and-Permissions-on-Bill-Pay)
- **Execute/release payment**: Separate "Payer" designation — **only Admin or Accounts Payable role** can be made a Payer. This is a distinct, later step from approval: "clear separation of duties between the person approving bills and the person authorizing payments." Multiple payers can be configured but Ramp does **not** support sequential/layered payer approval — any one designated payer can release independently. Applies to ACH/check/wire/international; card payments are excluded by default unless a separate toggle is enabled. (https://support.ramp.com/hc/en-us/articles/34648566601235-Bill-Pay-payment-release)
- **See bank details / payment history**: Finance Admin (bank/treasury accounts), Accounts Payable (if granted the "view payment details" customizable permission), Admin/Owner (full). Standard Approvers and Employees are excluded by default.

So: Approver sees bill content + approval history only; Accounts Payable/Clerk-equivalent creates/edits bill drafts and vendor data (and optionally payment metadata if granted); Payer (Admin or AP role specifically flagged as payer) is the only one who can release funds — mirroring BILL's Clerk/Approver/Payer separation but implemented as toggleable permissions on the AP role plus a separate "Payer" flag, rather than three hard-coded distinct roles.

## 4. Approval workflows/policies and roles

- Ramp has a **visual workflow builder** (Bill Pay Settings > Approvals) supporting nested/layered **conditions** (route by bill fields like vendor, amount, department, GL account, entity), **approvers** (assignable as predetermined roles/groups **or specific individuals** — both supported, admin's choice), and **outcomes** (notify a role/individual, or terminal "approve bill" action). (https://support.ramp.com/hc/en-us/articles/4417843897747-Bill-Pay-approvals, community.ramp.com/t/separate-approval-payment-roles-in-approval-workflow)
- Multi-approver steps can require **all** or **any** approvals.
- Admin self-approval is itself policy-controlled — a toggle determines whether an Admin's own spend/bills route to their manager instead of auto-approving.
- A live community feature request ("Separate Approval & Payment Roles in Approval Workflow," community.ramp.com/t/805) indicates users want tighter, more explicit role-based gating between approval and payment steps than currently exists — signal that Ramp's approval/payment separation, while present, is less rigid/structural than BILL's fixed Approver/Payer role split.
- Visibility gap handling: not explicitly documented what happens if an assigned approver lacks visibility into a bill (e.g., wrong entity scope); the multi-entity restriction feature suggests this is handled by scoping rather than a runtime fallback, but no direct citation confirms behavior.

## 5. Custom roles

Yes — **Ramp Plus only**, Admin/Owner required to configure. (https://support.ramp.com/hc/en-us/articles/36992823234323-Customizing-Roles-and-Permissions)
- Base roles Accounting, Manager, Finance Admin, and IT Admin are directly customizable (edits apply to every user holding that role).
- Additionally, fully separate **Custom Roles** can be created (compatible with Employee/Accounting/IT Admin bases) when different permission sets are needed for users who'd otherwise share a base role.
- Admin, Owner, Guest, and Employee "implied" permissions are not customizable.

## 6. Design abstractions worth stealing

- **Base role + add-on role composition** is a genuinely different (more scalable) abstraction than BILL's flat six: it separates "what kind of person are you" (Employee/Accounting/IT Admin/Admin) from "what job do you do in a specific pipeline" (Manager, Finance Admin, Accounts Payable, Assistant). This avoids role-explosion (no need for "Accountant-who-also-approves-travel" as a distinct role — just stack Accounting + Manager).
- **Additive-permission union** is simple to reason about (no priority/conflict rules needed) and safe by default (nothing subtracts).
- **AP role and Payer are decoupled**: "Accounts Payable" describes the bill-handling job; "Payer" is an orthogonal flag layered on top (only Admin/AP-role users are eligible to be flagged as Payer). This is a cleaner primitive than BILL's dedicated Payer *role* — it lets one person be AP-drafter-only, AP-drafter+payer, or Admin+payer without needing a fourth role.
- **Approval workflow builder treats "approver" as either a role/group or a named person** in the same UI primitive — good for letting policies survive personnel turnover (assign "Finance Admin" rather than "Jane Doe") while still allowing precision overrides.
- **Permission matrix documented as Customizable vs Implied (C/I)** per product area is a clean way to communicate to admins what's a true toggle vs a role-defining core behavior — worth stealing verbatim for a permissions settings UI.
- Ramp explicitly flags **bundled permissions** (vendor create+delete) rather than pretending everything is independently toggleable — an honest simplification that prevents a combinatorial permission-matrix UI nightmare.

---

## Side-by-side summary

| Dimension | BILL | Ramp |
|---|---|---|
| Role model | 6 flat predefined roles + optional custom roles | 1 base role + stackable add-on roles + optional custom roles |
| AP pipeline roles | Clerk (enter) → Approver (approve) → Payer (execute) → Administrator/Auditor (oversight) | Accounts Payable (enter/edit, optionally payment-view) → Approver (assigned in workflow, role or person) → Payer flag (Admin or AP role only) → Finance Admin/Admin (oversight+banking) |
| Approval chain built from | Individual users and/or "approver groups"; role determines eligibility to be an approver | Roles/groups or specific individuals, mixed freely in a visual workflow builder |
| Bank/payment visibility default | Walled off from Clerk/Approver/Accountant/Payer by default; only Administrator + Auditor see it | Walled off from Employee/Approver by default; visible to Finance Admin always, to Accounts Payable only if granted as a customizable permission |
| Custom roles | Plan-gated, permission-matrix on top of the fixed 6 | Ramp Plus only, customize 4 base roles or build fresh Custom Roles |
| Distinguishing idea | Rigid job-titled roles = instantly legible mental model | Composable base+add-on roles = scalable without role explosion |
