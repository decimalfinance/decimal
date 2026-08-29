// Decimal — synthetic invoice set v3: vendors + the 22 cases from TESTING-INVOICES.md.
//
// Every case exists to make one branch or gate of the Testing Labs pipeline
// observable. Amounts, invoice numbers and dates are deterministic so the
// catalog stays stable across regenerations.

export const BILL_TO = {
  name: 'Testing Labs',
  addr: '660 Mission St, Floor 4',
  city: 'San Francisco, CA 94105',
};

// B1 only: the old test org, deliberately the wrong bill-to.
export const WRONG_BILL_TO = {
  name: 'Halcyon Labs, Inc.',
  addr: '2211 Elliott Ave, Suite 400',
  city: 'Seattle, WA 98121',
};

export const VENDORS = {
  brightwave: {
    name: 'Brightwave Media', addr: '210 5th Ave', city: 'New York, NY 10010',
    email: 'accounts@brightwave.example', phone: '(212) 555-0184',
    bank: 'Metro Commerce Bank', routing: '021000021', acct: '1190',
    accent: '#1f4e79', template: 'letterhead',
  },
  juniper: {
    name: 'Juniper Office Supply', addr: '1220 SE Ankeny St', city: 'Portland, OR 97214',
    email: 'ar@juniperoffice.example', phone: '(503) 555-0142',
    bank: 'Cascade First Bank', routing: '123000220', acct: '5531',
    accent: '#3a6b35', template: 'minimal',
  },
  ironclad: {
    name: 'Ironclad Security', addr: '500 Howard St', city: 'San Francisco, CA 94105',
    email: 'billing@ironcladsec.example', phone: '(415) 555-0117',
    bank: 'Golden Gate Bank', routing: '121042882', acct: '0556',
    accent: '#5b2333', template: 'letterhead',
  },
  northwind: {
    name: 'Northwind Supplies', addr: '77 Industrial Pkwy', city: 'Columbus, OH 43004',
    email: 'orders@northwind.example', phone: '(614) 555-0169',
    bank: 'Buckeye Bank', routing: '044000037', acct: '2201',
    accent: '#8a6d1f', template: 'minimal',
  },
  kepler: {
    name: 'Kepler Legal LLP', addr: '1 Beacon St', city: 'Boston, MA 02108',
    email: 'billing@keplerlegal.example', phone: '(617) 555-0126',
    bank: 'Commonwealth Trust', routing: '011500120', acct: '7742',
    accent: '#2f3061', template: 'letterhead',
  },
  meridian: {
    name: 'Meridian Logistics LLC', addr: '88 Harbor Rd', city: 'Oakland, CA 94607',
    email: 'ap@meridianlogistics.example', phone: '(510) 555-0138',
    bank: 'Pacific Union Bank', routing: '121000248', acct: '3390',
    accent: '#1d5c63', template: 'letterhead',
  },
  vantage: {
    name: 'Vantage Print Co', addr: '12 Rutland St', city: 'Boston, MA 02118',
    email: 'hello@vantageprint.example', phone: '(617) 555-0153',
    bank: 'BayState Bank', routing: '011000138', acct: '8804',
    accent: '#7a3b8f', template: 'minimal',
  },
  coastal: {
    name: 'Coastal Freight Co', addr: '9 Cannery Row', city: 'Monterey, CA 93940',
    email: 'ap@coastalfreight.example', phone: '(831) 555-0171',
    bank: 'Seaboard Bank', routing: '121122676', acct: '9012',
    accent: '#0f4c81', template: 'letterhead',
  },
  zephyr: {
    name: 'Zephyr Analytics', addr: '340 Congress St', city: 'Austin, TX 78701',
    email: 'billing@zephyranalytics.example', phone: '(512) 555-0195',
    bank: 'Lone Star Bank', routing: '111000025', acct: '4417',
    accent: '#00695c', template: 'twocol',
  },
  acme: {
    name: 'Acme Cloud Services, Inc.', addr: '450 Westlake Ave N', city: 'Seattle, WA 98109',
    email: 'billing@acmecloud.example', phone: '(206) 555-0110',
    bank: 'First Interstate Bank', routing: '125000105', acct: '6621',
    accent: '#b3541e', template: 'minimal',
  },
  merritt: {
    name: 'Merritt Facilities Group', addr: '88 Wharf Rd', city: 'Oakland, CA 94607',
    email: 'billing@merrittfacilities.example', phone: '(510) 555-0166',
    bank: 'East Bay Commerce Bank', routing: '121000358', acct: '4417',
    accent: '#2f5d50', template: 'letterhead',
  },
  halstead: {
    name: 'Halstead Consulting', addr: '415 N Dearborn St', city: 'Chicago, IL 60654',
    email: 'billing@halsteadconsulting.example', phone: '(312) 555-0129',
    bank: 'Lakeshore National Bank', routing: '071000013', acct: '2288',
    accent: '#444444', template: 'minimal',
  },
  bergmann: {
    name: 'Bergmann Studio GmbH', addr: 'Torstraße 140', city: '10119 Berlin, Germany',
    email: 'rechnung@bergmannstudio.example', phone: '+49 30 555 0146',
    iban: 'DE89 3704 0044 0532 0130 00', bic: 'COBADEFFXXX', bankName: 'Commerzbank Berlin',
    accent: '#1a1a1a', template: 'eu',
  },
  brightwaveLtd: {
    name: 'Brightwave Media Ltd', addr: '14 Clerkenwell Road', city: 'London EC1M 5PA, United Kingdom',
    email: 'accounts@brightwavemedia.example', phone: '+44 20 7946 0921',
    bank: 'Barclays Bank UK (USD account) · SWIFT BUKBGB22', routing: null, acct: '4471',
    accent: '#20536c', template: 'letterhead',
  },
};

