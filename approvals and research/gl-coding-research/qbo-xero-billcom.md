# GL coding / expense categorization: the SMB baseline (QBO, Xero, Bill.com)

Research pass for Decimal's GL-coding feature. Goal: know what customers already expect because they've used QBO (mostly), some Xero, and some have touched Bill.com. Decimal's coding inbox should feel familiar to someone who codes bills in QBO every week, not like a new mental model.

---

## 1. QuickBooks Online

### Chart of accounts: Account Type + Detail Type

Every account in QBO has two classification layers:

- **Account Type** — the coarse bucket that determines which financial statement the account lands on (Balance Sheet vs. Profit & Loss) and how QuickBooks treats the balance. There are ~16 top-level types: Bank, Accounts Receivable, Other Current Asset, Fixed Asset, Other Asset, Accounts Payable, Credit Card, Other Current Liability, Long Term Liability, Equity, Income, Cost of Goods Sold, Expense, Other Income, Other Expense.
- **Detail Type** ("Account Subtype" in the API) — a second, finer-grained layer inside each Account Type, used for categorization and reporting but with no separate accounting behavior of its own. Example: under Expense you'd pick a detail type like "Office/General Administrative Expenses" or "Advertising/Promotional." Detail types are drawn from a fixed Intuit-defined list — customers cannot add their own detail types, only their own account Names.

New QBO companies start with roughly 70-80 default accounts pre-seeded; in practice most small businesses end up actively using something closer to 30-40 of them (see Section 4).

