# Provenance: Market Research on Stablecoin Ops Customer Jobs

Date: 2026-04-09

## Research Goal

Understand whether the current product thesis is missing real customer needs, especially compared with companies like Altitude and broader finance-ops products.

## Primary Sources Used

### Altitude

1. Altitude homepage
- URL: <https://altitude.xyz/>
- Used for:
  - business positioning
  - product surface inventory
  - evidence that Altitude sells accounts, rails, bill pay, accounting, treasury, FX, and exports as one surface

2. Altitude about page
- URL: <https://altitude.xyz/about-us>
- Used for:
  - company thesis
  - AVA framework
  - evidence that Altitude explicitly aims at programmable policy, ERP-triggered payments, and accounting/reporting integrations

3. Altitude blog index
- URL: <https://altitude.xyz/blog>
- Used for:
  - identifying product emphasis areas
  - confirming topical focus on CFO/payment-routing/multicurrency/FX/bill pay

4. Introducing Altitude Bill Pay
- URL: <https://squads.xyz/blog/introducing-altitude-bill-pay>
- Used for:
  - workflow-fragmentation framing
  - bill intake, end-to-end tracking, batch payouts, unified ledger, and multi-rail bill pay insights

5. The CFO Stack: Run Finance at Altitude
- URL: <https://squads.xyz/blog/the-cfo-stack-run-finance-at-altitude>
- Used for:
  - evidence that Altitude is moving into invoicing, bill pay inbox, accounting exports, risk checks, and duplicate/discrepancy handling

### Ramp

6. Ramp AP product page
- URL: <https://ramp.com/accounts-payable>
- Used for:
  - market expectations for AP automation
  - OCR, approval routing, PO matching, ERP sync, payment methods, reporting

7. Ramp bill/payments management and export help page
- URL: <https://support.ramp.com/hc/en-us/articles/27579228841875-Managing-and-exporting-bills-on-Bill-Pay>
- Used for:
  - bills vs payments lifecycle separation
  - queue/filter/view design
  - export expectations

8. Ramp Bill Pay accounting page
- URL: <https://support.ramp.com/hc/en-us/articles/4418336469011-Bill-Pay-accounting>
- Used for:
  - sync behavior
  - accounting integration expectations
  - multi-entity setup
  - sync-error handling

9. Ramp receipt automation page
- URL: <https://ramp.com/receipt-automation>
- Used for:
  - receipt/document capture as a first-class buyer need

### Brex

10. Brex bill pay help
- URL: <https://www.brex.com/support/bill-pay>
- Used for:
  - minimal confirmation that invoice-to-payment workflow is part of the product

11. Brex export/integration help
- URL: <https://www.brex.com/support/integration-exporting>
- Used for:
  - export templates
  - required accounting fields
  - ERP export workflow

12. Brex accounting workflow page
- URL: <https://www.brex.com/support/brex-dashboard-accounting-page>
- Used for:
  - prepare/review/export workflow
  - accounting journal model
  - export history and re-export behavior

### Modern Treasury

13. Modern Treasury Ledgers product page
- URL: <https://www.moderntreasury.com/ledgers>
- Used for:
  - ledger/system-of-record comparison
  - auditability and balance tracking expectations

14. Modern Treasury Ledgers docs overview
- URL: <https://docs.moderntreasury.com/ledgers/docs>
- Used for:
  - evidence that immutable, scalable, double-entry ledgering is treated as the gold standard for products that move money

## Research Method

1. Start from Altitude because the user identified it as strategically interesting.
2. Extract what Altitude is actually selling at the product level.
3. Compare that against adjacent finance-ops leaders:
- Ramp
- Brex
- Modern Treasury
4. Identify repeated customer-job patterns across sources.
5. Compare those patterns against our current product and roadmap.

## Main Inferences

These are inferences drawn from the sources rather than direct claims:

1. Our product is currently best described as a stablecoin settlement assurance / reconciliation layer.
2. The real market job is broader: intake, approval, execution, evidence, accounting, export, and often ledgering.
3. Completing the current buildmap will make our current thesis operationally trustworthy, but it will not by itself make us a full CFO/treasury stack.
4. If we want to pursue the broader market, a post-Phase-E roadmap should move toward bills/invoices/attachments/accounting/export/system-of-record, not merely more blockchain observation features.

## Known Limitations

1. Altitude’s public blog index was accessible, but not every indexed article was fetchable as a standalone page through current tooling.
2. This research focused on product-facing documentation and support/help materials rather than customer interviews or proprietary user data.
3. The brief prioritizes primary product claims and operating-model implications over broader industry quantification.
