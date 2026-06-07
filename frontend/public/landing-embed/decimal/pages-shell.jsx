/* Decimal — shared mock data + app shell for full pages */
const Ico = window.Icons;

/* ===================== MOCK DATA ===================== */
const PAYMENTS = [
  { id: 'p1', vendor: 'Bangalore Ops Pvt Ltd', wallet: 'ops-india.eth', dest: '0x7a3f…b91c', src: 'Operating', amt: '2,176.67', origin: 'Single', status: 'Signing', sl: false, sub: '2 of 3 approved' },
  { id: 'p2', vendor: 'Lumen Cloud Inc', wallet: 'lumen.sol', dest: '0x4c2a…7f10', src: 'Operating', amt: '940.00', origin: 'Apr cloud', status: 'Settled', sl: true, sub: 'via Apr cloud bills' },
  { id: 'p3', vendor: 'Río Diseño SA', wallet: 'rio-mx.eth', dest: '0x9e81…2d44', src: 'Operating', amt: '3,500.00', origin: 'Single', status: 'Received', sl: false, sub: 'just created' },
  { id: 'p4', vendor: 'Praxis Legal LLP', wallet: 'unreviewed wallet', dest: '0xb172…0a9e', src: 'Payroll reserve', amt: '1,250.00', origin: 'Single', status: 'Exception', sl: false, sub: 'wallet not trusted' },
  { id: 'p5', vendor: 'Northwind Hosting', wallet: 'northwind.sol', dest: '0x2f55…cc18', src: 'Operating', amt: '610.40', origin: 'Apr cloud', status: 'Settled', sl: true, sub: 'via Apr cloud bills' },
  { id: 'p6', vendor: 'Meridian Translations', wallet: 'meridian.eth', dest: '0x6d09…41af', src: 'Operating', amt: '480.00', origin: 'Single', status: 'Reviewed', sl: false, sub: 'ready to propose' },
  { id: 'p7', vendor: 'Cobalt Studio', wallet: 'cobalt.sol', dest: '0x88c1…9b27', src: 'Operating', amt: '5,200.00', origin: 'Single', status: 'Send', sl: false, sub: 'executing' },
  { id: 'p8', vendor: 'Atlas Freight Co', wallet: 'atlas-freight.eth', dest: '0x1aa4…7e63', src: 'Operating', amt: '1,845.20', origin: 'Q1 logistics', status: 'Settled', sl: false, sub: 'settled' },
  { id: 'p9', vendor: 'Verde Energy', wallet: 'verde.sol', dest: '0x3f70…d519', src: 'Operating', amt: '320.00', origin: 'Apr cloud', status: 'Settled', sl: true, sub: 'via Apr cloud bills' },
  { id: 'p10', vendor: 'Sundial Media', wallet: 'sundial.eth', dest: '0x9b22…6c84', src: 'Payroll reserve', amt: '2,750.00', origin: 'Single', status: 'Cancelled', sl: false, sub: 'cancelled by Jordan' },
];

const STATUS_MAP = {
  Received: 'pill-neutral', Reviewed: 'pill-info', Signing: 'pill-warning',
  Send: 'pill-info', Settled: 'pill-success', Cancelled: 'pill-neutral', Exception: 'pill-danger',
};

const TREASURIES = [
  { id: 't1', name: 'Operating', bal: '128,440.18', policies: 3, status: 'Active' },
  { id: 't2', name: 'Payroll reserve', bal: '64,900.00', policies: 1, status: 'Active' },
  { id: 't3', name: 'Tax holdback', bal: '21,310.55', policies: 0, status: 'Active' },
];

const POLICIES = [
  { id: 'sl1', name: 'Apr cloud bills', treasury: 'Operating', limit: '5,000', period: 'per month', vendors: 3, status: 'Active' },
  { id: 'sl2', name: 'Logistics under 2k', treasury: 'Operating', limit: '2,000', period: 'per payment', vendors: 5, status: 'Active' },
  { id: 'sl3', name: 'Contractor retainers', treasury: 'Payroll reserve', limit: '8,000', period: 'per month', vendors: 4, status: 'Pending approval' },
  { id: 'sl4', name: 'Translation services', treasury: 'Operating', limit: '1,000', period: 'per month', vendors: 2, status: 'Paused' },
];
const POLICY_STATUS = { Active: 'pill-success', 'Pending approval': 'pill-warning', Removing: 'pill-neutral', Removed: 'pill-neutral', Failed: 'pill-danger', Paused: 'pill-neutral' };

const EXECUTIONS = [
  { vendor: 'Lumen Cloud Inc', amt: '940.00', policy: 'Apr cloud bills', sig: '5h2K…9Qpv' },
  { vendor: 'Northwind Hosting', amt: '610.40', policy: 'Apr cloud bills', sig: '7nB1…3Lqz' },
  { vendor: 'Verde Energy', amt: '320.00', policy: 'Apr cloud bills', sig: 'Qp84…2vRm' },
  { vendor: 'Castor Freight', amt: '1,420.00', policy: 'Logistics under 2k', sig: 'Lm33…8kYt' },
  { vendor: 'Polaris Parts', amt: '780.50', policy: 'Logistics under 2k', sig: 'Zx90…1aQp' },
];