Sources: [Account type and detail types in QuickBooks Online](https://quickbooks.intuit.com/learn-support/en-us/help-article/chart-accounts/learn-account-detail-types-chart-accounts/L2gCy0rfy_US_en_US), [Chart of accounts in QuickBooks Online](https://quickbooks.intuit.com/learn-support/en-us/help-article/chart-accounts/learn-chart-accounts-quickbooks-online/L2yc6KBob_US_en_US), [Choosing the right account types in QuickBooks](https://quickbooks.intuit.com/learn-support/en-uk/help-article/chart-accounts/understanding-detail-types-quickbooks-online/L9IuTxhDc_GB_en_GB)

### Categories vs. Items on a bill

A bill line in QBO can be coded two different ways, and QBO forces you to pick one per line:

- **Category details** — codes the line straight to a GL account in the chart of accounts. This is the home for rent, utilities, software subscriptions, professional fees, travel, repairs, office supplies — basically anything that just hits the P&L as an expense with no inventory/COGS tracking behind it. A category line lets you set an account, a description, an amount, a tax rate, and optionally a Class, Location, and Customer.
- **Item details** — codes the line to an entry from the Products & Services list (inventory, non-inventory, service, or bundle item) rather than directly to an account. Item lines matter when the business needs quantity-on-hand, cost-of-goods-sold, or balance-sheet inventory value behind the line — the item itself has an income/expense/asset account mapped to it under the hood, so item coding is really "category coding at one remove."

Most AP-only small businesses (services, not inventory-heavy) code almost everything through Category details and rarely touch Items.

Sources: [QuickBooks Online Category Details vs Item Details](https://www.datamolino.com/blog/quickbooks-online-category-details-vs-item-details/), [Category and Item details — QuickBooks Community](https://quickbooks.intuit.com/learn-support/en-us/reports-and-accounting/category-and-item-details/00/1062867), [Differences Between Category vs Item in QuickBooks Online](https://fitsmallbusiness.com/category-vs-item-in-quickbooks/), [When entering bills what is the difference between items and expense?](https://quickbooks.intuit.com/learn-support/en-us/reports-and-accounting/when-entering-bills-what-is-the-diffence-between-items-and/00/205164)

### Vendor default expense account

Each vendor record can carry a **Default expense account** (Expenses → Vendors → Edit → "Default expense account" dropdown). Once set, it auto-populates the Category details account whenever you manually create a bill, expense, or check for that vendor. This is QBO's simplest coding memory — one account per vendor, no line-item intelligence, no split awareness.

Important limitation: the vendor default expense account does **not** apply to transactions arriving through the bank feed. Downloaded bank transactions are only auto-coded via Bank Rules (below), not vendor defaults — the two systems don't talk to each other.

Sources: [Vendor default expense account — QuickBooks Community](https://quickbooks.intuit.com/learn-support/en-us/reports-and-accounting/vendor-default-expense-account/00/1363613), [vendor default expense account](https://quickbooks.intuit.com/learn-support/en-us/account-management/vendor-default-expense-account/00/832651), [SAVING A CATEGORY WITH EACH VENDOR](https://quickbooks.intuit.com/learn-support/en-us/account-management/saving-a-category-with-each-vendor/00/513313)

### Classes and Locations

QBO's two cross-cutting tag dimensions (Plus/Advanced tiers only):

- **Class** — tracks segments of a business that aren't tied to a physical place: department, product line, business unit. Supports sub-classes via a parent/child hierarchy.
- **Location** (called **Department** in the underlying API — confusingly the API entity name doesn't match the UI label) — tracks physical or operational locations: stores, regions, offices. Also supports a parent/child hierarchy via `ParentRef`.

Both can be applied per-line on a bill (alongside the Category or Item), not just at the header/transaction level, letting a single bill be split across departments or locations.

Sources: [Class — QuickBooks Online API Reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/class), [Department — QuickBooks Online API Reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/department)

### Bank rules and the "suggested category" ML

Two distinct auto-coding mechanisms sit on top of the bank feed, and they interact in a specific priority order:

- **Bank Rules** — user-defined, rule-based: match on payee/description keywords, amount, or bank text, then auto-assign a category (and optionally class/location, memo, split). Fully deterministic, fully user-authored, gets applied first.
- **AI/ML suggested category** — a separate, always-on layer. When a downloaded transaction doesn't match any bank rule, QBO's AI looks at transaction history — how you've categorized similar transactions from the same vendor before — and pre-fills a suggested category. Intuit's own description: it "only pre-fills categories with high-confidence suggestions." If a bank rule exists for a transaction, the rule always wins and overrides the ML suggestion (shown with a "Rule" badge in the category field so the user can tell which mechanism produced the value).

So the actual coding waterfall a QBO user experiences is: vendor default (manual entry only) → bank rule (bank feed only, deterministic) → ML-suggested category (bank feed only, probabilistic, learned from the user's own history) → manual pick.

Sources: [How AI suggestions help match and categorize bank transactions](https://quickbooks.intuit.com/learn-support/en-us/help-article/bank-transactions/ai-suggestions-help-match-categorize-bank/L8FHOh4AD_US_en_US), [Categorize online bank transactions in QuickBooks Online](https://quickbooks.intuit.com/learn-support/en-us/help-article/banking/categorize-match-online-bank-transactions-online/L1bTafTz3_US_en_US), [Set up bank rules to categorize online banking transactions](https://quickbooks.intuit.com/learn-support/en-us/help-article/banking/set-bank-rules-categorize-online-banking-online/L0mjJl0nD_US_en_US), [Learn about updates to the new AI-powered banking page](https://quickbooks.intuit.com/learn-support/en-us/help-article/matching-rules/learn-updates-new-ai-powered-banking-page/L0hR7A9Zf_US_en_US)

### What the QBO API exposes

- **Account** entity — the chart-of-accounts row. Key fields: `Name`, `SubAccount` (bool, parent/child), `FullyQualifiedName`, `Active`, `Classification` (Asset/Liability/Equity/Revenue/Expense — the balance-sheet-vs-P&L bucket), `AccountType` (the ~16-value enum, e.g. "Accounts Receivable"), `AccountSubType` (the detail type, e.g. "AccountsReceivable"), `CurrentBalance`, `CurrentBalanceWithSubAccounts`, `CurrencyRef`, plus standard `Id`/`SyncToken`/`MetaData`. Full CRUD except accounts generally can't be hard-deleted (deactivate via `Active: false` instead).
- **Class** entity — `Name`, `SubClass` (bool), `ParentRef` (`{value, name}`, required if `SubClass` is true), `FullyQualifiedName`, `Active`, standard metadata fields. Query/Create/Read/Update supported.
- **Department** entity (= "Location" in the UI) — `Name` (max 100 chars), `ParentRef` (`{value, name}`, required for sub-departments), `FullyQualifiedName`, `Active`, standard metadata fields. Same CRUD shape as Class.

All three are flat reference-list entities with optional one-level-of-nesting parent/child hierarchy (`SubAccount`/`SubClass`/`ParentRef`), not arbitrary trees. Any bill/expense line can carry an `AccountRef`, optional `ClassRef`, and optional `DepartmentRef` simultaneously — i.e., the three dimensions are orthogonal and independently settable per line.

Sources: [Account — QuickBooks Online API Reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/account), [Class — QuickBooks Online API Reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/class), [Department — QuickBooks Online API Reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/department), [Understanding account type & account sub types — Intuit developer forum](https://help.developer.intuit.com/s/question/0D54R00009Jch41SAB/understanding-account-type-account-sub-types)

---

## 2. Xero

### Chart structure and tracking categories

Xero's chart of accounts works the same way conceptually as QBO's (each account has a type that determines balance sheet vs. P&L placement), but Xero's cross-cutting tag dimension is called **Tracking Categories** rather than Class/Location. A Xero org gets up to **two** tracking category dimensions (e.g., "Department" and "Region" as two separate category groups you define yourself, each with its own set of options) — this is a hard platform cap, unlike QBO's separate Class + Location dimensions. Tracking is optional but is what unlocks segmented P&L reporting by department, location, project, or (for nonprofits) fund.

Source: [Xero Tracking Categories: A UK Guide for 2026](https://snyp.ai/blog/xero-tracking-categories), [Chart of Accounts - Assign a Tracking category — Xero Product Ideas](https://productideas.xero.com/forums/967136-banking-chart-of-accounts/suggestions/47665742-chart-of-accounts-assign-a-tracking-category)

### Bank rules

Same shape as QBO's: a Xero bank rule matches transactions by description keywords, amount ranges, or contact name, and its "allocation" side can set the chart-of-accounts code, VAT/tax rate, tracking category values, and item code, with support for splitting one bank line across multiple GL lines. Purely deterministic, user-authored, no ML.

Source: [Simplify Bookkeeping in Xero with Bank Feeds and Bank Rules](https://blog.accountingprose.com/set-up-bank-feeds-and-rules-in-xero)

### AI-powered prediction (JAX / ML reconciliation)

Xero's ML layer (part of what's now branded "Just Ask Xero"/JAX) predicts the contact and account code for bank transactions that can't be resolved via bank rules, invoice/bill matching, or memorized transactions. Xero's own claim: after a few weeks of usage it can suggest the right account code, contact, and tax treatment for recurring transactions with 90%+ accuracy, learned purely from the org's own transaction history (their example: spend at a new, never-seen office-supply store still gets suggested into "Office Expenses" because of pattern similarity to past transactions). JAX itself is being extended toward "do it for me" tasks (draft an invoice, edit a quote, pay a bill) via chat/WhatsApp/email surfaces, not just categorization — Xero is positioning this as an agent, not just an autocomplete.

Sources: [Xero unveils its AI vision to reimagine small business accounting](https://www.xero.com/us/media-releases/xero-unveils-its-ai-vision-to-reimagine-small-business-accounting/), [Xero reaches milestone in AI strategy with machine learning-powered predictions](https://www.xero.com/us/media-releases/xero-reaches-milestone-in-ai-strategy-with-ml-predictions/), [Just Ask Xero | JAX](https://www.xero.com/us/ai-in-accounting/jax/), [Auto-Categorize Xero Invoices: How AI Learns Your Account Coding from Historical Data](https://www.gennai.io/blog/auto-categorize-xero-invoices-ai-account-coding)

---

## 3. Bill.com

### How bills get coded before sync

Bill.com is an AP layer that sits in front of QBO/Xero/NetSuite/Sage Intacct/Dynamics/QuickBooks Desktop, not a general ledger itself. Coding happens before a bill ever reaches the accounting system:

1. Bills land via direct upload or a per-account vendor email-forwarding inbox.
2. A "Coding Agent" (OCR + ML) extracts header and line-item data and proposes GL coding based on the buyer's own coding history — specifically, it reviews up to the 5 most recent bills from that vendor to infer the org's habitual coding pattern for them (account, department/class, location).
3. Manual entry gets the same assist: picking a vendor that has prior bills triggers "Smart Data Entry," which pre-fills payment terms, description, coding, and even the approver chain from the last bill for that vendor.
4. Every line item must resolve to a valid GL account that already exists in Bill.com's synced chart of accounts — there's no "type a new account name" affordance; the chart is a read-only mirror of whatever the accounting system defines as canonical.
5. If a bill reaches sync with no account set on a line, it falls back to a configured catch-all account — common choices customers configure are "Ask My Accountant," "Miscellaneous," "Uncategorized Expense," or "Other Expense" — explicitly so accountants have one bucket to sweep during close.
6. Coding only becomes final once the bill clears Bill.com's own approval workflow; only fully-Approved bills sync to the accounting system by default (Assigned/Approving/Denied/Unassigned bills are held back).

Sources: [Invoice Coding: Definition and Uses — Bill.com](https://www.bill.com/learning/invoice-coding), [How Bill.com Extracts Invoice Line Items (and Where It Misses)](https://invoicedataextraction.com/blog/bill-com-invoice-coding-agent-line-item-extraction), [Manage sync preferences — BILL Help Center](https://help.bill.com/direct/s/article/115005443106), [Understand Sync Preferences](https://help.bill.com/hc/en-us/articles/115005443106-Understand-Sync-Preferences)

### Vendor defaults and line coding

Vendor-level coding memory works the same way conceptually as QBO's default expense account, but Bill.com's version is closer to a learned habit (last-5-bills pattern) than a single static field — it can infer a class/department/location split pattern too, not just one account.

### Class / Department support per accounting system — and where it breaks

Bill.com calls QuickBooks "Classes" by the name "Departments" internally, and its sync pulls the full reference-list set from the connected system: accounts, vendors, customers, items, departments/classes, jobs. But tracking-dimension support is uneven across back ends:

- **Sage Intacct and NetSuite**: a dedicated Department sync preference exists, including for routing funds-transfer journal entries and FX gain/loss lines to a specified department/location.
- **QuickBooks Online**: department/class sync has its own set of restrictions relative to Desktop (not fully enumerated in public docs, but repeatedly flagged in Bill.com's own KB as a "notes and best practices" caveat).
- **QuickBooks Desktop**: Locations do not sync at all with QuickBooks Desktop — a hard platform gap, not a config choice.

The upshot: even a mature, well-funded AP product like Bill.com doesn't have uniform class/department support across the accounting systems it integrates with — the tracking-dimension story degrades depending on the back end, and that degradation is a documented, expected part of onboarding rather than a bug.

Sources: [Sync and the different versions of QuickBooks](https://help.bill.com/hc/en-us/articles/360000023923-Sync-and-the-different-versions-of-QuickBooks), [QuickBooks Online sync: Notes and best practices](https://vendorpayhelp.bill.com/hc/en-us/articles/360007203232-QuickBooks-Online-sync-Notes-and-best-practices), [Oracle NetSuite sync setup guide](https://help.bill.com/direct/s/article/115005968886)

### What syncs back

Sync is two-way: accounts, vendors, customers, items, classes/departments, and jobs flow from the accounting system into Bill.com so coding stays valid against the canonical chart; approved bills, payments, and GL coding flow back out from Bill.com into the accounting system as bills/journal entries. Whichever system is "sync master" for a given list (e.g., vendor records) is expected to be the one edited — editing the same list in both systems creates conflicts.

Source: [Manage sync preferences — Article Detail](https://help.bill.com/direct/s/article/115005443106)

---

## 4. The SMB reality

### Chart size

Estimates vary by source but converge on a similar range: a brand-new QBO company is seeded with roughly 70-80 default accounts, but most small businesses actively use only 30-40 of them day to day. Independent chart-of-accounts guidance for small businesses generally recommends targeting 30-50 accounts total, occasionally stretching to 60-90 for a "well-designed" chart with sub-account detail. So the honest number to design around is: **a working small-business chart has on the order of 30-50 active expense/income/asset/liability accounts**, most of which a bill will never touch — AP coding in practice draws from a much smaller working set (10-20 recurring expense accounts covering rent, utilities, software/subscriptions, professional fees, insurance, payroll/benefits, travel, office supplies, shipping/postage, advertising, repairs & maintenance).

Sources: [The Ultimate Guide: Chart of Accounts for Small Business](https://www.pacificabs.com/knowledge-center/blog/small-business-accounting-essential-chart-of-accounts-every-owner-should-know/), [Chart of Accounts Setup for Small Business](https://www.sdocpa.com/chart-of-accounts-setup-small-business/), [Chart of accounts for a small business — AccountingTools](https://www.accountingtools.com/articles/what-chart-of-accounts-is-needed-for-a-small-company.html), [Free Chart of Accounts Template & Guide — Ramp](https://ramp.com/blog/chart-of-accounts-template)

### What accountants complain about

The searchable public record here is thinner than expected — Reddit's own search didn't surface exact thread text through the search tool used — but the pattern that shows up consistently across QBO's own community forum and accounting blogs is a recurring "graveyard account" problem: transactions imported or downloaded without a clear category default into holding accounts (**Uncategorized Expense**, **Uncategorized Income**, or **Ask My Accountant**), and if nobody sweeps them before period close, they distort the P&L and create rework at tax time. Intuit's own support docs describe Uncategorized Expense explicitly as "a great temporary holding tank" that becomes a problem specifically because business owners don't come back to reclassify it — the design assumes an accountant or bookkeeper does periodic cleanup, which is exactly the labor AP automation is trying to remove. Bill.com's public materials independently confirm this is universal enough that they ship the same catch-all pattern (Ask My Accountant / Miscellaneous / Uncategorized Expense / Other Expense) as a first-class sync-preference option rather than treating it as an edge case.

Sources: [Uncategorized Expense — QuickBooks Community](https://quickbooks.intuit.com/learn-support/en-us/banking/uncategorized-expense/00/930367), [How to Fix Uncategorized Income and Expenses in QuickBooks](https://smbaccountants.com/blog/uncategorized-income-in-quickbooks/), [Manage default and special accounts in your QuickBooks Online chart of accounts](https://quickbooks.intuit.com/learn-support/en-us/help-article/chart-accounts/manage-default-special-accounts-chart-accounts/L3WvLaIfa_US_en_US), [Optimizing Bank Feeds in QuickBooks with Default Expense Categories](https://www.accountantslawlab.com/blog/optimizing-your-bank-feeds-in-quickbooks-with-default-expense-categories)

---

## 5. What happens with no accounting integration

- **QuickBooks Online / Xero**: not really applicable — these products *are* the general ledger, so "no integration" for them means "no bank feed connected." Without a bank feed, there's no auto-categorization or bank-rule/ML layer at all; every transaction is entered and coded manually (or via CSV/bank-statement import), and the Uncategorized Income/Expense holding accounts specifically exist to catch transactions that come in through import or upload without a clear category — i.e., the fallback-bucket pattern isn't just a bank-feed thing, it's the general "we don't know, park it" mechanism whenever automation can't resolve a code.
- **Bill.com**: designed around a live 2-way sync to a downstream accounting system, but degrades gracefully without one — a business can run Bill.com manually via **CSV export/import** against any accounting software, trading the automatic two-way sync for a chart-of-accounts CSV template workflow. GL coding still happens inside Bill.com (every line still needs a valid account from Bill.com's own list), it just doesn't validate against a live remote chart or push/pull automatically.

The consistent pattern across all three: **the fallback for "we can't confidently code this" is never a hard error — it's always a designated catch-all bucket** (Uncategorized Expense / Ask My Accountant / Miscellaneous) that defers the decision to a human at close, rather than blocking the transaction from being recorded at all.

Sources: [Manage default and special accounts in your QuickBooks Online chart of accounts](https://quickbooks.intuit.com/learn-support/en-us/help-article/chart-accounts/manage-default-special-accounts-chart-accounts/L3WvLaIfa_US_en_US), [Manage sync preferences — BILL Help Center](https://help.bill.com/direct/s/article/115005443106), [BILL Accounting Software Integrations](https://www.bill.com/integrations)

---

## What Decimal should steal / avoid

**Steal:**
- The three-tier coding waterfall — vendor default → deterministic rule → learned/ML suggestion → manual — is the right shape and matches what QBO users already expect. Decimal's coding inbox should present a suggestion but never silently auto-post without the waterfall being inspectable (which rule/vendor-history/model produced it).
- Bill.com's "last 5 bills from this vendor" heuristic for coding memory is simple, explainable, and good enough — don't over-engineer this into a black-box model before there's a reason to.
- A designated catch-all account (Uncategorized/Ask My Accountant equivalent) as the universal fallback, never a hard block, is industry-standard and something accountants already trust — Decimal should route low-confidence OCR/coding straight there rather than inventing a new "pending" state that doesn't map to an accountant's mental model.
- Category vs. Item as two separate, per-line codeable things — most of Decimal's target AP-only customers will never need Items, so this is a simplification opportunity, not something to replicate in full.

**Avoid:**
- Don't try to match QBO/Xero's two-tag-dimension ceiling as a hard platform limit — Decimal doesn't need to invent its own Class/Location system; it should just pass through whatever the connected accounting system defines (QBO Class + Location, or Xero's up-to-two Tracking Categories) rather than building a competing tagging model that then needs its own mapping layer.
- Don't assume class/department sync parity across every future accounting connector — Bill.com's own experience shows this varies materially (NetSuite/Intacct have first-class department routing, QuickBooks Desktop drops Locations entirely). Any Decimal integration beyond QBO should be scoped account-by-account for what tracking dimensions actually sync, not assumed.
- Don't let the "AI suggested category" feel like an opaque autofill. QBO's own docs stress it only pre-fills on high-confidence matches and always shows a "Rule" badge when a deterministic rule overrides it — the transparency-over-magic instinct there is worth keeping, especially since Decimal's target user already distrusts miscoding (see Section 4) and will not extend trust to a black box on day one.
