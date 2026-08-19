// Bills workbench — the operator's home (uploads/ap-claude-code-handoff.md §2).
// A triage surface: five lifecycle tabs over one bills query, urgency-sorted,
// rows routing to the draft screen or detail (everything else).
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { accessApi, billsApi, inboundEmailApi, invoiceIntakeApi, type BillBucket, type WorkbenchBill } from '../api';
import { Ico } from '../dec/icons';
import { PageHead } from '../dec/primitives';
import { useToast } from '../ui/Toast';

const TABS: Array<{ key: BillBucket; label: string }> = [
  { key: 'draft', label: 'Draft' },
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
  // A Viewer may read every bill and bring none in — so the two buttons that
  // create one are hidden rather than offered and refused.
  const myAccess = useQuery({
    queryKey: ['my-access', organizationId],
    queryFn: () => accessApi.get(organizationId),
    enabled: Boolean(organizationId),
    staleTime: 60_000,
  });
  const canAddBills = myAccess.data ? myAccess.data.capabilities.includes('bills.create') : true;
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<BillBucket>('draft');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'urgent' | 'due' | 'newest'>('urgent');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [forwardOpen, setForwardOpen] = useState(false);

  const workbench = useQuery({
    queryKey: ['bills-workbench', organizationId],
    queryFn: () => billsApi.workbench(organizationId),
    enabled: Boolean(organizationId),
    // A document being read turns into a bill in seconds, not half a minute.
    // Waiting 30s to notice makes the row look stuck at exactly the moment
    // somebody is watching it.
    refetchInterval: (q) => ((q.state.data?.pending.length ?? 0) > 0 ? 2_000 : 30_000),
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
    if (bill.bucket === 'draft') {
      navigate(`/organizations/${organizationId}/bills/${bill.paymentOrderId}/draft`);
    } else {
      navigate(`/organizations/${organizationId}/bills/${bill.paymentOrderId}`);
    }
  };

  // The moment the file is stored, the operator is looking at it — the draft
  // screen opens immediately and fills in as the document is read.
  // Several at once: they are all on this list now, and opening one of six
  // would be an odd thing to do with the other five. Reading runs behind the
  // upload, so the rows fill in as the extractions land.
  const onUploadedMany = (uploaded: number, failed: number) => {
    setUploadOpen(false);
    void queryClient.invalidateQueries({ queryKey: ['bills-workbench', organizationId] });
    setTab('draft');
    if (failed > 0) {
      toast.error(`${failed} of ${uploaded + failed} could not be uploaded`, `${uploaded} went through and ${uploaded === 1 ? 'is' : 'are'} being read.`);
    } else {
      toast.success(`${uploaded} bills uploaded`, 'Reading them now — the rows fill in as each one is read.');
    }
  };

  const onUploaded = (invoiceDocumentId: string, reused: boolean) => {
    setUploadOpen(false);
    void queryClient.invalidateQueries({ queryKey: ['bills-workbench', organizationId] });
    // Same file again: SAY so — silently opening the old bill reads as the
    // upload having vanished (testbench 001).
    if (reused) toast.info('This exact file is already in Decimal — opening it.', 'Already uploaded');
    navigate(`/organizations/${organizationId}/bills/documents/${invoiceDocumentId}/draft`);
  };

  const emptyCopy: Record<BillBucket, string> = {
    draft: 'Nothing waiting on a check.',
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
            canAddBills ? (
              <>
                <button type="button" className="btn btn-secondary" onClick={() => setForwardOpen(true)}>
                  <Ico.mail w={15} /> Forward by email
                </button>
                <button type="button" className="btn btn-primary" onClick={() => setUploadOpen(true)}>
                  <Ico.upload w={15} /> Upload a bill
                </button>
              </>
            ) : null
          }
        />

        {workbench.isLoading ? (
          <>
            <div className="skeleton" style={{ height: 84 }} />
            <div className="skeleton" style={{ height: 320 }} />
          </>
        ) : totalBills === 0 ? (
          <FirstRun onUpload={() => setUploadOpen(true)} organizationId={organizationId} />
        ) : (
          <>
            <div className="metrics" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
              <button
                type="button"
                className={`metric${(counts?.draft ?? 0) > 0 ? ' is-alert' : ''}`}
                onClick={() => setTab('draft')}
                style={{ cursor: 'pointer', textAlign: 'left' }}
              >
                <div className="m-label">Waiting on you</div>
                <div className="m-value">{counts?.draft ?? 0}</div>
                <div className="m-sub">
                  {(workbench.data?.draftCounts.ready ?? 0) > 0 || (workbench.data?.draftCounts.missingInfo ?? 0) > 0
                    ? `${workbench.data?.draftCounts.ready ?? 0} ready for approval · ${workbench.data?.draftCounts.missingInfo ?? 0} missing info`
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
                    {/* Being read. Shown first because they are the newest
                        thing in the pile and the thing somebody just did. */}
                    {tab === 'draft' ? (workbench.data?.pending ?? []).map((doc) => (
                      <tr
                        key={doc.invoiceDocumentId}
                        onClick={() => navigate(`/organizations/${organizationId}/bills/documents/${doc.invoiceDocumentId}/draft`)}
                        style={{ cursor: 'pointer' }}
                      >
                        <td>
                          <div className="cell-vendor">
                            <span className="v-name" style={{ color: 'var(--text-muted)' }}>
                              {doc.status === 'failed' ? 'Could not be read' : 'Reading…'}
                            </span>
                          </div>
                        </td>
                        <td className="cell-mono" style={{ color: 'var(--text-faint)' }}>—</td>
                        <td style={{ color: 'var(--text-muted)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {doc.filename}
                        </td>
                        <td className="td-num" style={{ color: 'var(--text-faint)' }}>—</td>
                        <td style={{ color: 'var(--text-faint)' }}>—</td>
                        <td>
                          <span className={`pill pill-min ${doc.status === 'failed' ? 'pill-danger' : 'pill-info'}`}
                            title={doc.error ?? undefined}>
                            <span className="dot" />
                            {doc.status === 'failed' ? 'Read failed' : 'Reading'}
                          </span>
                        </td>
                      </tr>
                    )) : null}
                    {rows.map((bill) => {
                      const due = dueInfo(bill);
                      return (
                        <tr key={bill.paymentOrderId} onClick={() => openBill(bill)} style={{ cursor: 'pointer' }}>
                          <td>
                            {/* cell-vendor is the name+sub stack; v-name/v-sub
                                are scoped to it and render unstyled without it. */}
                            <div className="cell-vendor">
                              <span className="v-name">{bill.vendorName}</span>
                              {/* Who brought the bill in is deliberately NOT
                                  here. The queue is for picking what to open
                                  next — vendor and amount decide that. The
                                  attribution lives on the bill itself, where
                                  the question actually gets asked. */}
                            </div>
                          </td>
                          <td className="cell-mono">
                            {bill.invoiceNumber ?? '—'}
                            {bill.duplicateCleared ? (
                              <span className="pill pill-min pill-warning" style={{ marginLeft: 8, verticalAlign: 'middle' }}
                                title={`Flagged as a possible duplicate — cleared by ${bill.duplicateCleared.byName}: “${bill.duplicateCleared.reason}”`}>
                                <span className="dot" />Duplicate cleared
                              </span>
                            ) : null}
                            {/* A question routed to this reader. It used to appear
                                only under Approvals, so one asked while the bill
                                was still a draft reached nobody. */}
                            {bill.questionForYou ? (
                              <span className="pill pill-min pill-info" style={{ marginLeft: 8, verticalAlign: 'middle' }}
                                title={`${bill.questionForYou.askedByName ?? 'Someone'} asked you: “${bill.questionForYou.question}”`}>
                                <span className="dot" />Asked of you
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
          onManySuccess={onUploadedMany}
        />
      ) : null}

      {forwardOpen ? (
        <ForwardByEmailDialog organizationId={organizationId} onClose={() => setForwardOpen(false)} />
      ) : null}
    </div>
  );
}

// True zero (new org): the empty state IS intake setup — the workbench and
// intake onboarding are the same screen when there's nothing in it.
function FirstRun(props: { onUpload: () => void; organizationId: string }) {
  const address = useQuery({
    queryKey: ['inbound-email-address', props.organizationId],
    queryFn: () => inboundEmailApi.address(props.organizationId),
  });

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
      {address.data?.enabled && address.data.address ? (
        <div className="field" style={{ marginTop: 18 }}>
          <span className="field-label">Or forward bills to</span>
          <AddressCopyRow address={address.data.address} />
          <p className="input-help" style={{ marginTop: 8 }}>
            Anyone on your team can forward a bill here. We read it and it lands in this list.
          </p>
        </div>
      ) : null}
    </section>
  );
}

// The address plus a Copy button — the Members invite-link pattern.
function AddressCopyRow(props: { address: string }) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error('Copy failed', 'Select the address and copy it manually.');
    }
  };
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <input
        className="input"
        readOnly
        value={props.address}
        onFocus={(e) => e.currentTarget.select()}
        style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12 }}
      />
      <button type="button" className="btn btn-primary" onClick={copy} style={{ flex: 'none' }}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

// Always-available affordance, so the address stays findable once the workbench
// has bills in it. A dialog, not a panel — the playbook is explicit that
// reveals overlay rather than reflow.
function ForwardByEmailDialog(props: { organizationId: string; onClose: () => void }) {
  const address = useQuery({
    queryKey: ['inbound-email-address', props.organizationId],
    queryFn: () => inboundEmailApi.address(props.organizationId),
  });
  const ignored = useQuery({
    queryKey: ['inbound-email-messages', props.organizationId],
    queryFn: () => inboundEmailApi.messages(props.organizationId),
    // Admin-only endpoint; members simply don't get the list.
    retry: false,
  });

  const ignoredItems = (ignored.data?.items ?? []).filter((m) => m.disposition === 'rejected').slice(0, 10);

  return (
    <div
      className="overlay"
      style={{ position: 'fixed', inset: 0, zIndex: 61 }}
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" style={{ maxWidth: 560 }}>
        <div className="dialog-head">
          <div>
            <h2>Forward bills by email</h2>
            <p>Send invoices straight into your drafts.</p>
          </div>
          <button type="button" className="drawer-x" onClick={props.onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="dialog-body">
          {address.data?.enabled && address.data.address ? (
            <>
              <div className="field">
                <span className="field-label">Your address</span>
                <AddressCopyRow address={address.data.address} />
                <p className="input-help" style={{ marginTop: 8 }}>
                  Only people on your team can send here. Mail from anyone else is ignored.
                </p>
              </div>
              {ignoredItems.length > 0 ? (
                <div className="field" style={{ marginTop: 18 }}>
                  <span className="field-label">Recently ignored</span>
                  <div className="tbl-card">
                    <table className="tbl tbl-slim">
                      <thead>
                        <tr>
                          <th>From</th>
                          <th>Subject</th>
                          <th>Why</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ignoredItems.map((m) => (
                          <tr key={m.inboundEmailMessageId}>
                            <td>{m.from}</td>
                            <td style={{ color: 'var(--text-muted)' }}>{m.subject ?? '—'}</td>
                            <td style={{ color: 'var(--text-muted)' }}>{m.reason ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <div className="empty">
              <h4>Not set up yet</h4>
              <p>Email intake isn't switched on for this workspace.</p>
            </div>
          )}
        </div>
        <div className="dialog-foot" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-secondary" onClick={props.onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Bills arrive in a stack, not one at a time.
 *
 * The dialog took a single file, so putting six invoices in meant six trips
 * through open-drag-upload-wait-navigate-back. Nothing about the intake path
 * required that: uploadAsync stores one document and returns immediately, with
 * extraction running behind it, so N files is N calls and the reading overlaps
 * with the next upload.
 *
 * Sequential rather than parallel. Each file is base64 in memory and up to
 * 10MB, and six at once is six copies plus six extractions competing for the
 * same model — slower in practice, and a queue that reports "3 of 6" is easier
 * to trust than six spinners.
 */
type UploadState = 'waiting' | 'uploading' | 'done' | 'failed';

function UploadBillDialog(props: {
  organizationId: string;
  onClose: () => void;
  /** One file: open it, as before. */
  onSuccess: (invoiceDocumentId: string, reused: boolean) => void;
  /** Several: stay on the list, which is where they now all are. */
  onManySuccess: (uploaded: number, failed: number) => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, UploadState>>({});

  const key = (f: File) => `${f.name}:${f.size}`;
  const add = (incoming: FileList | null) => {
    if (!incoming) return;
    const next = [...incoming];
    setFiles((prev) => {
      const seen = new Set(prev.map(key));
      // The same file picked twice is a slip, not a request for two bills.
      return [...prev, ...next.filter((f) => !seen.has(key(f)))];
    });
  };

  const start = async () => {
    if (files.length === 0) return;
    setRunning(true);
    setError(null);
    let uploaded = 0;
    let failed = 0;
    let lastId: string | null = null;
    let lastReused = false;

    for (const file of files) {
      setStatus((p) => ({ ...p, [key(file)]: 'uploading' }));
      try {
        const dataBase64 = await fileToBase64(file);
        const res = await invoiceIntakeApi.uploadAsync(props.organizationId, {
          filename: file.name,
          mimeType: file.type || 'application/pdf',
          dataBase64,
        });
        lastId = res.invoiceDocumentId;
        lastReused = res.reused;
        uploaded += 1;
        setStatus((p) => ({ ...p, [key(file)]: 'done' }));
      } catch {
        // One bad file must not strand the other five. It is marked and the
        // queue carries on; the count at the end says what happened.
        failed += 1;
        setStatus((p) => ({ ...p, [key(file)]: 'failed' }));
      }
    }

    setRunning(false);
    if (failed > 0 && uploaded === 0) {
      setError(files.length === 1 ? 'Upload failed.' : 'None of those could be uploaded.');
      return;
    }
    if (uploaded === 1 && failed === 0 && lastId) {
      props.onSuccess(lastId, lastReused);
      return;
    }
    props.onManySuccess(uploaded, failed);
  };

  const many = files.length > 1;
  const doneCount = Object.values(status).filter((v) => v === 'done').length;

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
            <h2>{many ? `Upload ${files.length} bills` : 'Upload a bill'}</h2>
            <p>
              {running
                ? many ? `Uploading ${doneCount} of ${files.length}…` : 'Reading the document…'
                : 'PDFs or images. We read them; you confirm what we read.'}
            </p>
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
              add(e.dataTransfer?.files ?? null);
            }}
            onClick={() => document.getElementById('dec-bill-upload-input')?.click()}
            role="button"
            tabIndex={0}
            style={{ cursor: 'pointer' }}
          >
            <input
              id="dec-bill-upload-input"
              type="file"
              multiple
              accept=".pdf,application/pdf,image/*"
              onChange={(e) => { add(e.target.files); e.currentTarget.value = ''; }}
              style={{ display: 'none' }}
            />
            <Ico.upload w={34} />
            {files.length > 0 ? (
              <>
                <span className="dz-main">{files.length === 1 ? files[0]!.name : `${files.length} documents`}</span>
                <span className="dz-sub">
                  {(files.reduce((n, f) => n + f.size, 0) / 1024).toFixed(0)} KB total · click to add more
                </span>
              </>
            ) : (
              <>
                <span className="dz-main">Drag PDFs here, or click to browse</span>
                <span className="dz-sub">Up to 10 MB each · PDF or image · several at once</span>
              </>
            )}
          </div>

          {files.length > 0 ? (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {files.map((f) => {
                const st = status[key(f)] ?? 'waiting';
                return (
                  <div key={key(f)} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>
                      {f.name}
                    </span>
                    {st === 'done' ? (
                      <span className="pill pill-min pill-success"><span className="dot" />uploaded</span>
                    ) : st === 'failed' ? (
                      <span className="pill pill-min pill-danger"><span className="dot" />failed</span>
                    ) : st === 'uploading' ? (
                      <span className="pill pill-min pill-info"><span className="dot" />uploading</span>
                    ) : (
                      <button type="button" className="btn btn-ghost btn-sm" disabled={running}
                        onClick={() => setFiles((prev) => prev.filter((x) => key(x) !== key(f)))}>
                        Remove
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}

          {error ? <p className="input-error" style={{ marginTop: 10 }}>{error}</p> : null}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn btn-secondary" onClick={props.onClose} disabled={running}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={start} disabled={files.length === 0 || running}>
            {running
              ? many ? `Uploading ${doneCount} of ${files.length}…` : 'Uploading…'
              : many ? `Upload ${files.length} bills` : 'Upload'}
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