const MEMBERS = [
  { name: 'Jordan Keil', email: 'jordan@northvale.co', init: 'JK', perms: ['Initiator', 'Approver', 'Executor'] },
  { name: 'Amara Osei', email: 'amara@northvale.co', init: 'AO', perms: ['Approver'] },
  { name: 'Devin Park', email: 'devin@northvale.co', init: 'DP', perms: ['Approver', 'Executor'] },
  { name: 'Decimal agent', email: 'bounded autonomy', init: 'D', perms: ['Initiator'], agent: true },
];

const INBOX_APPROVAL = [
  { vendor: 'Bangalore Ops Pvt Ltd', amt: '2,176.67', sub: '2 of 3 approved' },
  { vendor: 'Cobalt Studio', amt: '5,200.00', sub: '1 of 3 approved' },
  { vendor: 'Sierra Components', amt: '890.00', sub: '2 of 3 approved' },
];
const INBOX_AUTOPAID = [
  { vendor: 'Lumen Cloud Inc', amt: '940.00', sub: 'via Apr cloud bills' },
  { vendor: 'Northwind Hosting', amt: '610.40', sub: 'via Apr cloud bills' },
  { vendor: 'Verde Energy', amt: '320.00', sub: 'via Apr cloud bills' },
];
const INBOX_REVIEW = [
  { vendor: 'Praxis Legal LLP', amt: '1,250.00', sub: 'Counterparty wallet unreviewed' },
  { vendor: 'Quill & Co', amt: '430.00', sub: 'Amount above usual range' },
];

window.DEC_DATA = { PAYMENTS, STATUS_MAP, TREASURIES, POLICIES, POLICY_STATUS, EXECUTIONS, MEMBERS, INBOX_APPROVAL, INBOX_AUTOPAID, INBOX_REVIEW };

/* ===================== APP SHELL ===================== */
function Pill({ status, map }) {
  const cls = (map || STATUS_MAP)[status] || 'pill-neutral';
  return <span className={`pill ${cls}`}><span className="dot"></span>{status}</span>;
}
function SLPill() { return <span className="pill-sl"><Ico.bolt w={10} fill="currentColor" sw={0} />SL</span>; }
window.Pill = Pill; window.SLPill = SLPill;

function Sidebar({ active = 'Payments' }) {
  const Item = ({ icon: I2, label, badge }) => (
    <div className={`sb-item${label === active ? ' is-active' : ''}`}>
      <I2 w={16} /><span className="sb-label">{label}</span>
      {badge && <span className="sb-badge">{badge}</span>}
    </div>
  );
  return (
    <div className="sidebar">
      <div className="sb-top">
        <div className="sb-wordmark"><span className="glyph">D</span>Decimal</div>
      </div>
      <div className="sb-org">
        <span className="org-initials">NV</span>
        <span className="org-name">Northvale Labs</span>
        <Ico.chevDown w={14} className="org-chev" />
      </div>
      <div className="sb-nav">
        <div className="sb-group-label">Operations</div>
        <Item icon={Ico.grid} label="Overview" />
        <Item icon={Ico.payments} label="Payments" badge="3" />
        <Item icon={Ico.collections} label="Collections" />
        <div className="sb-group-label">Registry</div>
        <Item icon={Ico.treasury} label="Treasury accounts" />
        <Item icon={Ico.members} label="Members" />
        <Item icon={Ico.address} label="Address book" badge="2" />
        <div className="sb-group-label">Governance</div>
        <Item icon={Ico.proposals} label="Proposals" />
        <Item icon={Ico.shield} label="Spending limits" />
      </div>
      <div className="sb-footer">
        <div className={`sb-user${active === 'Profile' ? ' is-active-user' : ''}`}>
          <span className="avatar">JK</span>
          <div className="col" style={{ flex: 1, minWidth: 0 }}>
            <span className="u-name">Jordan Keil</span>
            <span className="u-mail">jordan@northvale.co</span>
          </div>
          <Ico.chevDown w={14} style={{ color: 'var(--text-faint)' }} />
        </div>
      </div>
    </div>
  );
}

// Full app screen: sidebar + scrollable main. children = page content.
function AppShell({ active, children, topbar }) {
  return (
    <div className="dec" style={{ height: '100%' }}>
      <div className="app">
        <Sidebar active={active} />
        <div className="app-main">
          {topbar}
          <div className="app-scroll">{children}</div>
        </div>
      </div>
    </div>
  );
}

// Page header block
function PageHead({ eyebrow, title, desc, actions, greet }) {
  return (
    <div className={greet ? 'greet' : ''}>
      {eyebrow && <div className="eyebrow" style={{ marginBottom: 10 }}>{eyebrow}</div>}
      <div className="pagehead" style={!actions && !desc ? { borderBottom: 'none', paddingBottom: 0 } : {}}>
        <div className="ph-titles">
          <h1>{title}</h1>
          {desc && <p className="ph-desc">{desc}</p>}
        </div>
        {actions && <div className="ph-actions">{actions}</div>}
      </div>
    </div>
  );
}

Object.assign(window, { Sidebar, AppShell, PageHead });