const L = (desc, qty, unit) => ({ desc, qty, unit });

// A2 and B4 must carry identical figures (vendor, number, dates, lines) while
// the files differ byte-wise — B4's spec is built from this shared object.
const A2_SPEC = {
  vendor: 'brightwave', invoiceNo: 'BW-2210', date: '2026-08-06', due: '2026-09-05',
  terms: 'Net 30',
  lines: [
    L('Social media management — August', 1, 3200),
    L('Content production (4 assets)', 4, 325),
  ],
};

export const CASES = [
  // ---- A. Routing coverage — clean, one per branch --------------------------
  {
    id: 'A1', file: 'A-routing/A1-high-value-24800.pdf', format: 'pdf',
    vendor: 'brightwave', invoiceNo: 'BW-2201', date: '2026-08-03', due: '2026-09-02',
    terms: 'Net 30', po: 'PO-7702',
    lines: [
      L('Q3 brand campaign — production', 1, 14500),
      L('Media placement — August flight', 1, 7800),
      L('Campaign analytics retainer', 1, 2500),
    ],
    expect: '≥ $10,000 → 3-of-4 quorum (Marcus/Tom/Ines/Sam) then Nadia. Clean, no flags.',
  },
  {
    id: 'A2', file: 'A-routing/A2-mid-band-4500.pdf', format: 'pdf',
    ...A2_SPEC,
    expect: '≥ $1,000 → Marcus, then Tom or Ines. Clean. Confirm BEFORE uploading B4.',
  },
  {
    id: 'A3', file: 'A-routing/A3-first-bill-312.pdf', format: 'pdf',
    vendor: 'juniper', invoiceNo: 'JOS-1147', date: '2026-08-10', due: '2026-08-25',
    terms: 'Net 15',
    lines: [
      L('Copy paper, letter, 10-ream case', 2, 24.5),
      L('Toner cartridge — HP 58A', 2, 89),
      L('Desk organizer trays', 4, 12.35),
      L('Sticky notes, assorted 12-pack', 3, 12),
    ],
    expect: 'First bill from Juniper (< $1,000) → Ines or Sam. Juniper must appear NOWHERE else.',
  },
  {
    id: 'A4', file: 'A-routing/A4-routine-312.pdf', format: 'pdf',
    vendor: 'brightwave', invoiceNo: 'BW-2219', date: '2026-08-11', due: '2026-09-10',
    terms: 'Net 30',
    lines: [
      L('Stock photography licenses (8)', 8, 28.3),
      L('Font license — campaign use', 1, 86),
    ],
    expect: 'Same $312.40 as A3, but Brightwave has history → routine any-of-4. Upload AFTER A1/A2.',
  },

  // ---- B. Draft-stage gates — must block at Confirm -------------------------
  {
    id: 'B1', file: 'B-draft-gates/B1-addressed-elsewhere.pdf', format: 'pdf',
    vendor: 'ironclad', billTo: WRONG_BILL_TO,
    invoiceNo: 'IRN-889', date: '2026-08-04', due: '2026-08-19', terms: 'Net 15',
    lines: [
      L('Quarterly security monitoring', 1, 5400),
      L('Incident response retainer', 1, 800),
    ],
    expect: 'Billed to Halcyon Labs, Inc. → addressed_elsewhere blocks Confirm.',
  },
  {
    id: 'B2', file: 'B-draft-gates/B2-lines-dont-sum.pdf', format: 'pdf',
    vendor: 'northwind', invoiceNo: 'NW-3320', date: '2026-08-05', due: '2026-09-04',
    terms: 'Net 30',
    lines: [
      L('Warehouse shelving units', 4, 650),
      L('Forklift annual service', 1, 900),
      L('Safety equipment restock', 1, 500),
    ],
    // Lines sum to $4,000; the document states $4,820.
    printedSubtotal: 4820, printedTotal: 4820,
    expect: 'Lines sum $4,000 but total reads $4,820 → lines_do_not_sum blocks Confirm.',
  },
  {
    id: 'B3', file: 'B-draft-gates/B3-total-doesnt-reconcile.pdf', format: 'pdf',
    vendor: 'kepler', invoiceNo: 'KL-1340', date: '2026-08-07', due: '2026-08-22',
    terms: 'Net 15',
    lines: [
      L('Contract review — vendor agreements', 8, 450),
      L('Regulatory filing', 1, 400),
    ],
    // Subtotal $4,000 and tax $320 are both correct; the stated total is not.
    taxRate: 0.08, printedTotal: 4820,
    expect: 'Subtotal $4,000 + tax $320, total reads $4,820 (≠ $4,320) → total_does_not_reconcile.',
  },
  {
    id: 'B4', file: 'B-draft-gates/B4-duplicate-of-A2.pdf', format: 'pdf',
    ...A2_SPEC,
    renderSalt: 'duplicate-rerender', // byte-different file, identical figures
    expect: 'Same vendor + number + amount as A2, different bytes → possible_duplicate. Upload AFTER A2.',
  },
  {
    id: 'B5', file: 'B-draft-gates/B5-statement-of-account.pdf', format: 'pdf',
    template: 'statement',
    vendor: 'meridian', invoiceNo: 'MST-2026-08', date: '2026-08-15',
    statementRows: [
      { no: 'MER-8801', date: '2026-06-30', amount: 12400, status: 'Paid' },
      { no: 'MER-8842', date: '2026-07-15', amount: 13150, status: 'Open' },
      { no: 'MER-8890', date: '2026-08-01', amount: 9800, status: 'Open' },
    ],
    expect: 'Statement listing prior invoices, balance $22,950 → looks_like_statement.',
  },
  {
    id: 'B6', file: 'B-draft-gates/B6-credit-note.pdf', format: 'pdf',
    template: 'creditnote',
    vendor: 'vantage', invoiceNo: 'CN-0442', date: '2026-08-09',
    creditRef: 'VP-3390',
    lines: [L('Credit — returned banner stands', 2, -120)],
    expect: 'CN-series number, negative total −$240 → looks_like_credit_note.',
  },

  // ---- C. Extraction difficulty — honest low confidence ---------------------
  {
    id: 'C1', file: 'C-extraction/C1-photographed.jpg', format: 'jpeg', degrade: 'photo',
    vendor: 'coastal', invoiceNo: 'CF-2210', date: '2026-07-28', due: '2026-08-27',
    terms: 'Net 30', noRemit: true, // the photo crops the remit footer off
    lines: [
      L('Ocean freight — inbound APAC', 1, 6400),
      L('Customs brokerage', 1, 950),
      L('Drayage — Port of Oakland', 1, 450),
    ],
    expect: 'Photographed paper, skewed, shadowed, footer cropped → low confidence + unreadable_payment_details.',
  },
  {
    id: 'C2', file: 'C-extraction/C2-soft-scan-150dpi.jpg', format: 'jpeg', degrade: 'scan',
    vendor: 'kepler', invoiceNo: 'KL-1290', date: '2026-08-01', due: '2026-08-16',
    terms: 'Net 15',
    lines: [
      L('Employment agreements — review', 5, 450),
      L('IP assignment filings', 2, 325),
    ],
    expect: '~150 DPI grayscale scan, legible but soft → fields read, confidence dips.',
  },
  {
    id: 'C3', file: 'C-extraction/C3-multipage-total-last.pdf', format: 'pdf', multipage: true,
    vendor: 'ironclad', invoiceNo: 'IRN-902', date: '2026-08-08', due: '2026-09-07',
    terms: 'Net 30', po: 'PO-7719',
    lineGroups: [
      { title: 'Phase 1 — Reconnaissance & scoping', lines: [
        L('External attack-surface mapping', 1, 1200), L('Subdomain enumeration & takeover checks', 1, 850),
        L('OSINT review — exposed credentials', 1, 600), L('Cloud asset inventory (AWS)', 1, 450),
        L('Network perimeter scan', 1, 720), L('TLS/certificate posture review', 1, 380),
        L('Email security (SPF/DKIM/DMARC) audit', 1, 540), L('Scoping workshops (2)', 2, 130),
      ] },
      { title: 'Phase 2 — Application testing', lines: [
        L('Web app — authenticated testing', 1, 980), L('Web app — unauthenticated testing', 1, 760),
        L('API endpoint fuzzing', 1, 1140), L('Session management review', 1, 420),
        L('Access-control matrix testing', 1, 660), L('File upload abuse cases', 1, 300),
        L('Mobile app — static analysis', 1, 890), L('Mobile app — dynamic analysis', 1, 350),
      ] },
      { title: 'Phase 3 — Reporting & remediation', lines: [
        L('Findings triage & severity scoring', 1, 640), L('Executive summary preparation', 1, 480),
        L('Technical report drafting', 1, 850), L('Remediation guidance sessions (3)', 3, 130),
        L('Retest — critical findings', 1, 520), L('Retest — high findings', 1, 310),
        L('Attestation letter', 1, 260), L('Project management', 1, 250),
      ] },
    ],
    expect: '3 pages, total only on the last page → multi-page extraction. Sum $14,200.',
  },
  {
    id: 'C4', file: 'C-extraction/C4-two-column-footer-remit.pdf', format: 'pdf',
    template: 'twocol',
    vendor: 'zephyr', invoiceNo: 'ZA-8102', date: '2026-08-05', due: '2026-08-20',
    terms: 'Net 15',
    lines: [
      L('Data warehouse migration — sprint 6', 1, 3800),
      L('Dashboard build-out (3)', 3, 540),
    ],
    expect: 'Two-column layout, remit-to buried in the footer → layout stress.',
  },
  {
    id: 'C5', file: 'C-extraction/C5-stamped-paid.png', format: 'png', degrade: 'stamp',
    vendor: 'northwind', invoiceNo: 'NW-3388', date: '2026-07-22', due: '2026-08-06',
    terms: 'Net 15',
    lines: [
      L('Pallet racking inspection', 1, 1450),
      L('Loading dock repair', 1, 1700),
    ],
    expect: 'Handwritten amount note + red PAID stamp overlapping the total → extraction must not guess.',
  },

  // ---- D. Shape variety — realistic mess ------------------------------------
  {
    id: 'D1', file: 'D-shape-variety/D1-twenty-two-lines.pdf', format: 'pdf',
    vendor: 'acme', invoiceNo: 'ACM-20661', date: '2026-08-01', due: '2026-08-31',
    terms: 'Net 30', po: 'PO-7688',
    lines: [
      L('Compute — c5.xlarge reserved (4)', 4, 310), L('Compute — c5.large on-demand', 1, 410),
      L('GPU instances — inference (2)', 2, 390), L('Object storage — 41 TB', 1, 820),
      L('Block storage — SSD', 1, 260), L('Archive storage', 1, 90),
      L('Managed Postgres cluster', 1, 640), L('Redis cache', 1, 180),
      L('Kafka streaming', 1, 310), L('Load balancer hours', 1, 140),
      L('NAT gateway', 1, 120), L('Egress bandwidth — 9 TB', 1, 540),
      L('CDN delivery', 1, 230), L('DNS zones (12)', 12, 5),
      L('Monitoring — metrics', 1, 190), L('Log ingestion — 800 GB', 1, 240),
      L('Backup snapshots', 1, 110), L('KMS operations', 1, 40),
      L('Container registry', 1, 70), L('CI build minutes', 1, 280),
      L('Priority support plan', 1, 350), L('Static IP addresses (10)', 10, 4),
    ],
    expect: '22 line items → per-line GL coding has something to chew on. Sum $7,140.',
  },
  {
    id: 'D2', file: 'D-shape-variety/D2-single-line-minimal.pdf', format: 'pdf',
    vendor: 'halstead', invoiceNo: 'HC-118', date: '2026-08-12', due: '2026-08-27',
    terms: 'Due on receipt', noRemit: true,
    lines: [L('Advisory services — August', 1, 1200)],
    expect: 'One line, no tax, no PO, no bank details → minimal shape + unreadable_payment_details.',
  },
  {
    id: 'D3', file: 'D-shape-variety/D3-eur-unsupported.pdf', format: 'pdf',
    template: 'eu', currency: 'EUR',
    vendor: 'bergmann', invoiceNo: 'RE-2026-441', date: '2026-08-06', due: '2026-09-05',
    terms: '30 Tage netto',
    lines: [
      L('Markenentwicklung — Phase 2', 1, 3000),
      L('Bildretusche (24 Motive)', 24, 50),
    ],
    expect: 'EUR invoice → extracted correctly, then refused: unsupported_currency.',
  },
  {
    id: 'D4', file: 'D-shape-variety/D4-near-match-vendor.pdf', format: 'pdf',
    vendor: 'brightwaveLtd', invoiceNo: 'BWL-077', date: '2026-08-13', due: '2026-08-28',
    terms: 'Net 15',
    lines: [L('Design retainer — August', 1, 1900)],
    expect: '"Brightwave Media Ltd" vs existing "Brightwave Media" → near-match vendor handling. Upload after any Brightwave bill.',
  },
  {
    id: 'D5', file: 'D-shape-variety/D5-no-invoice-number.pdf', format: 'pdf',
    vendor: 'vantage', invoiceNo: null, date: '2026-08-09', due: '2026-08-24',
    terms: 'Net 15',
    lines: [
      L('Event signage package', 1, 1050),
      L('Rush production', 1, 450),
    ],
    expect: 'No invoice number anywhere on the document.',
  },
  {
    id: 'D6', file: 'D-shape-variety/D6-mixed-coding.pdf', format: 'pdf',
    vendor: 'merritt', invoiceNo: 'MFG-4471', date: '2026-08-18', due: '2026-09-17',
    terms: 'Net 30', po: 'PO-7712',
    // D1 is 22 lines from one cloud vendor, so nearly all of it codes to one
    // account — correctly, which makes it a test of VOLUME and no test at all
    // of category variety: "everything is Cloud hosting" is indistinguishable
    // from the coder giving up.
    //
    // These 22 lines are one facilities vendor's monthly bill, and every group
    // belongs somewhere different: paper and toner are office supplies, the
    // courier is shipping, the copier is a rental, the cleaners are
    // contractors, the permit is a tax. A wrong answer is visible here, which
    // is the whole point.
    lines: [
      L('A4 paper — 40 reams', 40, 6), L('Toner cartridges', 6, 85),
      L('Brochure printing — 2,000', 1, 940), L('Exhibition banner stand', 1, 320),
      L('Overnight courier — 14 shipments', 14, 18), L('Pallet freight — depot transfer', 1, 480),
      L('Photocopier lease — August', 1, 275), L('Floor scrubber hire — 3 days', 3, 60),
      L('Meeting room hire — annexe', 1, 650), L('Electricity recharge — August', 1, 1180),
      L('Broadband and phone lines', 1, 340), L('HVAC filter replacement', 1, 195),
      L('Espresso machine service call', 1, 130), L('Night cleaning crew — August', 1, 1450),
      L('Reception relief staff — 4 days', 4, 165), L('Waste collection permit', 1, 85),
      L('Access control software — 12 seats', 12, 9), L('Safety gloves and hi-vis vests', 1, 145),
      L('First aid kit restock', 1, 75), L('Card payment processing fees', 1, 96),
      L('Client lunch catering — board meeting', 1, 285), L('Document shredding and storage', 1, 210),
    ],
    expect: '22 lines spanning a dozen different expense accounts. Sum $8,806. The real test of per-line GL coding: unlike D1, one account for everything is the WRONG answer here.',
  },

  // ---- E. Payment path ------------------------------------------------------
  {
    id: 'E1', file: 'E-payment-path/E1-clean-walk-850.pdf', format: 'pdf',
    vendor: 'brightwave', invoiceNo: 'BW-2230', date: '2026-08-14', due: '2026-08-29',
    terms: 'Net 15',
    lines: [L('Landing page copy refresh', 1, 850)],
    expect: 'Clean $850, Brightwave has history → routine chain, then Dara releases. The full walk.',
  },
  {
    id: 'E2', file: 'E-payment-path/E2-over-ceiling-150000.pdf', format: 'pdf',
    vendor: 'meridian', invoiceNo: 'MER-9001', date: '2026-08-10', due: '2026-09-09',
    terms: 'Net 30',
    lines: [L('Annual freight contract — prepayment', 1, 150000)],
    expect: '$150,000 → over_ceiling blocks Confirm. REQUIRES a ceiling set first (Zara, Policies page).',
  },
];
