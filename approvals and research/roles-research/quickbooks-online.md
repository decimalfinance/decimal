# QuickBooks Online — User Roles & Access Rights: Research Notes

## 1. Predefined roles (QBO Standard tiers: Simple Start/Essentials/Plus)

- **Primary Admin** — one per company; "principal user with access to every area"; only the Primary Admin can edit/remove itself or transfer the role. ([Intuit: User roles and access rights](https://quickbooks.intuit.com/learn-support/en-us/help-article/access-permissions/user-roles-access-rights-quickbooks-online/L66POfRrI_US_en_US))
- **Company Admin** — everything Primary Admin can do **except** edit/remove the Primary Admin. Full data/features, user management, billing, settings.
- **Standard User** with sub-access bands (QBO's built-in coarse RBAC):
  - **All access** — sales + customers + vendors + purchases + account management.
  - **Limited: Customers/Sales only** — invoices/estimates, receive payments, manage customers/products; no vendor side, no chart of accounts, no tax histories.
  - **Limited: Vendors/Purchases only** — enter bills/checks, manage vendors; no sales side.
  - **Limited: both** — union of the two.
  - **None** — no accounting access; own timesheet only.
- **Reports Only** (non-billable seat) — all reports EXCEPT payroll and contact-info reports; no audit log; can build/save custom reports but **cannot drill into underlying transactions**.
- **Time Tracking Only** (non-billable seat) — own timesheet + time reports only.
- **Payments-only (GoPayment)** — accept card payments via mobile app, nothing else.

**Seat economics insight**: Reports-only and Time-tracking-only users don't count against the paid user limit — a deliberate pricing lever encouraging narrow/safe roles instead of everyone getting Company Admin "because it's already paid for."

## 2. QBO Advanced — Custom Roles

### The permission surface (areas)
Converging sources list: **Sales · Expenses · Banking · Payroll/Workers · Reports (subdivided by category) · Inventory · Employees/Time · Accounting (CoA, journal entries, closed-period override) · Account/company management**. ([Intuit: add/manage custom roles](https://quickbooks.intuit.com/learn-support/en-us/help-article/access-permissions/add-manage-custom-roles-quickbooks-online-advanced/L8Ugph7xl_US_en_US), [reedcorp.tax guide](https://reedcorp.tax/qbo-advanced-custom-roles/), [dancingnumbers.com](https://www.dancingnumbers.com/user-roles-access-rights-quickbooks-online/))

### Toggle granularity
Per entity within an area, independent checkboxes: **View / Create / Edit / Delete**, plus **Print / Share / Approve** in some areas. The Intuit page: "what actions they can perform within those features, like view only, create, edit, delete, approve, and all access."

### Scope filters (row-level restriction)
Permissions can be scoped by **Class**, **Location**, and **Customer** — QBO's only row-level dimensions. Explicit limits: no amount-based filters, no field-level masking, no multi-entity roles (each entity = separate company file). ([reedcorp.tax](https://reedcorp.tax/qbo-advanced-custom-roles/))

### Predefined role templates (starting points, all editable)
Standard all access · Standard limited (customers/sales, vendors/purchases) · Reports only · Time tracking only · blank role · plus function-named templates: **Sales Manager, Expense Manager, Project Manager, Payroll Manager, Inventory Manager, Bill Clerk, Bill Approver, Bill Payer** (corroborated via search synthesis of official Intuit pages; not primary-verified).

### Guardrail
Custom roles **cannot be saved with account-management access only** — at least one operational access type must accompany it.

## 3. Accounts payable: how roles gate the bill workflow (the load-bearing finding)

QBO Advanced / Bill Pay Elite split AP into **three separable permission slices**:

1. **Enter the bill** (accrual) — **Bill Clerk**: Create/Edit on Bills + Vendors, View on CoA/Banking. No Pay Bills, no Checks, no Journal Entries. "Can enter a bill but cannot pay one."
2. **Approve the bill** (attestation) — **Bill Approver**: per Intuit, "can only approve bills and can't pay bills or take any other action related to bills or payments." Typically "a manager, department head, or someone who can confirm the service was received" — attests to a business fact, needs zero banking access.
3. **Pay / release funds** (cash) — **Bill Payer**: "can view and pay bills and edit vendor details but can't add bills or perform other bill related actions." In Bill Pay Elite, a distinct second-stage **Payment Release Approval** exists.

**Mechanism of "a manager can't see payments"**: pure allow-list RBAC per (entity × action) node. Bank details and payment execution live under different permission nodes (Expenses > Bill Payments / Banking > Pay Bills) than Bills > Approve. A role granted only Approve on Bills never renders the pay-bills screen or vendor bank fields. It is **feature-surface removal, not field masking** — the screens simply don't exist for that role.

**Bill Pay Elite two-stage split**: "Bill approval and payment release... there's no confusion over who reviews and who authorizes the payment release." Bill approval = confirms goods/services received. Payment release = authorizes money movement — and **only admins can be payment-release approvers** (harder ceiling than bill approval, which any role with the Approve checkbox can hold). ([Intuit: bill approval and payment release workflows](https://quickbooks.intuit.com/learn-support/en-us/help-article/manage-workflows/set-use-bill-approval-payment-release-workflows/L1IOLL9hv_US_en_US), [Insightful Accountant](https://blog.insightfulaccountant.com/intuit-launches-payment-release-approvals-for-quickbooks-bill-pay))

**Vendor banking data**: changing vendor bank info requires Primary/Company Admin; once entered, bank info **cannot be re-displayed** even by admins (write-once, no read-back). ([Intuit Community threads](https://quickbooks.intuit.com/learn-support/en-us/reports-and-accounting/how-do-i-change-a-vendors-s-bank-account-information-for-bill/00/818286))

**SoD as the sales pitch**: "In QBO Plus that is unavoidable [one person doing all three]. In QBO Advanced, splitting them takes about ten minutes." ([reedcorp.tax](https://reedcorp.tax/qbo-advanced-custom-roles/))

**Payroll is binary**: full payroll access or none — no partial slicing.

## 4. Roles × the Workflows (approval) feature

- Requires **Bill Pay Elite or QBO Advanced**. ([Ramp on QBO workflows](https://ramp.com/blog/quickbooks-approval-workflow))
- **Approvers assigned two ways**: (a) a specific named individual, or (b) **role-based** — any user holding a role with the Approve checkbox on Bills is eligible. ([Insightful Accountant: optional approvers](https://insightfulaccountant.com/accounting-tech/general-ledger/optional-approvers-for-bill-workflows-in-qbo-advanced/))
- **An approver does NOT need payment permission — by design.** The approval act is decoupled from the payment act at the permission-model level.
- **Payment release is stricter**: admin-only, a hard-coded ceiling above the role system.
- **Triggers**: amount thresholds, vendor, location/class, stacked combinations; multi-step chains (amount-tiered approver counts).
- **Auto-approval trap**: if the bill's creator is also the assigned approver, QBO **auto-approves with no human review** — an SoD hole to close by configuration.
- **Dead-man's switch**: unactioned approvals auto-deny after **30 days**.
- Pending bills surface in a dashboard Task widget; email + in-app + mobile approval.

## 5. Design abstractions worth stealing

1. **Three-tier grammar**: Area → Entity → Action (View/Create/Edit/Delete/Approve). Small learnable grammar expressing combinatorially many roles without showing a giant matrix.
2. **Templates as defaults, not walls**: every predefined role is "start here and edit," never locked.
3. **SoD as three named roles** — Bill Clerk (enter/accrual) / Bill Approver (attest) / Bill Payer (cash) — expressed as role templates, not a bespoke workflow build. The single most reusable idea.
4. **Graduated trust ceiling**: wide circle can attest (any Approve-checkbox role), narrow circle can release funds (admins only).
5. **Non-billable narrow roles as adoption lever** — free Reports-only/Time-only seats drive voluntary least-privilege instead of everyone becoming admin.
6. **Plain-English permission summary** — QBO renders the checkbox matrix back as sentences ("Can create invoices. Cannot delete invoices.") used by accountants as literal audit documentation. Cheap, high-value UX.
7. **Explicit named limitations** — no field masking, row filters only by class/location/customer, no multi-entity. Saying what the model can't do builds credibility.

## Sourcing caveat

Intuit's learn-support pages timed out on direct fetch; claims attributed to them are reconstructed from search-result synthesis of those exact pages (high-confidence but secondhand). reedcorp.tax is CPA-firm commentary — great for design patterns, less reliable as a literal feature inventory. Ramp/Insightful Accountant/dancingnumbers cross-corroborate the core facts (role names, enter/approve/pay split, admin-only payment release, 30-day auto-deny).
