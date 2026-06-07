/* Decimal — Payments list + Upload Invoice drawer */
const Ip = window.Icons;
const { PAYMENTS } = window.DEC_DATA;

function PaymentsToolbarActions() {
  return (
    <React.Fragment>
      <button className="btn btn-secondary"><Ip.upload w={15} />Upload invoice</button>
      <button className="btn btn-secondary"><Ip.csv w={15} />Import CSV</button>
      <button className="btn btn-primary"><Ip.plus w={15} />New payment</button>
    </React.Fragment>
  );
}

function PaymentsMetrics() {
  return (
    <div className="metrics">
      <div className="metric">
        <div className="m-label">Awaiting your approval</div>
        <div className="m-value">3</div><div className="m-sub">payments</div>
      </div>
      <div className="metric">
        <div className="m-label">Auto-paid this month</div>
        <div className="m-value">7</div><div className="m-sub">18,420.00 USDC</div>
      </div>
      <div className="metric is-alert">
        <div className="m-label">Needs review</div>
        <div className="m-value">2</div><div className="m-sub">vendors unreviewed</div>
      </div>
      <div className="metric">
        <div className="m-label">Settled this month</div>
        <div className="m-value">12</div><div className="m-sub">42,176.67 USDC</div>
      </div>
    </div>
  );
}

function PaymentsFilterBar() {
  const tabs = [['All', 10], ['Active', 5], ['Settled', 3], ['Needs review', 2]];
  return (
    <div className="filterbar">
      <div className="tabs">
        {tabs.map(([t, n], i) => (
          <button className={`tab${i === 0 ? ' on' : ''}`} key={t}>{t}<span className="tab-count">{n}</span></button>
        ))}
      </div>
      <div className="filter-right">
        <div className="input-search">
          <Ip.search w={15} />
          <input className="input" placeholder="Vendor, address, invoice #" />
        </div>
        <div className="select">
          <select defaultValue="all"><option value="all">All treasuries</option><option>Operating</option><option>Payroll reserve</option></select>
          <Ip.chevDown w={14} />
        </div>
      </div>
    </div>
  );
}

function PaymentsTable({ rows = PAYMENTS }) {
  return (
    <div className="tbl-card">
      <table className="tbl">
        <thead>
          <tr>
            <th style={{ width: '24%' }}>Vendor</th>
            <th style={{ width: '16%' }}>Source</th>
            <th className="num" style={{ width: '17%' }}>Amount</th>
            <th style={{ width: '15%' }}>Origin</th>
            <th style={{ width: '20%' }}>Status</th>
            <th style={{ width: 28 }}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <div className="cell-vendor">
                  <span className="v-name">{r.vendor}</span>
                </div>
              </td>
              <td><span className="cell-source"><Ip.treasury w={15} />{r.src}</span></td>
              <td className="td-num">{r.amt} <span style={{ color: 'var(--text-faint)' }}>USDC</span></td>
              <td><span className="pill-origin">{r.origin}</span></td>
              <td>
                <span className="status-cell">
                  <Pill status={r.status} />
                  {r.sl && <SLPill />}
                </span>
              </td>
              <td><span className="row-arrow"><Ip.chevRight w={16} /></span></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="tbl-foot">
        <span className="tf-count">Showing 10 of 48 payments</span>
        <div className="pager">
          <button><Ip.chevRight w={14} style={{ transform: 'rotate(180deg)' }} /></button>
          <button className="on">1</button><button>2</button><button>3</button>
          <button>4</button><button>5</button>
          <button><Ip.chevRight w={14} /></button>
        </div>
      </div>
    </div>
  );
}

function PagePayments() {
  return (
    <AppShell active="Payments">
      <div className="page">
        <div className="stack stack-24">
          <PageHead eyebrow="PAYMENTS" title="All payments"
            desc="Every payment and batch payout in this organization."
            actions={<PaymentsToolbarActions />} />
          <PaymentsMetrics />
          <PaymentsFilterBar />
          <PaymentsTable />
        </div>
      </div>
    </AppShell>
  );
}

