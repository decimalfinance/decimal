// Bills workbench — the operator's home (uploads/ap-claude-code-handoff.md §2).
// A triage surface: five lifecycle tabs over one bills query, urgency-sorted,
// rows routing to the review screen (needs-review) or detail (everything else).
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { billsApi, invoiceIntakeApi, type BillBucket, type WorkbenchBill } from '../api';
import { Ico } from '../dec/icons';
import { PageHead } from '../dec/primitives';
import { useToast } from '../ui/Toast';

const TABS: Array<{ key: BillBucket; label: string }> = [
  { key: 'needs_review', label: 'Needs review' },
  { key: 'in_approval', label: 'In approval' },
  { key: 'to_pay', label: 'To pay' },
  { key: 'done', label: 'Done' },
  { key: 'needs_attention', label: 'Needs attention' },
];

const DAY_MS = 24 * 60 * 60 * 1000;

function usd(amount: number): string {
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function ageDays(createdAt: string): number {
  return Math.floor((Date.now() - new Date(createdAt).getTime()) / DAY_MS);
}

function dueInfo(bill: WorkbenchBill): { label: string; overdue: boolean; overdueDays: number } {
  if (!bill.dueAt) return { label: '—', overdue: false, overdueDays: 0 };
  const due = new Date(bill.dueAt);
  const label = due.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const stillOpen = bill.bucket !== 'done' && bill.bucket !== 'needs_attention';
  const overdueDays = Math.floor((Date.now() - due.getTime()) / DAY_MS);
  return { label, overdue: stillOpen && overdueDays > 0, overdueDays };
}

// Default sort: computed urgency — expiring discounts and overdue climb,
// then due date, then age (spec: surfaced honestly, overridable).
function urgencyScore(bill: WorkbenchBill): number {
  let score = 0;
  const { overdue, overdueDays } = dueInfo(bill);
  if (overdue) score -= 4000 + overdueDays;
  if (bill.discountLabel) score -= 2000;
  if (bill.dueAt) score += Math.floor(new Date(bill.dueAt).getTime() / DAY_MS);
  else score += 1e6 - ageDays(bill.createdAt);
  return score;
}

export function BillsPage() {
  const { organizationId = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<BillBucket>('needs_review');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'urgent' | 'due' | 'newest'>('urgent');
  const [uploadOpen, setUploadOpen] = useState(false);

  const workbench = useQuery({
    queryKey: ['bills-workbench', organizationId],
    queryFn: () => billsApi.workbench(organizationId),
    enabled: Boolean(organizationId),
    refetchInterval: 30_000,
  });

  const counts = workbench.data?.counts;
  const allBills = workbench.data?.bills ?? [];
  const totalBills = allBills.length;

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = allBills.filter((bill) => {
      if (bill.bucket !== tab) return false;
      if (!q) return true;
      return (
        bill.vendorName.toLowerCase().includes(q)
        || (bill.invoiceNumber ?? '').toLowerCase().includes(q)
      );
    });
    const sorted = [...filtered];
    if (sort === 'urgent') sorted.sort((a, b) => urgencyScore(a) - urgencyScore(b));
    if (sort === 'due') {
      sorted.sort((a, b) => (a.dueAt ? new Date(a.dueAt).getTime() : Infinity) - (b.dueAt ? new Date(b.dueAt).getTime() : Infinity));
    }
    if (sort === 'newest') sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return sorted;
  }, [allBills, tab, search, sort]);

  const openBill = (bill: WorkbenchBill) => {
    if (bill.bucket === 'needs_review') {
      navigate(`/organizations/${organizationId}/bills/${bill.paymentOrderId}/review`);
    } else {
      navigate(`/organizations/${organizationId}/bills/${bill.paymentOrderId}`);
    }
  };

  // The moment the file is stored, the operator is looking at it — the review
  // screen opens immediately and fills in as the document is read.
  const onUploaded = (invoiceDocumentId: string, reused: boolean) => {
    setUploadOpen(false);
    void queryClient.invalidateQueries({ queryKey: ['bills-workbench', organizationId] });
    // Same file again: SAY so — silently opening the old bill reads as the
    // upload having vanished (testbench 001).
    if (reused) toast.info('This exact file is already in Decimal — opening it.', 'Already uploaded');
    navigate(`/organizations/${organizationId}/bills/documents/${invoiceDocumentId}/review`);
  };

  const emptyCopy: Record<BillBucket, string> = {
    needs_review: 'Nothing waiting on a check.',
    in_approval: 'Nothing with the approvers right now.',
    to_pay: 'Nothing cleared and queued to go out.',
    done: 'No paid bills yet.',
    needs_attention: "Nothing stuck — you're clear.",
  };

  return (
    <div className="page page-wide">
      <div className="stack stack-24">
        <PageHead
          eyebrow="Operations"
          title="Bills"
          desc="Everything you've received, from first look to paid."
          actions={
            <button type="button" className="btn btn-primary" onClick={() => setUploadOpen(true)}>
              <Ico.upload w={15} /> Upload a bill
            </button>
          }
        />

        {workbench.isLoading ? (
          <>
            <div className="skeleton" style={{ height: 84 }} />
            <div className="skeleton" style={{ height: 320 }} />
          </>
        ) : totalBills === 0 ? (
          <FirstRun onUpload={() => setUploadOpen(true)} />
        ) : (
          <>
            <div className="metrics" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
              <button
                type="button"
                className={`metric${(counts?.needs_review ?? 0) > 0 ? ' is-alert' : ''}`}
                onClick={() => setTab('needs_review')}
                style={{ cursor: 'pointer', textAlign: 'left' }}
              >
                <div className="m-label">Waiting on you</div>
                <div className="m-value">{counts?.needs_review ?? 0}</div>
                <div className="m-sub">
                  {(workbench.data?.reviewCounts.ready ?? 0) > 0 || (workbench.data?.reviewCounts.missingInfo ?? 0) > 0
                    ? `${workbench.data?.reviewCounts.ready ?? 0} ready for approval · ${workbench.data?.reviewCounts.missingInfo ?? 0} missing info`
                    : 'bills to check before they route'}
                </div>
              </button>
              <div className="metric">
                <div className="m-label">In approval</div>
                <div className="m-value">{counts?.in_approval ?? 0}</div>
                <div className="m-sub">with the approvers</div>
              </div>
              <div className="metric">
                <div className="m-label">To pay</div>
                <div className="m-value">{counts?.to_pay ?? 0}</div>
                <div className="m-sub">cleared and queued</div>
              </div>
              <div className="metric">
                <div className="m-label">Needs attention</div>
                <div className="m-value">{counts?.needs_attention ?? 0}</div>
                <div className="m-sub">stuck or wrong</div>
              </div>
            </div>

            <div className="filterbar">
              <div className="tabs">
                {TABS.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    className={`tab${tab === t.key ? ' on' : ''}`}
                    onClick={() => setTab(t.key)}
                  >
                    {t.label}
                    <span className="tab-count">{counts?.[t.key] ?? 0}</span>
                  </button>
                ))}
              </div>
              <div className="filter-right">
                <input
                  className="input input-search"
                  placeholder="Search vendor or invoice #"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{ width: 220 }}
                />
                <div className="select">
                  <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort">
                    <option value="urgent">Most urgent</option>
                    <option value="due">Due date</option>
                    <option value="newest">Newest</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="tbl-card">
              {rows.length === 0 ? (
                <div className="empty">
                  <span className="empty-icon"><Ico.inbox w={22} /></span>
                  <h4>{emptyCopy[tab]}</h4>
                  <p>Bills move here on their own as they progress.</p>
                </div>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Vendor</th>
                      <th>Invoice</th>
                      <th>Description</th>
                      <th className="num">Amount</th>
                      <th>Due</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((bill) => {
                      const due = dueInfo(bill);
                      return (
                        <tr key={bill.paymentOrderId} onClick={() => openBill(bill)} style={{ cursor: 'pointer' }}>
                          <td>
                            <span className="v-name">{bill.vendorName}</span>
                          </td>
                          <td className="cell-mono">
                            {bill.invoiceNumber ?? '—'}
                            {bill.duplicateCleared ? (
                              <span className="pill pill-min pill-warning" style={{ marginLeft: 8, verticalAlign: 'middle' }}
                                title={`Flagged as a possible duplicate — cleared by ${bill.duplicateCleared.byName}: “${bill.duplicateCleared.reason}”`}>
                                <span className="dot" />Duplicate cleared
                              </span>
                            ) : null}
                          </td>
                          <td style={{ color: 'var(--text-muted)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {bill.description ?? '—'}
                          </td>
                          <td className="td-num">
                            {usd(bill.amountUsd)}
                            {bill.amountOriginal ? (
                              <div style={{ color: 'var(--text-faint)', fontSize: 11.5 }}>
                                {bill.amountOriginal.amount.toLocaleString()} {bill.amountOriginal.currency}
                              </div>
                            ) : null}
                          </td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <span className={due.overdue ? 'due-overdue' : undefined} style={{ fontSize: 13 }}>
                              {due.label}
                            </span>
                            {due.overdue ? (
                              <span className="due-overdue" style={{ fontSize: 12, marginLeft: 8 }}>
                                · {due.overdueDays} day{due.overdueDays === 1 ? '' : 's'} overdue
                              </span>
                            ) : bill.discountLabel ? (
                              <span className="due-chip" style={{ marginLeft: 8 }}>{bill.discountLabel}</span>
                            ) : null}
                          </td>
                          <td>
                            <span className={`dot-status tone-${bill.subStatus.tone}`}>
                              <span className="ds-dot" />
                              {bill.subStatus.blockedBy ? (
                                <span className="ds-avatar">{initialsOf(bill.subStatus.blockedBy.name)}</span>
                              ) : null}
                              {bill.subStatus.text}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>

      {uploadOpen ? (
        <UploadBillDialog
          organizationId={organizationId}
          onClose={() => setUploadOpen(false)}
          onSuccess={onUploaded}
        />
      ) : null}
    </div>
  );
}

// True zero (new org): the empty state IS intake setup — the workbench and
// intake onboarding are the same screen when there's nothing in it.
function FirstRun(props: { onUpload: () => void }) {
  return (
    <section>
      <div
        className="dropzone"
        role="button"
        tabIndex={0}
        onClick={props.onUpload}
        style={{ cursor: 'pointer', minHeight: 220 }}
      >
        <Ico.upload w={34} />
        <span className="dz-main">Drop your first bill here, or click to browse</span>
        <span className="dz-sub">PDF or image · we read it, you confirm it, approvers take it from there</span>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 14 }}>
        You can also forward bills by email — a dedicated address for your team is coming soon.
      </p>
    </section>
  );
}

function UploadBillDialog(props: { organizationId: string; onClose: () => void; onSuccess: (invoiceDocumentId: string, reused: boolean) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    if (!file) return;
    setRunning(true);
    setError(null);
    try {
      const dataBase64 = await fileToBase64(file);
      const { invoiceDocumentId, reused } = await invoiceIntakeApi.uploadAsync(props.organizationId, {
        filename: file.name,
        mimeType: file.type || 'application/pdf',
        dataBase64,
      });
      props.onSuccess(invoiceDocumentId, reused);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      className="overlay"
      style={{ position: 'fixed', inset: 0, zIndex: 60 }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !running) props.onClose();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" style={{ maxWidth: 520 }}>
        <div className="dialog-head">
          <div>
            <h2>Upload a bill</h2>
            <p>{running ? 'Reading the document…' : 'PDF or image. We read it; you confirm what we read.'}</p>
          </div>
          <button type="button" className="drawer-x" onClick={props.onClose} disabled={running} aria-label="Close">×</button>
        </div>
        <div className="dialog-body">
          <div
            className="dropzone"
            data-dragging={isDragging || undefined}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              const dropped = e.dataTransfer?.files?.[0];
              if (dropped) setFile(dropped);
            }}
            onClick={() => document.getElementById('dec-bill-upload-input')?.click()}
            role="button"
            tabIndex={0}
            style={{ cursor: 'pointer' }}
          >
            <input
              id="dec-bill-upload-input"
              type="file"
              accept=".pdf,application/pdf,image/*"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              style={{ display: 'none' }}
            />
            <Ico.upload w={34} />
            {file ? (
              <>
                <span className="dz-main">{file.name}</span>
                <span className="dz-sub">{(file.size / 1024).toFixed(0)} KB · click to swap</span>
              </>
            ) : (
              <>
                <span className="dz-main">Drag a PDF here, or click to browse</span>
                <span className="dz-sub">Up to 10 MB · PDF or image</span>
              </>
            )}
          </div>
          {error ? <p className="input-error" style={{ marginTop: 10 }}>{error}</p> : null}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn btn-secondary" onClick={props.onClose} disabled={running}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={start} disabled={!file || running}>
            {running ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </div>
    </div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('FileReader returned non-string result'));
        return;
      }
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}
