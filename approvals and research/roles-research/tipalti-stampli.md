# Research Notes: User Roles & Access Rights — Tipalti vs Stampli

Note on source reliability: help.tipalti.com and help.stampli.com block direct fetching (403), so most detail below comes from Google-indexed snippets of those pages (via WebSearch) plus vendor marketing/blog pages and third-party pages that were fetchable directly. One source (Stitchflow's "Tipalti manual") is a third-party auto-generated integration guide, not an official Tipalti doc — claims drawn from it are flagged as lower-confidence.

---

## TIPALTI

### 1. Predefined/system roles

Tipalti's official help center describes a **fixed, predefined role structure**, not free-form permission toggling. Roles found across sources:

- **Administrator** — full access to all payer-portal features: user management, payment configuration, approval workflows, reporting, integrations. Only Administrators can add or deactivate other users; **no delegated/sub-admin capability exists** — a single point of failure noted as a complaint in reviews. [Stitchflow guide](https://www.stitchflow.com/user-management/tipalti/manual) (third-party, moderate confidence); reviews corroborate the "no delegated admin" limitation via [G2 reviews](https://www.g2.com/products/tipalti/reviews).
- **Controller** — financial reporting, payment runs, reconciliation, payment-approval authority based on workflow config; cannot manage users or system settings. [Stitchflow guide](https://www.stitchflow.com/user-management/tipalti/manual)
- **AP Manager** — manages invoices/bills and payment approvals within configured workflows; restricted from user management/system config. [Stitchflow guide](https://www.stitchflow.com/user-management/tipalti/manual)
- **AP Clerk** — enters/submits invoices and bills for approval, read-only on payment status; cannot approve, manage users, or see reporting. [Stitchflow guide](https://www.stitchflow.com/user-management/tipalti/manual)
- **Viewer/Read-Only** — read-only access to specified portal sections as configured by an Administrator; cannot create/edit/approve. [Stitchflow guide](https://www.stitchflow.com/user-management/tipalti/manual)
- **Finance Manager** — required for account-billing management ("Manage account Billing" permission) and for editing email templates/variables. [Account billing](https://help.tipalti.com/hc/en-us/articles/36657370598167-Account-billing), [Templates and variables](https://help.tipalti.com/hc/en-us/articles/30718182970775-Templates-and-variables)
- **Bill Approver** — a discrete permission (not necessarily a whole "role") granted by an admin, giving the ability to: approve bills (last approver → status "Pending payment"), update GL coding on the bill, add comments, "Send Back to AP" (with reason), dispute bills (with reason emailed to payee). Can have a **per-approver approval limit** set as a max bill amount in the invoice's currency. Bill approvers receive requests via email from `bill.approvals@tipalti.com` and can approve by email. [How to approve bills via email](https://help.tipalti.com/hc/en-us/articles/29308594793879-How-to-approve-bills-via-email-3-minute-read)
- **Payee Reviewer** — reviews/approves/declines payee-submitted changes to their own account info (via Payees > "Payees Pending Review"); can also request further changes from the payee before approving. [Payee information FAQs](https://help.tipalti.com/hc/en-us/articles/30607242003223-Payee-information-FAQs)
- **View Secure Details** — required to see sensitive payee information (bank account numbers, tax IDs, etc.); without it, sensitive fields are masked with asterisks. [Payee information FAQs](https://help.tipalti.com/hc/en-us/articles/30607242003223-Payee-information-FAQs)
- **Manage Integrations** — required to set up/administer ERP integrations (e.g., NetSuite). [Required user roles for NetSuite](https://help.tipalti.com/hc/en-us/articles/31560903872919-Required-user-roles)

Note: Tipalti also has a separate **"Payer"** concept — in payment-batch approval, "the payer has to approve it, unless you have a no-approval workflow, with the CFO or Controller configured as a named payment approver." This is a workflow-stage gate (approving the payment batch after invoice approval), not necessarily a distinct persona from Controller/Admin. [Internal controls guide](https://tipalti.com/resources/learn/internal-controls-for-accounts-payable/)

### 2. Permission surface / granularity

- Tipalti's marketing/product pages consistently describe **"20+ role-based permission options"** covering **view, create, add, edit, and control** actions, applied per role by system administrators. [Financial Compliance page](https://tipalti.com/product/platform/financial-controls/)
- Despite the "20+ options" framing, **the standard UI does not expose granular per-permission toggling** — role assignment is described (via third-party sources) as **all-or-nothing bundles**; **custom roles beyond the ~5 built-ins historically required engaging Tipalti support**, i.e., not self-service. [Stitchflow guide](https://www.stitchflow.com/user-management/tipalti/manual); consistent with G2 review commentary.
- **However**, a 2026 product update loosens this: Tipalti shipped a **"Multi-Entity Team Management Hub"** (Q1 2026) that lets admins **"assign predefined or custom roles across both Accounts Payable and Mass Payments"** from a centralized hub, explicitly supporting custom role creation, with audit trails of "who has access to what." [Tipalti Q1 2026 update blog](https://tipalti.com/blog/whats-new-tipalti-q1-2026/)
- Permission objects/areas referenced across sources: user management, payment configuration/workflow, approval-flow creation, reporting, integrations, payee records (with a "secure details" sub-permission for bank/tax data), bills/invoices, account billing, funding/account management, disbursement initiation.

### 3. How roles gate the AP pipeline / separation of duties

- Tipalti explicitly markets **segregation-of-duties (SoD) enforcement** as a core financial-controls feature: "more than 20 distinct role-based permissions" enforce strict SoD; "signatory controls, approval workflows, and audit logs" reinforce it. [Financial Compliance page](https://tipalti.com/product/platform/financial-controls/)
- Documented SoD pattern: **invoice preparer (AP Clerk) → approver (Bill Approver / AP Manager) → payment-batch approver (Controller/CFO as named "payer" approval) → Tipalti executes the actual disbursement.** The payment-batch approval is "a genuine second authorization gate" distinct from invoice-level approval. [Internal controls guide](https://tipalti.com/resources/learn/internal-controls-for-accounts-payable/)
- Guiding principle quoted from Tipalti's own content: "The person who prepares the check should always be separate from the one that signs it," and "No one person should ever wholly take responsibility for any process." [Internal controls guide](https://tipalti.com/resources/learn/internal-controls-for-accounts-payable/)
- **Bank/payment data visibility** is explicitly gated: only users with the **View Secure Details** permission can see unmasked payee bank/tax information; others see masked (asterisked) fields. [Payee information FAQs](https://help.tipalti.com/hc/en-us/articles/30607242003223-Payee-information-FAQs)
- **Fund initiation/account billing** requires Finance Manager role or an equivalent custom-permission grant ("Manage account Billing"), separate from bill approval. [Account billing](https://help.tipalti.com/hc/en-us/articles/36657370598167-Account-billing)

### 4. Approval workflows: role/person/amount/entity routing

- Amount-based: **per-approver approval limits** can be set as a max bill amount (in invoice currency) when adding an approver. [How to approve bills via email](https://help.tipalti.com/hc/en-us/articles/29308594793879-How-to-approve-bills-via-email-3-minute-read)
- Multi-level approvals configurable by transaction size, vendor category/type, and department. [Ramp comparison of platforms](https://ramp.com/blog/accounts-payable/invoice-approval-workflows-platforms-compared) (third-party, moderate confidence)
- **AI-assisted routing** exists: approval routing "uses AI to predict approvers and route invoices automatically based on how you've handled similar invoices before," factoring amount, department, vendor type. (moderate confidence)
- **Entity/department scoping**: multi-entity customers can restrict users to specific legal entities — "users can only view and process invoices for the entities they manage." [Multi-Entity platform page](https://tipalti.com/product/platform/multi-entity/)
- Payment batch requires a named payer/Controller/CFO approval as final gate unless "no-approval workflow" is configured. [Internal controls guide](https://tipalti.com/resources/learn/internal-controls-for-accounts-payable/)

### 5. Custom roles / customization

- Historically: **no self-service granular permission editing**; custom configurations required Tipalti support engagement. [Stitchflow guide](https://www.stitchflow.com/user-management/tipalti/manual)
- As of the **Q1 2026 "Team Management" hub**, Tipalti now advertises native **custom role creation** alongside predefined roles, applied consistently across the AP and Mass Payments modules, from one central admin surface. [Tipalti Q1 2026 blog](https://tipalti.com/blog/whats-new-tipalti-q1-2026/)
- No evidence found of per-object field-level permission editing (e.g., restricting which GL accounts a role can code to).

### 6. Design abstractions

- **Naming convention**: role names map to real finance job titles (Administrator, Controller, AP Manager, AP Clerk, Finance Manager) rather than abstract permission bundles — lowers cognitive load for finance buyers.
- **Discrete named permissions layered on roles** (View Secure Details, Manage Integrations, Bill Approver, Payee Reviewer) act as **add-on capabilities** rather than forcing a role change — a hybrid of RBAC + capability grants.
- **Masking as default-safe UX**: sensitive fields are masked by default and only unmasked by an explicit permission — keeps records "visible but redacted," useful for audit context without leaking PII.
- **Multi-entity + team-management hub** centralizes what could otherwise be N separate admin panels.
- **Explicit second gate at payment-batch stage** (distinct from invoice approval) is a clean way to guarantee preparer/approver/payer separation — the *stage* itself enforces the split.

---

## STAMPLI

### 1. Predefined/system roles

Stampli's roles cluster around the invoice lifecycle and card/procurement modules rather than IT-style admin tiers:

- **AP Processor** — the most powerful AP role: manage invoices, authorize approved invoices for payment, edit invoice fields, **revise/reassign approvers**, cancel invoices, plus other advanced capabilities assignable per org. (moderate confidence, aggregated from Stampli marketing content)
- **Approver** — has a personal **inbox** showing invoices currently awaiting action plus history of past approvals; reviews and approves/rejects per workflow rules; gets **mobile approval** access and **automatic reminders**. [AP automation platform page](https://www.stampli.com/ap-automation-platform/)
- **Requester** (implicit role, more explicit in the procurement module) — initiates purchase requests; if a request/bill is rejected, the requester is notified and can resubmit. [Procurement pre-defined workflows page](https://www.stampli.com/pre-defined-approval-workflows/)
- **Vendors** — external role with access to a **vendor portal** for invoice submission and two-way communication with AP, without visibility into internal AP operations. [AP automation platform page](https://www.stampli.com/ap-automation-platform/)
- **Finance leadership (Controller/CFO)** — dashboard/reporting access, exception oversight, full audit-trail visibility. (moderate confidence)
- **Card-specific roles** (Stampli Card module): **Card Manager** (approves card requests/limit increases, reviews all cardholder expenses) and **Cardholder** (requests limits/cards, uploads receipts, submits expenses). [Stampli Card page](https://www.stampli.com/card/)

### 2. Permission surface / granularity

- Marketing copy: Stampli grants **"access to select data, features, and objects based on users, user roles, and groups"** with **"granular role-based access controls"** enforcing SoD so "no single individual has conflicting permissions."
- Objects/areas referenced: invoices/bills, purchase requests, vendor records/vendor portal, cards/card transactions, GL coding fields, approval workflows, comments/Q&A threads, documents/attachments, dashboards, audit trail/activity log.
- **Documented gap**: reviewers report Stampli **cannot restrict which GL accounts a given user can code to** — "users have access to accounts they should not use." [G2 reviews](https://www.g2.com/products/stampli/reviews?qs=pros-and-cons)
- **Trays** organize work by **business unit, region, department** — a scoping mechanism that functions similarly to Tipalti's entity scoping. [AP automation platform page](https://www.stampli.com/ap-automation-platform/)

### 3. How roles gate the AP pipeline / separation of duties

- Stampli positions itself as an **"AP layer" on top of the ERP**, framing SoD in terms of AP-cycle functions that must be segregated: **vendor maintenance, invoice entry, approval, payment, reconciliation**. Guidance: "Map the AP functions... to ERP roles so no user holds a conflicting combination, then test actual permissions against your SoD matrix." [ERP approval controls / AP layer resource](https://www.stampli.com/resources/erp-approval-controls-ap-layer/)
- Key architectural claim: **approval evidence lives in Stampli** (the AP layer), while **only the posted transaction goes to the ERP** — Stampli, not the ERP, is the system of record for who-approved-what. [Same source]
- **Payment execution**: AP Processors "authorize approved invoices for payment" — payment execution rights are bundled into the top AP role rather than split into a separate "Payer" persona. No distinct "who sees bank/payment data" permission was found documented (unlike Tipalti's "View Secure Details") — likely a documentation gap rather than confirmed absence.
- Audit trail as SoD enforcement: "every action... captured in a complete, immutable audit trail on the invoice record, with separation of duties enforced by design." [Invoice audit trails](https://www.stampli.com/invoice-audit-trails/), [Immutable audit trail resource](https://www.stampli.com/resources/immutable-audit-trail/)
- Recommended visibility tiering: "AP staff [get] operational audit information, managers [get] broader visibility for exception resolution, administrators [maintain] full audit trail access." [Audit readiness resource](https://www.stampli.com/resources/audit-readiness-compliance-moments/)

### 4. Approval workflows: role/person/amount/department + Billy the Bot

- Two workflow modes:
  - **Predefined/static** — visual **approval workflow builder**; can be **"fully locked"** (fixed approvers per scenario) or **"partially flexible"** (certain roles can add/remove approvers at specific stages). [Pre-defined approval workflows page](https://www.stampli.com/pre-defined-approval-workflows/)
  - **Dynamic** — **machine learning auto-suggests approvers** per invoice, based on prior handling of similar invoices.
- Routing dimensions: **amount/spending thresholds, department/cost center, vendor, location, request type, custom field values, requester's org-hierarchy manager** (auto-set as first approver via uploaded org chart, override allowed). [Pre-defined approval workflows page]
- **Fallback approvers**: if no primary approver matches criteria, requests auto-route to a designated fallback user. [Same source]
- **Approval limits / DOA**: "amount-based routing that adds approvers as thresholds are crossed, authority limits that block an invoice from completing approval unless someone with sufficient authority has signed, and role-based permissions that prevent unauthorized users from approving at all." [DOA matrix resource](https://www.stampli.com/resources/delegation-of-authority-matrix-ap/)
- **Line-item level approval**: reviewers can approve/reject individual line items. [Pre-defined approval workflows page]
- **Billy the Bot**: learns approval policy from invoice history and suggests the right approver; also does capture, auto-GL-coding, duplicate detection, PO variance flags. STP rate 70–80% after 90 days (moderate confidence). Explicitly **assistive, not authoritative**: "Billy replaces repetitive work... not roles"; "all of the data that Billy was populating were simply suggestions that could be overridden" — final decision authority always remains with the human role. [Meet Billy blog](https://www.stampli.com/blog/inside-stampli/meet-billy-stamplis-accounts-payable-ai/), [AI invoice processing guide](https://www.stampli.com/blog/invoice-processing/ai-invoice-processing/)

### 5. Custom roles / permissions

- No formal "custom role builder" documented. What is customizable: approval workflow structure (levels, locked vs flexible, fallback, amount/dept/vendor conditions); approval limits per user or globally; Trays scoping.
- Stampli's permission model is **coarser and workflow-centric**: you customize *what happens to an invoice* extensively, but *who can technically touch what field* less so.

### 6. Design abstractions worth stealing

- **Role names mirror the document journey** (Requester → Approver → AP Processor) rather than abstract admin tiers — the mental model maps onto "who does what to this invoice."
- **Personal inbox/queue per approver** plus **automatic reminders** — reduces "who's supposed to act" ambiguity.
- **Fully-locked vs. partially-flexible workflow modes** — a clean two-knob rigidity control.
- **AI-suggested routing that must be confirmed by a human role** (Billy): automation proposes, a permissioned human disposes — keeps the audit/SoD story intact as automation increases.
- **System-of-record framing**: approval evidence lives in the AP layer; the ERP just gets the posted transaction — clarifies where "who approved this" lives when Decimal sits in front of QuickBooks.
- **Tray-based scoping** — lighter-weight than full multi-entity, useful for department/team-level routing.
- Weakness to avoid: no field-level restriction (GL account scoping per role) — a differentiation opportunity for Decimal.

---

## Summary comparison

| Dimension | Tipalti | Stampli |
|---|---|---|
| Role model | Fixed job-title roles (Admin/Controller/AP Manager/AP Clerk/Viewer) + discrete named permissions (Bill Approver, View Secure Details, Payee Reviewer, Manage Integrations) | Lifecycle roles (Requester/Approver/AP Processor) + module-specific roles (Card Manager/Cardholder, Vendor) |
| Granularity | Historically bundle-based; "20+" marketed permissions; custom roles now self-service via 2026 Team Management hub | Workflow-condition customization (amount/dept/vendor/hierarchy); no granular custom-role builder; explicit gap on GL-account restriction |
| SoD enforcement | Named "payer" approval as second gate after invoice approval; masked bank/tax data behind "View Secure Details" | SoD "by design" via immutable audit trail + workflow rules; approval authority bundled into AP Processor |
| Entity/dept scoping | Multi-entity: users restricted to legal entities they manage | Trays: grouping by business unit/region/department |
| AI in routing | AI-assisted approver prediction (less branded) | Billy the Bot — named, documented, explicitly assistive/overridable |
| Bank/payment data visibility | Explicit named permission (View Secure Details) | Not explicitly documented |
