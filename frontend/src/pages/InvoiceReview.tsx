// Invoice review — verify what was read from the document, then send for
// approval (uploads/ap-claude-code-handoff.md §3). Document left, one flat
// field list right, user-resizable split, sticky commit bar.
//
// Design rulings preserved: per-field read markers (no confidence sections),
// resizable split (never fixed %), payment details read-only from this screen.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  accessApi,
  api,
  billsApi,
  invoiceIntakeApi,
  type BillReview,
  type BillReviewField,
  type BillReviewLine,
  type CategoryOption,
  type ConfirmBillBody,
  type DocSource,
} from '../api';
import { Ico } from '../dec/icons';
import { useToast } from '../ui/Toast';

function usd(amount: number): string {
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

type FieldStateMap = Record<string, { value: string; state: BillReviewField['state'] }>;

export function InvoiceReviewPage() {
  const { organizationId = '', paymentOrderId = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const review = useQuery({
    queryKey: ['bill-review', organizationId, paymentOrderId],
    queryFn: () => billsApi.review(organizationId, paymentOrderId),
    enabled: Boolean(organizationId && paymentOrderId),
  });
  // Admin tier decides who may clear a duplicate flag (policy override).
  const myAccess = useQuery({
    queryKey: ['my-access', organizationId],
    queryFn: () => accessApi.get(organizationId),
    enabled: Boolean(organizationId),
    staleTime: 60_000,
  });

  // Prev/next walks the Needs-review queue.
  const workbench = useQuery({
    queryKey: ['bills-workbench', organizationId],
    queryFn: () => billsApi.workbench(organizationId),
    enabled: Boolean(organizationId),
  });
  const queue = useMemo(
    () => (workbench.data?.bills ?? []).filter((b) => b.bucket === 'needs_review').map((b) => b.paymentOrderId),
    [workbench.data],
  );

  if (review.isLoading) {
    return (
      <div className="page page-wide">
        <div className="stack stack-24">
          <div className="skeleton" style={{ height: 44 }} />
          <div className="skeleton" style={{ height: 480 }} />
        </div>
      </div>
    );
  }
  if (!review.data) {
    return (
      <div className="page">
        <div className="empty">
          <span className="empty-icon"><Ico.doc w={22} /></span>
          <h4>Bill not found</h4>
          <p>It may have been removed.</p>
        </div>
      </div>
    );
  }

  return (
    <ReviewScreen
      key={paymentOrderId}
      organizationId={organizationId}
      review={review.data}
      canOverrideDuplicate={Boolean(myAccess.data?.isOwnerOrAdmin)}
      onBack={() => navigate(`/organizations/${organizationId}/bills`)}
      onDone={() => {
        void queryClient.invalidateQueries({ queryKey: ['bills-workbench', organizationId] });
        void queryClient.invalidateQueries({ queryKey: ['bill-review', organizationId, paymentOrderId] });
        const next = queue.find((id) => id !== paymentOrderId);
        if (next) navigate(`/organizations/${organizationId}/bills/${next}/review`);
        else navigate(`/organizations/${organizationId}/bills`);
      }}
      toast={toast}
    />
  );
}

function ReviewScreen(props: {
  organizationId: string;
  review: BillReview;
  canOverrideDuplicate: boolean;
  onBack: () => void;
  onDone: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const { organizationId, review, canOverrideDuplicate, onBack, onDone, toast } = props;
  const readOnly = review.readOnly;
  const queryClient = useQueryClient();

  // Duplicate-flag override: admin asserts "genuinely new", with a logged reason.
  const [dupReasonOpen, setDupReasonOpen] = useState(false);
  const [dupReason, setDupReason] = useState('');
  const [overridingDuplicate, setOverridingDuplicate] = useState(false);
  const clearDuplicate = async () => {
    if (dupReason.trim().length < 3) return;
    setOverridingDuplicate(true);
    try {
      await billsApi.overrideDuplicate(organizationId, review.paymentOrderId, dupReason.trim());
      await queryClient.invalidateQueries({ queryKey: ['bill-review', organizationId, review.paymentOrderId] });
      toast.success('Cleared — your reason is on the bill’s record.', 'Duplicate flag');
      setDupReasonOpen(false);
      setConfirmError(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Try again.', 'Could not clear the flag');
    } finally {
      setOverridingDuplicate(false);
    }
  };

  // --- field state ---------------------------------------------------------
  const [fields, setFields] = useState<FieldStateMap>(() => {
    const map: FieldStateMap = {};
    for (const f of [...review.fields, ...review.remitFields]) {
      map[f.key] = { value: f.value == null ? '' : String(f.value), state: f.state };
    }
    return map;
  });
  const [lines, setLines] = useState<BillReviewLine[]>(() =>
    review.lines.length > 0 ? review.lines : [{ description: '', quantity: 1, unitPrice: null, amount: null, category: null }],
  );
  const [tax, setTax] = useState<string>(review.taxAmount != null ? String(review.taxAmount) : '0');
  const [vendorName, setVendorName] = useState(review.vendor.name);
  const [vendorEmail, setVendorEmail] = useState(review.vendor.email ?? '');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [notABillOpen, setNotABillOpen] = useState(false);
  // Field ↔ document linking: focusing a field highlights where it was read.
  const [activeSource, setActiveSource] = useState<DocSource>(null);

  // Chart of accounts for the category picker — same source and cache as the
  // coding inbox. Falls back to the review packet's options, then to whatever
  // categories the lines already carry, so the list is stable and never
  // shrinks when a selection changes.
  const accountsQuery = useQuery({
    queryKey: ['qbo-accounts', organizationId] as const,
    queryFn: () => api.listQuickBooksAccounts(organizationId),
    enabled: Boolean(organizationId),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  const categoryOptions = useMemo<CategoryOption[]>(() => {
    // Prefer the live chart (full, numbered, grouped like the books); fall back
    // to the review packet's options (builtin chart when QBO isn't connected).
    const fromBooks: CategoryOption[] = (accountsQuery.data?.items ?? []).map((a) => ({
      value: a.fullyQualifiedName ?? a.name,
      label: a.acctNum ? `${a.acctNum} · ${a.fullyQualifiedName ?? a.name}` : (a.fullyQualifiedName ?? a.name),
      group: a.accountType,
    }));
    const seed = fromBooks.length > 0 ? fromBooks : review.categoryOptions;
    // A category already on a line (an older suggestion, or from before a chart
    // change) stays selectable instead of silently disappearing.
    const known = new Set(seed.map((o) => o.value));
    const extras: CategoryOption[] = [];
    for (const line of review.lines) {
      if (line.category && !known.has(line.category)) {
        known.add(line.category);
        extras.push({ value: line.category, label: line.category, num: null, group: 'Suggestions' });
      }
    }
    return [...extras, ...seed];
  }, [accountsQuery.data, review.categoryOptions, review.lines]);

  const setFieldValue = (key: string, value: string) => {
    setFields((prev) => ({
      ...prev,
      // Typing a correction settles the field — the edit is the confirmation.
      [key]: { value, state: prev[key]?.state === 'needs_look' ? 'confirmed' : prev[key]?.state ?? 'read' },
    }));
  };
  const confirmField = (key: string) => {
    setFields((prev) => ({ ...prev, [key]: { value: prev[key]?.value ?? '', state: 'confirmed' } }));
  };

  // --- arithmetic strip ----------------------------------------------------
  const linesTotal = lines.reduce((sum, l) => sum + (l.amount ?? 0), 0);
  const taxNumber = Number(tax) || 0;
  const computedTotal = linesTotal + taxNumber;
  const documentTotal = Number(fields.total?.value) || 0;
  const arithmeticOk = lines.every((l) => !l.description) || Math.abs(computedTotal - documentTotal) < 0.005;

  // --- flags + Tier-1 gate ---------------------------------------------------
  // Approval routes on amount + coded lines: those must exist before sending.
  // Everything else (due date, invoice number, address…) can be filled while
  // the bill is already in approval.
  const blockingFlags = review.flags.filter((f) => f.blocking);
  const realLines = lines.filter((l) => l.description.trim());
  const tier1Gap = documentTotal <= 0
    ? 'Add the total due before sending.'
    : realLines.length === 0
      ? 'Add at least one line item before sending.'
      : (() => {
          const noAmount = realLines.findIndex((l) => l.amount == null);
          if (noAmount >= 0) return `Add an amount to line ${noAmount + 1} before sending.`;
          const noCategory = realLines.findIndex((l) => !l.category);
          if (noCategory >= 0) return `Add a category to line ${noCategory + 1} before sending.`;
          return null;
        })();
  const canConfirm = !readOnly && blockingFlags.length === 0 && !submitting && !tier1Gap;

  // --- commit ---------------------------------------------------------------
  const confirm = useCallback(async () => {
    if (!canConfirm) return;
    setSubmitting(true);
    setConfirmError(null);
    try {
      const body: ConfirmBillBody = {
        fields: {
          vendorName: vendorName.trim() || null,
          vendorEmail: vendorEmail.trim() || null,
          invoiceNumber: fields.invoiceNumber?.value || null,
          invoiceDate: fields.invoiceDate?.value || null,
          dueDate: fields.dueDate?.value || null,
          terms: fields.terms?.value || null,
          poNumber: fields.poNumber?.value || null,
          discount: fields.discount?.value || null,
          currency: fields.currency?.value || 'USD',
          total: documentTotal,
          taxAmount: taxNumber,
          remitTo: {
            street: fields['remitTo.street']?.value || null,
            city: fields['remitTo.city']?.value || null,
            state: fields['remitTo.state']?.value || null,
            zip: fields['remitTo.zip']?.value || null,
          },
        },
        lines: lines
          .filter((l) => l.description.trim())
          .map((l) => ({
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            amount: l.amount,
            category: l.category ?? null,
          })),
        confirmedFieldKeys: Object.entries(fields)
          .filter(([, f]) => f.state === 'confirmed')
          .map(([key]) => key),
        noteForApprovers: note.trim() || null,
      };
      await billsApi.confirm(organizationId, review.paymentOrderId, body);
      toast.success('Sent for approval', 'Recorded exactly as shown on this screen.');
      onDone();
    } catch (err) {
      // A refused confirm needs a PERSISTENT explanation, not just a 5-second
      // toast — the server's message says exactly what to fix (testbench 001
      // saw the refusal vanish entirely).
      setConfirmError(err instanceof Error ? err.message : 'The bill could not be sent. Try again.');
      toast.error('Could not send', err instanceof Error ? err.message : 'Try again.');
    } finally {
      setSubmitting(false);
    }
  }, [canConfirm, fields, lines, documentTotal, taxNumber, note, vendorName, vendorEmail, organizationId, review.paymentOrderId, toast, onDone]);

  // ⌘↵ confirms.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void confirm();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirm]);

  // --- resizable split ------------------------------------------------------
  const shellRef = useRef<HTMLDivElement>(null);
  const [panelPct, setPanelPct] = useState(38);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent) {
      const rect = shellRef.current?.getBoundingClientRect();
      if (!rect) return;
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setPanelPct(Math.min(70, Math.max(28, 100 - pct)));
    }
    function onUp() { setDragging(false); }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  return (
    <div className="rev-shell" ref={shellRef}>
      {/* Topbar */}
      <div className="topbar">
        <div className="tb-context">
          <button type="button" className="btn btn-ghost tb-back" onClick={onBack}>
            <Ico.chevLeft w={15} /> Bills
          </button>
        </div>

      </div>

      {/* Split: read panel LEFT, document RIGHT (matches the approved mock). */}
      <div className="rev-split">
        <div className="rev-panel" style={{ width: `${100 - panelPct}%` }}>
          <div className="stack stack-20">
            {/* The bill's major facts, as the heading */}
            <div className="rev-head">
              <div>
                <h1>{fields.invoiceNumber?.value || vendorName}</h1>
                <div className="rh-sub">{vendorName}</div>
              </div>
              <div className="rh-amount">{usd(documentTotal)}</div>
            </div>

            {/* Sent back by an approver — the reviewer's homework, above all flags */}
            {review.sentBack ? (
              <div className="callout callout-warning">
                <Ico.reset w={16} />
                <span>
                  <b>{review.sentBack.byName ?? 'An approver'} sent this bill back{review.sentBack.reason ? ':' : '.'}</b>
                  {review.sentBack.reason ? ` “${review.sentBack.reason}”` : ''} Fix it below and confirm again — it will go through approval fresh.
                </span>
              </div>
            ) : null}

            {/* A refused confirm stays on screen until the next attempt. A
                duplicate refusal carries the same admin affordance as the
                flag banner — no dead ends (testbench 002 §3). */}
            {confirmError ? (
              <div className="callout callout-danger" data-testid="confirm-error">
                <Ico.shield w={16} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  {confirmError}
                  {/duplicate/i.test(confirmError) && !canOverrideDuplicate
                    ? ' Change the invoice number if this is a distinct bill, or ask an admin.'
                    : null}
                  {/duplicate/i.test(confirmError) && canOverrideDuplicate && dupReasonOpen ? (
                    <span style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <input className="input" value={dupReason} autoFocus placeholder="Why is it not a duplicate? Goes on the record."
                        onChange={(e) => setDupReason(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void clearDuplicate(); }}
                        style={{ flex: 1, minWidth: 0, height: 32 }} />
                      <button type="button" className="btn btn-primary btn-sm" style={{ flex: 'none' }}
                        disabled={overridingDuplicate || dupReason.trim().length < 3} onClick={() => void clearDuplicate()}>
                        {overridingDuplicate ? 'Clearing…' : 'Clear flag'}
                      </button>
                    </span>
                  ) : null}
                </span>
                {/duplicate/i.test(confirmError) && canOverrideDuplicate && !dupReasonOpen ? (
                  <button type="button" className="btn btn-secondary btn-sm" style={{ flex: 'none' }} onClick={() => setDupReasonOpen(true)}>
                    Not a duplicate
                  </button>
                ) : null}
              </div>
            ) : null}

            {/* Flags outrank ambers */}
            {review.flags.map((flag) => (
              <div
                key={flag.kind}
                className={`callout ${flag.severity === 'danger' ? 'callout-danger' : flag.severity === 'warning' ? 'callout-warning' : 'callout-info'}`}
              >
                <Ico.shield w={16} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  {flag.message}
                  {flag.kind === 'possible_duplicate' && flag.blocking && canOverrideDuplicate && dupReasonOpen ? (
                    <span style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <input className="input" value={dupReason} autoFocus placeholder="Why is it not a duplicate? Goes on the record."
                        onChange={(e) => setDupReason(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void clearDuplicate(); }}
                        style={{ flex: 1, minWidth: 0, height: 32 }} />
                      <button type="button" className="btn btn-primary btn-sm" style={{ flex: 'none' }}
                        disabled={overridingDuplicate || dupReason.trim().length < 3} onClick={() => void clearDuplicate()}>
                        {overridingDuplicate ? 'Clearing…' : 'Clear flag'}
                      </button>
                    </span>
                  ) : null}
                </span>
                {flag.kind === 'possible_duplicate' && flag.blocking && canOverrideDuplicate && !dupReasonOpen ? (
                  <button type="button" className="btn btn-secondary btn-sm" style={{ flex: 'none' }} onClick={() => setDupReasonOpen(true)}>
                    Not a duplicate
                  </button>
                ) : null}
              </div>
            ))}

            {/* Vendor */}
            <section>
              <div className="sec-head">
                <div className="sh-titles">
                  <h2>Vendor</h2>
                  <p className="sh-desc">
                    {review.vendor.isNew
                      ? 'First bill from this vendor — payment details go through verification.'
                      : 'A vendor you already pay.'}
                  </p>
                </div>
              </div>
              <div className="rev-grid" style={{ gridTemplateColumns: '1fr 1fr', marginBottom: 16 }}>
                <div className="rev-field">
                  <span className="field-label">Vendor name</span>
                  <input
                    className="input"
                    value={vendorName}
                    disabled={readOnly}
                    onFocus={() => setActiveSource(review.vendor.nameSource ?? null)}
                    onChange={(e) => setVendorName(e.target.value)}
                  />
                </div>
                <div className="rev-field">
                  <span className="field-label">Email</span>
                  <input
                    className="input"
                    value={vendorEmail}
                    disabled={readOnly}
                    placeholder="Not on document"
                    onFocus={() => setActiveSource(review.vendor.emailSource ?? null)}
                    onChange={(e) => setVendorEmail(e.target.value)}
                  />
                </div>
              </div>
              <div className="rev-grid" style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr' }}>
                {review.remitFields.map((f) => (
                  <ReviewField
                    key={f.key}
                    def={f}
                    current={fields[f.key]!}
                    readOnly={readOnly}
                    onChange={(v) => setFieldValue(f.key, v)}
                    onConfirm={() => confirmField(f.key)}
                    onFocusField={() => setActiveSource(f.source ?? null)}
                  />
                ))}
              </div>
            </section>

            {/* Bill details — one flat list */}
            <section>
              <div className="sec-head">
                <div className="sh-titles">
                  <h2>Bill details</h2>
                  <p className="sh-desc">
                    {review.fields.some((f) => f.state === 'needs_look') && !readOnly
                      ? 'A few fields need a look — confirm or correct them.'
                      : 'Everything checks out.'}
                  </p>
                </div>
              </div>
              <div className="rev-grid">
                {review.fields.map((f) => (
                  <ReviewField
                    key={f.key}
                    def={f}
                    current={fields[f.key]!}
                    readOnly={readOnly}
                    onChange={(v) => setFieldValue(f.key, v)}
                    onConfirm={() => confirmField(f.key)}
                    onFocusField={() => setActiveSource(f.source ?? null)}
                  />
                ))}
              </div>
            </section>

            {/* Lines */}
            <section>
              <div className="sec-head">
                <div className="sh-titles">
                  <h2>Line items</h2>
                </div>
                {!readOnly ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setLines((prev) => [...prev, { description: '', quantity: 1, unitPrice: null, amount: null, category: null }])}
                  >
                    <Ico.plus w={14} /> Add a line
                  </button>
                ) : null}
              </div>
              <div className="tbl-card">
                <table className="tbl tbl-slim">
                  <thead>
                    <tr>
                      <th>Description</th>
                      <th className="num" style={{ width: 52 }}>Qty</th>
                      <th className="num" style={{ width: 116 }}>Unit</th>
                      <th style={{ width: 220 }}>Category</th>
                      <th className="num" style={{ width: 130 }}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, i) => (
                      <tr key={i} onFocus={() => setActiveSource(line.source ?? null)}>
                        <td>
                          <input
                            className="tbl-input"
                            value={line.description}
                            disabled={readOnly}
                            placeholder="What is this for?"
                            onChange={(e) => setLines((prev) => prev.map((l, j) => (j === i ? { ...l, description: e.target.value } : l)))}
                          />
                        </td>
                        <td>
                          <input
                            className="tbl-input td-num"
                            value={line.quantity ?? ''}
                            disabled={readOnly}
                            onChange={(e) => setLines((prev) => prev.map((l, j) => (j === i ? { ...l, quantity: e.target.value === '' ? null : Number(e.target.value) } : l)))}
                          />
                        </td>
                        <td>
                          <MoneyInput
                            value={line.unitPrice}
                            disabled={readOnly}
                            onChange={(v) => setLines((prev) => prev.map((l, j) => (j === i ? { ...l, unitPrice: v } : l)))}
                          />
                        </td>
                        <td>
                          <AccountPicker
                            value={line.category ?? ''}
                            options={categoryOptions}
                            disabled={readOnly}
                            onChange={(v) => setLines((prev) => prev.map((l, j) => (j === i ? { ...l, category: v || null } : l)))}
                          />
                        </td>
                        <td>
                          <MoneyInput
                            value={line.amount}
                            disabled={readOnly}
                            onChange={(v) => setLines((prev) => prev.map((l, j) => (j === i ? { ...l, amount: v } : l)))}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  {/* Totals sit exactly under Amount; the arithmetic check sits
                      beside them, not on its own row (per the design). */}
                  <tfoot>
                    <tr
                      onClick={() => setActiveSource(review.totalsSources?.lineItems ?? null)}
                      style={review.totalsSources?.lineItems ? { cursor: 'pointer' } : undefined}
                    >
                      <td colSpan={3} rowSpan={3} className="arith-cell">
                        <span className={`arith-note${arithmeticOk ? '' : ' bad'}`}>
                          {arithmeticOk ? <Ico.checkSm w={13} /> : null}
                          {arithmeticOk
                            ? "Adds up to the document's total"
                            : `Document says ${usd(documentTotal)} · lines add to ${usd(computedTotal)}`}
                        </span>
                      </td>
                      <td className="lt-label">Line items</td>
                      <td className="td-num">{usd(linesTotal)}</td>
                    </tr>
                    <tr onFocus={() => setActiveSource(review.totalsSources?.tax ?? null)}>
                      <td className="lt-label">Tax</td>
                      <td>
                        <MoneyInput value={taxNumber} disabled={readOnly} onChange={(v) => setTax(v == null ? '' : String(v))} />
                      </td>
                    </tr>
                    <tr
                      className="grand"
                      onClick={() => setActiveSource(review.totalsSources?.total ?? null)}
                      style={review.totalsSources?.total ? { cursor: 'pointer' } : undefined}
                    >
                      <td className="lt-label">Total</td>
                      <td className="td-num">{usd(computedTotal)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>

            {!readOnly ? (
              <div className="field">
                <span className="field-label">Note for approvers (optional)</span>
                <input
                  className="input"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="One line of context that rides along with the bill"
                  maxLength={500}
                />
              </div>
            ) : review.verification ? (
              <div className="callout">
                <Ico.checkSm w={16} />
                <span>
                  Confirmed and sent for approval
                  {review.verification.confirmedAt ? ` on ${new Date(review.verification.confirmedAt).toLocaleDateString()}` : ''}.
                  {review.verification.noteForApprovers ? ` Note: "${review.verification.noteForApprovers}"` : ''}
                </span>
              </div>
            ) : null}
          </div>
        </div>

        <div
          className={`rev-divider${dragging ? ' dragging' : ''}`}
          onMouseDown={(e) => { e.preventDefault(); setDragging(true); }}
          role="separator"
          aria-orientation="vertical"
        />

        <DocumentPane
          organizationId={organizationId}
          document={review.document}
          activeSource={activeSource}
          width={`${panelPct}%`}
        />
      </div>

      {/* Commit bar */}
      {!readOnly ? (
        <div className="commit-bar">
          <button type="button" className="btn btn-ghost" onClick={() => setNotABillOpen(true)}>
            This isn't a bill
          </button>
          <span className="cb-note">
            {blockingFlags.length > 0
              ? 'Resolve the flagged issue above before sending.'
              : tier1Gap ?? 'Recorded with exactly what you see on this screen.'}
          </span>
          <span className="commit-spacer" />
          <button type="button" className="btn btn-secondary" onClick={onBack}>Save for later</button>
          <button type="button" className="btn btn-primary" disabled={!canConfirm} onClick={() => void confirm()}>
            {submitting ? 'Sending…' : 'Confirm & send for approval'}
          </button>
        </div>
      ) : null}

      {notABillOpen ? (
        <NotABillDialog
          organizationId={organizationId}
          paymentOrderId={review.paymentOrderId}
          onClose={() => setNotABillOpen(false)}
          onDone={() => { setNotABillOpen(false); onDone(); }}
          toast={toast}
        />
      ) : null}
    </div>
  );
}

// Money cell: the $ is part of the value ("$2,650.00"), right-aligned as one
// unit; parses loosely while typing, formats on blur.
function MoneyInput(props: { value: number | null; disabled: boolean; onChange: (v: number | null) => void }) {
  const { value, disabled, onChange } = props;
  const [text, setText] = useState(value == null ? '' : usd(value));
  return (
    <input
      className="tbl-input td-num"
      value={text}
      disabled={disabled}
      placeholder="$0.00"
      onChange={(e) => {
        const cleaned = e.target.value.replace(/[^0-9.]/g, '');
        setText(cleaned === '' ? '' : `$${cleaned}`);
        onChange(cleaned === '' ? null : Number(cleaned));
      }}
      onBlur={() => {
        const n = Number(text.replace(/[^0-9.]/g, ''));
        setText(text === '' || Number.isNaN(n) ? '' : usd(n));
      }}
    />
  );
}

// Category is picked from the org's chart of accounts, never typed. A value
// that isn't in the chart (older suggestion, disconnected books) still shows
// as a choice so it isn't silently dropped.
// Design-system account picker (the Ramp pattern): a select-look trigger that
// opens a searchable, scrollable, grouped list — account name with its number
// beneath. Fixed-positioned so table/panel overflow can't clip it.
function AccountPicker(props: {
  value: string;
  options: CategoryOption[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { value, options, disabled, onChange } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const all = value && !options.some((o) => o.value === value)
    ? [{ value, label: value, num: null, group: 'Suggestions' }, ...options]
    : options;
  const q = query.trim().toLowerCase();
  const filtered = q
    ? all.filter((o) => o.label.toLowerCase().includes(q) || (o.num ?? '').toLowerCase().includes(q))
    : all;
  const groups: Array<{ group: string; items: Array<{ option: CategoryOption; index: number }> }> = [];
  filtered.forEach((option, index) => {
    const bucket = groups.find((g) => g.group === option.group);
    if (bucket) bucket.items.push({ option, index });
    else groups.push({ group: option.group, items: [{ option, index }] });
  });

  const openPicker = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const height = 340;
    const openUp = rect.bottom + height + 8 > window.innerHeight && rect.top - height - 8 > 0;
    setPos({
      left: Math.min(rect.left, window.innerWidth - 308),
      top: openUp ? Math.max(8, rect.top - height - 4) : rect.bottom + 4,
    });
    setQuery('');
    setActiveIndex(0);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    function onDown(e: MouseEvent) {
      if (popRef.current?.contains(e.target as Node)) return;
      if (triggerRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    // Fixed positioning goes stale when the panel scrolls — just close.
    function onScroll(e: Event) {
      if (popRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };
  const selected = all.find((o) => o.value === value) ?? null;

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="picker-trigger"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openPicker())}
      >
        <span className={`pt-label${selected ? '' : ' placeholder'}`}>
          {selected ? (selected.num ? `${selected.num} · ${selected.label}` : selected.label) : 'Pick an account'}
        </span>
        <Ico.chevDown w={12} />
      </button>
      {open && pos ? (
        <div className="picker-pop" ref={popRef} style={{ left: pos.left, top: pos.top }} role="listbox">
          <div className="picker-search">
            <Ico.search w={14} />
            <input
              ref={searchRef}
              value={query}
              placeholder="Search accounts"
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActiveIndex((i) => Math.max(i - 1, 0));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  const target = filtered[activeIndex];
                  if (target) pick(target.value);
                }
              }}
            />
          </div>
          <div className="picker-list">
            {filtered.length === 0 ? (
              <div className="picker-empty">No account matches "{query}".</div>
            ) : (
              groups.map((g) => (
                <div key={g.group}>
                  <div className="picker-group">{g.group}</div>
                  {g.items.map(({ option, index }) => (
                    <button
                      type="button"
                      key={option.value}
                      className={`picker-item${option.value === value ? ' on' : ''}${index === activeIndex ? ' active' : ''}`}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => pick(option.value)}
                    >
                      <span className="pi-name">{option.label}</span>
                      {option.num ? <span className="pi-num">{option.num}</span> : null}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}

function ReviewField(props: {
  def: BillReviewField;
  current: { value: string; state: BillReviewField['state'] };
  readOnly: boolean;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onFocusField?: () => void;
}) {
  const { def, current, readOnly, onChange, onConfirm, onFocusField } = props;
  const needsLook = current.state === 'needs_look';
  return (
    <div className="rev-field">
      <span className="field-label">{def.label}</span>
      <input
        className={`input${needsLook ? ' is-look' : ''}`}
        value={current.value}
        disabled={readOnly}
        placeholder={current.state === 'not_on_document' ? 'Not on document' : undefined}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocusField}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && needsLook) {
            e.preventDefault();
            onConfirm();
          }
        }}
      />
      {/* Green sparkle = read cleanly by AI; amber = double-check (with inline
          Confirm); green check = confirmed by a human. Empty fields carry only
          the placeholder. */}
      {current.state === 'confirmed' ? (
        <span className="ftag is-confirmed"><Ico.checkSm w={11} /> Confirmed by you</span>
      ) : needsLook ? (
        <span className="ftag is-look">
          {def.reason ?? 'Needs a look'} ·{' '}
          {!readOnly ? (
            <button type="button" className="ftag-btn" onClick={onConfirm}>Confirm</button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

// Zoom is relative to the pane: 100% = the page fits the pane width exactly.
// ±10 points per click; every step visibly changes the render.
const ZOOM_MIN_PCT = 50;
const ZOOM_MAX_PCT = 300;

// The document rendered as clean page images — never a PDF viewer.
export function DocumentPane(props: {
  organizationId: string;
  document: BillReview['document'] | null;
  // While processing, the caller passes a live pagesStored count so pages
  // appear as soon as they exist.
  pagesStored?: number;
  // Where the focused field was read from — highlighted on the page.
  activeSource?: DocSource;
  // Pane width within the split (the wrapper owns it now).
  width: string;
}) {
  const { organizationId, document: doc, activeSource, width } = props;
  const [pageUrls, setPageUrls] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);
  const [zoomPct, setZoomPct] = useState(100);
  const knownPages = props.pagesStored ?? doc?.pageCount ?? 0;
  const pageRefs = useRef<Array<HTMLDivElement | null>>([]);

  // Bring the highlighted region into view when focus moves.
  useEffect(() => {
    if (!activeSource) return;
    const el = pageRefs.current[activeSource.page - 1];
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [activeSource]);

  useEffect(() => {
    if (!doc || knownPages <= 0) return;
    let cancelled = false;
    const urls: string[] = [];
    (async () => {
      try {
        for (let i = 0; i < knownPages; i += 1) {
          const url = await invoiceIntakeApi.fetchPageObjectUrl(organizationId, doc.invoiceDocumentId, i);
          if (cancelled) {
            URL.revokeObjectURL(url);
            return;
          }
          urls.push(url);
          setPageUrls([...urls]);
        }
      } catch {
        if (!cancelled && urls.length === 0) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [organizationId, doc?.invoiceDocumentId, knownPages]);

  const zoomBy = (delta: number) => setZoomPct((p) => Math.min(ZOOM_MAX_PCT, Math.max(ZOOM_MIN_PCT, p + delta)));
  const resetView = () => {
    setZoomPct(100);
    pageRefs.current[0]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  let content: React.ReactNode;
  if (!doc) {
    content = (
      <div className="empty" style={{ margin: 'auto' }}>
        <span className="empty-icon"><Ico.doc w={22} /></span>
        <h4>No document on file</h4>
        <p>This bill was created before documents were stored.</p>
      </div>
    );
  } else if (failed) {
    content = (
      <div className="empty" style={{ margin: 'auto' }}>
        <span className="empty-icon"><Ico.doc w={22} /></span>
        <h4>Couldn't load the document</h4>
        <p>{doc.filename}</p>
      </div>
    );
  } else if (pageUrls.length === 0) {
    content = <div className="skeleton" style={{ width: '100%', maxWidth: 620, aspectRatio: '8.5 / 11' }} />;
  } else {
    content = (
    <>
      {pageUrls.map((url, i) => (
        <div
          key={i}
          className="doc-page"
          ref={(el) => { pageRefs.current[i] = el; }}
          style={{ width: `${zoomPct}%` }}
        >
          <img src={url} alt={`${doc.filename} — page ${i + 1}`} />
          {activeSource && activeSource.page - 1 === i ? (
            <div
              className="doc-hl"
              style={{
                left: `${activeSource.box[0] * 100}%`,
                top: `${activeSource.box[1] * 100}%`,
                width: `${Math.max(activeSource.box[2] * 100, 1.5)}%`,
                height: `${Math.max(activeSource.box[3] * 100, 1)}%`,
              }}
            />
          ) : null}
        </div>
      ))}
    </>
    );
  }

  return (
    <div className="rev-doc-wrap" style={{ width }}>
      {doc ? (
        <div className="doc-head">
          <div className="dh-file">
            <Ico.doc w={15} />
            <span className="dh-name">{doc.filename}</span>
            {knownPages > 0 ? (
              <span className="kbd">{knownPages} page{knownPages === 1 ? '' : 's'}</span>
            ) : null}
          </div>
          <div className="dh-zoom">
            <button type="button" className="btn btn-icon btn-sm" aria-label="Zoom out" onClick={() => zoomBy(-10)} disabled={zoomPct <= ZOOM_MIN_PCT}>
              <Ico.minus w={13} />
            </button>
            <span className="dh-pct">{zoomPct}%</span>
            <button type="button" className="btn btn-icon btn-sm" aria-label="Zoom in" onClick={() => zoomBy(10)} disabled={zoomPct >= ZOOM_MAX_PCT}>
              <Ico.plus w={13} />
            </button>
            <button type="button" className="btn btn-icon btn-sm" aria-label="Fit to view" onClick={resetView}>
              <Ico.expand w={12} />
            </button>
          </div>
        </div>
      ) : null}
      <div className="rev-doc">{content}</div>
    </div>
  );
}

// Live intake: the operator lands here the moment the upload finishes. The
// document shows immediately; the read panel fills in when the read completes.
export function DocumentReviewPage() {
  const { organizationId = '', invoiceDocumentId = '' } = useParams();
  const navigate = useNavigate();

  const status = useQuery({
    queryKey: ['invoice-document-status', organizationId, invoiceDocumentId],
    queryFn: () => invoiceIntakeApi.status(organizationId, invoiceDocumentId),
    enabled: Boolean(organizationId && invoiceDocumentId),
    // Poll until a TERMINAL state — and keep polling in background/agent-driven
    // tabs (React Query pauses intervals for "hidden" tabs by default, which
    // left the skeleton up long after extraction finished — testbench 002 §1).
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s === 'processed' || s === 'failed' ? false : 1200;
    },
    refetchIntervalInBackground: true,
    staleTime: 0,
  });

  const data = status.data;

  // Read complete → swap to the real review of the first created bill.
  useEffect(() => {
    if (data?.status === 'processed' && data.paymentOrders[0]) {
      navigate(
        `/organizations/${organizationId}/bills/${data.paymentOrders[0].paymentOrderId}/review`,
        { replace: true },
      );
    }
  }, [data?.status, data?.paymentOrders, navigate, organizationId]);

  const docForPane = data
    ? {
        invoiceDocumentId: data.invoiceDocumentId,
        filename: data.filename,
        mimeType: data.mimeType,
        byteSize: 0,
        pageCount: data.pageCount,
      }
    : null;

  return (
    <div className="rev-shell">
      <div className="topbar">
        <div className="tb-context">
          <button
            type="button"
            className="btn btn-ghost tb-back"
            onClick={() => navigate(`/organizations/${organizationId}/bills`)}
          >
            <Ico.chevLeft w={15} /> Bills
          </button>
        </div>
        <div className="tb-right">
          {data?.status === 'processing' ? (
            <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Reading the document…</span>
          ) : null}
        </div>
      </div>
      <div className="rev-split">
        <div className="rev-panel" style={{ width: '62%' }}>
          {data?.status === 'failed' ? (
            <div className="stack stack-20">
              <div className="callout callout-danger">
                <Ico.shield w={16} />
                <span>
                  We couldn't turn this document into a bill.
                  {data.processingError ? ` ${data.processingError}` : ''}
                </span>
              </div>
              <div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => navigate(`/organizations/${organizationId}/bills`)}
                >
                  Back to bills
                </button>
              </div>
            </div>
          ) : (
            <div className="stack stack-20" aria-busy="true">
              <div className="skeleton" style={{ height: 68 }} />
              <div className="rev-grid">
                {Array.from({ length: 8 }, (_, i) => (
                  <div key={i} className="rev-field">
                    <div className="skeleton" style={{ height: 12, width: '60%' }} />
                    <div className="skeleton" style={{ height: 36 }} />
                  </div>
                ))}
              </div>
              <div className="skeleton" style={{ height: 160 }} />
              <p style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                Reading the document — the fields fill in as soon as we're done.
              </p>
            </div>
          )}
        </div>
        <div className="rev-divider" role="separator" aria-orientation="vertical" />
        <DocumentPane
          organizationId={organizationId}
          document={docForPane}
          pagesStored={data?.pagesStored}
          width="38%"
        />
      </div>
    </div>
  );
}

function NotABillDialog(props: {
  organizationId: string;
  paymentOrderId: string;
  onClose: () => void;
  onDone: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [reason, setReason] = useState<'duplicate' | 'statement' | 'not_ours' | 'unreadable' | 'other'>('duplicate');
  const [detail, setDetail] = useState('');
  const [running, setRunning] = useState(false);

  const reasons: Array<{ key: typeof reason; label: string }> = [
    { key: 'duplicate', label: "It's a duplicate of a bill we already have" },
    { key: 'statement', label: "It's a statement or receipt, not an invoice" },
    { key: 'not_ours', label: "It isn't ours to pay" },
    { key: 'unreadable', label: "It can't be read" },
    { key: 'other', label: 'Something else' },
  ];

  const submit = async () => {
    setRunning(true);
    try {
      await billsApi.notABill(props.organizationId, props.paymentOrderId, { reason, note: detail.trim() || null });
      props.toast.success('Removed from the queue', "It won't be paid.");
      props.onDone();
    } catch (err) {
      props.toast.error('Could not remove', err instanceof Error ? err.message : 'Try again.');
      setRunning(false);
    }
  };

  return (
    <div
      className="overlay"
      style={{ position: 'fixed', inset: 0, zIndex: 60 }}
      onClick={(e) => { if (e.target === e.currentTarget && !running) props.onClose(); }}
    >
      <div className="dialog" role="dialog" aria-modal="true" style={{ maxWidth: 480 }}>
        <div className="dialog-head">
          <div>
            <h2>This isn't a bill</h2>
            <p>Tell us why — it comes out of the queue and won't be paid.</p>
          </div>
          <button type="button" className="drawer-x" onClick={props.onClose} disabled={running} aria-label="Close">×</button>
        </div>
        <div className="dialog-body">
          <div className="check-list">
            {reasons.map((r) => (
              <button
                key={r.key}
                type="button"
                className={`check-item${reason === r.key ? ' on' : ''}`}
                onClick={() => setReason(r.key)}
              >
                <span className="check-box">{reason === r.key ? <Ico.checkSm w={11} /> : null}</span>
                <span className="ci-name">{r.label}</span>
              </button>
            ))}
          </div>
          <div className="field" style={{ marginTop: 14 }}>
            <span className="field-label">Anything else? (optional)</span>
            <input className="input" value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={500} />
          </div>
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn btn-secondary" onClick={props.onClose} disabled={running}>Cancel</button>
          <button type="button" className="btn btn-danger" onClick={submit} disabled={running}>
            {running ? 'Removing…' : 'Remove from queue'}
          </button>
        </div>
      </div>
    </div>
  );
}