/* ---------- Upload Invoice drawer (over dimmed payments) ---------- */
function UploadDrawer({ step = 'result' }) {
  return (
    <div className="dec" style={{ height: '100%' }}>
      <div className="screen-rel">
        {/* dimmed page underneath */}
        <div className="app" style={{ filter: 'saturate(.6)' }}>
          <Sidebar active="Payments" />
          <div className="app-main">
            <div className="app-scroll">
              <div className="page">
                <div className="stack stack-24">
                  <PageHead eyebrow="PAYMENTS" title="All payments"
                    desc="Every payment and batch payout in this organization."
                    actions={<PaymentsToolbarActions />} />
                  <PaymentsMetrics />
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="overlay"></div>
        <div className="drawer drawer-wide">
          <div className="drawer-head">
            <div>
              <h2>{step === 'result' ? 'Created' : step === 'processing' ? 'Extracting…' : 'Upload an invoice'}</h2>
              <p>{step === 'result' ? 'The agent drafted a payable from your file.' : step === 'processing' ? 'Reading vendor, amount, due date, and invoice number.' : 'PDF or image. The agent extracts vendor, amount and due date.'}</p>
            </div>
            <button className="drawer-x"><Ip.x w={14} /></button>
          </div>
          <div className="drawer-body">
            {step === 'picker' && (
              <div className="dropzone">
                <Ip.upload w={34} className="dz-icon" />
                <span className="dz-main">Drag a PDF here, or click to browse</span>
                <span className="dz-sub">Up to 10 MB · PDF or image</span>
              </div>
            )}
            {step === 'processing' && (
              <React.Fragment>
                <div className="dropzone" style={{ height: 96, cursor: 'default', borderStyle: 'solid' }}>
                  <span className="dz-main" style={{ color: 'var(--text-muted)' }}>invoice-INV-2048.pdf</span>
                  <span className="dz-sub">1.2 MB · reading…</span>
                </div>
                <div className="col" style={{ gap: 12 }}>
                  <div className="field"><span className="field-label">Vendor</span><div className="skeleton" style={{ width: '78%', height: 14 }}></div></div>
                  <div className="field"><span className="field-label">Amount</span><div className="skeleton" style={{ width: '46%', height: 14 }}></div></div>
                  <div className="field"><span className="field-label">Due date</span><div className="skeleton" style={{ width: '58%', height: 14 }}></div></div>
                </div>
              </React.Fragment>
            )}
            {step === 'result' && (
              <React.Fragment>
                <div className="row" style={{ gap: 8 }}>
                  <span className="pill pill-warning"><span className="dot"></span>Needs review</span>
                  <span className="spec-note" style={{ flex: 1 }}>Vendor wallet not trusted yet — review in payment detail.</span>
                </div>
                <div className="summary-card">
                  <div className="summary-row"><span className="sr-key">Vendor</span><span className="sr-val">Bangalore Ops Pvt Ltd</span></div>
                  <div className="summary-row"><span className="sr-key">Amount</span><span className="sr-val mono">2,176.67 USDC</span></div>
                  <div className="summary-row"><span className="sr-key">Invoice</span><span className="sr-val mono">INV-2048</span></div>
                  <div className="summary-row"><span className="sr-key">Due date</span><span className="sr-val mono">Apr 30, 2026</span></div>
                </div>
              </React.Fragment>
            )}
          </div>
          <div className="drawer-foot">
            {step === 'result'
              ? <button className="btn btn-primary" style={{ flex: 1 }}>View payment<Ip.arrowRight w={14} /></button>
              : step === 'processing'
                ? <button className="btn btn-secondary" style={{ flex: 1 }} disabled>Extracting…</button>
                : <button className="btn btn-dark" style={{ flex: 1 }}>Cancel</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { PagePayments, PaymentsToolbarActions, PaymentsMetrics, PaymentsFilterBar, PaymentsTable, UploadDrawer, UploadModal });

/* ---------- Upload Invoice — centered modal (3 steps) ---------- */
function UploadModal({ step = 'result' }) {
  return (
    <div className="dec" style={{ height: '100%' }}>
      <div className="screen-rel">
        <div className="app" style={{ filter: 'saturate(.55)' }}>
          <Sidebar active="Payments" />
          <div className="app-main">
            <div className="app-scroll">
              <div className="page">
                <div className="stack stack-24">
                  <PageHead eyebrow="PAYMENTS" title="All payments"
                    desc="Every payment and batch payout in this organization."
                    actions={<PaymentsToolbarActions />} />
                  <PaymentsMetrics />
                  <PaymentsFilterBar />
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="overlay"></div>
        <div className="dialog">
          <div className="dialog-head">
            <div>
              <h2>{step === 'result' ? 'Created' : step === 'processing' ? 'Extracting…' : 'Upload an invoice'}</h2>
              <p>{step === 'result' ? 'The agent drafted a payable from your file.' : step === 'processing' ? 'Reading vendor, amount, due date, and invoice number.' : 'PDF or image. The agent extracts vendor, amount and due date.'}</p>
            </div>
            <button className="drawer-x"><Ip.x w={14} /></button>
          </div>
          <div className="dialog-body">
            {step === 'picker' && (
              <div className="dropzone" style={{ height: 200 }}>
                <Ip.upload w={36} className="dz-icon" />
                <span className="dz-main">Drag a PDF here, or click to browse</span>
                <span className="dz-sub">Up to 10 MB · PDF or image</span>
              </div>
            )}
            {step === 'processing' && (
              <React.Fragment>
                <div className="dropzone" style={{ height: 92, cursor: 'default', borderStyle: 'solid', flexDirection: 'row', gap: 12 }}>
                  <Ip.doc w={26} style={{ color: 'var(--text-faint)' }} />
                  <div className="col" style={{ alignItems: 'flex-start' }}>
                    <span className="dz-main">invoice-INV-2048.pdf</span>
                    <span className="dz-sub">1.2 MB · reading…</span>
                  </div>
                </div>
                <div className="col" style={{ gap: 14 }}>
                  <div className="field"><span className="field-label">Vendor</span><div className="skeleton" style={{ width: '72%', height: 14 }}></div></div>
                  <div className="field"><span className="field-label">Amount</span><div className="skeleton" style={{ width: '44%', height: 14 }}></div></div>
                  <div className="field"><span className="field-label">Due date</span><div className="skeleton" style={{ width: '54%', height: 14 }}></div></div>
                </div>
              </React.Fragment>
            )}
            {step === 'result' && (
              <React.Fragment>
                <div className="row" style={{ gap: 8 }}>
                  <span className="pill pill-warning"><span className="dot"></span>Needs review</span>
                  <span className="spec-note" style={{ flex: 1 }}>Vendor wallet not trusted yet — review in payment detail.</span>
                </div>
                <div className="summary-card">
                  <div className="summary-row"><span className="sr-key">Vendor</span><span className="sr-val">Bangalore Ops Pvt Ltd</span></div>
                  <div className="summary-row"><span className="sr-key">Amount</span><span className="sr-val mono">2,176.67 USDC</span></div>
                  <div className="summary-row"><span className="sr-key">Invoice</span><span className="sr-val mono">INV-2048</span></div>
                  <div className="summary-row"><span className="sr-key">Due date</span><span className="sr-val mono">Apr 30, 2026</span></div>
                </div>
              </React.Fragment>
            )}
          </div>
          <div className="dialog-foot">
            {step === 'result'
              ? <button className="btn btn-primary" style={{ flex: 1 }}>View payment<Ip.arrowRight w={14} /></button>
              : step === 'processing'
                ? <button className="btn btn-secondary" style={{ flex: 1 }} disabled>Extracting…</button>
                : <React.Fragment><button className="btn btn-primary" style={{ flex: 1 }}><Ip.upload w={15} />Browse files</button><button className="btn btn-dark">Cancel</button></React.Fragment>}
          </div>
        </div>
      </div>
    </div>
  );
}
