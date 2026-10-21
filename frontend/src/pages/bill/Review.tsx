// A bill in review (5a): the header, Decimal's box, the facts as boxes, the
// line items and History on the left; the document on the right, behind a
// hairline that drags; the bar along the bottom with what still stands
// between the bill and approval. Every change saves itself a moment later.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { billsApi, type BillCompanionNote, type BillDetail, type ConfirmBillBody, type DocSource } from '../../api';
import { useToaster } from '../../kit/Toast';
import { calendarDay, daysPast, usd } from '../../kit/format';
import { AgentBox } from './AgentBox';
import { DocPane, Separator, useDocWidth } from './DocPane';
import { FieldBox, lookOf } from './Fields';
import type { Access, OpenCard } from './Findings';
import { History } from './History';
import { LineItems } from './Lines';
import {
  DETAIL_FIELDS,
  DISCOUNT_FIELD,
  VENDOR_FIELDS,
  bodyOf,
  closeReasonFor,
  fieldsFrom,
  findingsOf,
  headerOf,
  linesFrom,
  linesSum,
  newLineId,
  parseMoney,
  sendGap,
  type Face,
  type FieldDef,
  type Fields,
  type LineEntry,
} from './model';

const CHIP_CLASS = {
  yours: 'is-yours',
  checked: 'is-checked',
  blocking: 'is-blocking',
  warning: 'is-warning',
  waiting: 'is-waiting',
  finished: 'is-finished',
} as const;

export function Review({
  organizationId,
  detail,
  note,
  viewer,
  access,
  onRefetch,
}: {
  organizationId: string;
  detail: BillDetail;
  note: BillCompanionNote | null | undefined;
  viewer: Face;
  access: Access;
  onRefetch: () => Promise<unknown>;
}) {
  const draft = detail.draft;
  const billId = draft.paymentOrderId;
  const toaster = useToaster();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const editable = draft.state === 'draft' && !draft.readOnly;
  const noteForApprovers = draft.verification?.noteForApprovers ?? null;

  const [fields, setFields] = useState<Fields>(() => fieldsFrom(draft));
  const [lines, setLines] = useState<LineEntry[]>(() => linesFrom(draft));
  const [card, setCard] = useState<OpenCard | null>(null);
  const [spot, setSpot] = useState<DocSource>(null);
  const [lineInHand, setLineInHand] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'failed'>('saved');
  const [sending, setSending] = useState(false);
  const [closeTip, setCloseTip] = useState(false);

  const body = useMemo(() => bodyOf(fields, lines, noteForApprovers), [fields, lines, noteForApprovers]);
  const bodyText = JSON.stringify(body);
  // What the server holds, as this page would send it. Edits since are unsaved.
  const lastSaved = useRef(JSON.stringify(bodyOf(fieldsFrom(draft), linesFrom(draft), noteForApprovers)));
  const chain = useRef<Promise<void>>(Promise.resolve());

  const refreshAround = async () => {
    await Promise.all([
      onRefetch(),
      queryClient.invalidateQueries({ queryKey: ['bills-workbench', organizationId] }),
      queryClient.invalidateQueries({ queryKey: ['inbox', organizationId] }),
    ]);
  };

  const save = (next: ConfirmBillBody) => {
    const text = JSON.stringify(next);
    chain.current = chain.current.then(async () => {
      if (text === lastSaved.current) return;
      setSaveState('saving');
      try {
        await billsApi.saveDraft(organizationId, billId, next);
        lastSaved.current = text;
        setSaveState('saved');
        await onRefetch();
      } catch {
        setSaveState('failed');
      }
    });
    return chain.current;
  };

  // A moment after the last change, the page saves itself.
  useEffect(() => {
    if (!editable || bodyText === lastSaved.current) return;
    setSaveState('saving');
    const timer = window.setTimeout(() => void save(body), 3000);
    return () => window.clearTimeout(timer);
    // `body` and `save` follow `bodyText`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bodyText, editable]);

  // Read again (after a save, a finding settled, someone else's change): take
  // the server's version whenever nothing here is waiting to be saved.
  useEffect(() => {
    if (bodyText !== lastSaved.current) return;
    const nextFields = fieldsFrom(draft);
    setFields(nextFields);
    setLines((prev) => {
      const next = linesFrom(draft);
      return next.map((l, i) => ({ ...l, id: prev[i]?.id ?? l.id }));
    });
    lastSaved.current = JSON.stringify(bodyOf(nextFields, linesFrom(draft), noteForApprovers));
    // Only a new draft from the server starts this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  // Arriving from the chat with a spot to look at.
  useEffect(() => {
    const focus = searchParams.get('focus');
    if (!focus) return;
    const el = document.querySelector(`[data-focus="${CSS.escape(focus)}"]`);
    el?.scrollIntoView({ block: 'center' });
    if (focus.startsWith('field:')) setSpot(fields[focus.slice(6)]?.source ?? null);
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rowRef = useRef<HTMLDivElement | null>(null);
  const doc = useDocWidth(rowRef);

  const header = headerOf(detail, fields);
  const findings = findingsOf(draft);
  const tax = parseMoney(fields.taxAmount?.value) ?? 0;
  const total = parseMoney(fields.total?.value);
  const itemised = Math.round((linesSum(lines) + tax) * 100) / 100;
  const figuresWrong = draft.flags.some((f) => f.blocking && (f.kind === 'lines_do_not_sum' || f.kind === 'total_does_not_reconcile'));
  const gap = editable ? sendGap(draft, fields, lines) : null;
  const dueDay = fields.dueDate?.value && /^\d{4}-\d{2}-\d{2}/.test(fields.dueDate.value) ? fields.dueDate.value : null;
  const late = dueDay !== null && header.stage !== 'done' && daysPast(dueDay) > 0;

  const edit = (key: string, value: string) => {
    setFields((f) => ({ ...f, [key]: { ...(f[key] ?? { reason: null, inferred: false, source: null }), value, state: 'confirmed' } }));
  };
  const confirmField = (key: string) => {
    setFields((f) => (f[key] ? { ...f, [key]: { ...f[key]!, state: 'confirmed' } } : f));
  };
  const byOf = (key: string): Face | null => {
    const entry = fields[key];
    if (entry?.state !== 'confirmed') return null;
    return draft.confirmedBy?.[key] ?? viewer;
  };

  const box = (def: FieldDef) => {
    const entry = fields[def.key];
    const wrong = def.key === 'total' && figuresWrong;
    const diff = total !== null ? Math.round((total - itemised) * 100) / 100 : 0;
    return (
      <FieldBox
        key={def.key}
        def={def}
        entry={entry}
        look={lookOf(entry, { wrong })}
        by={byOf(def.key)}
        wrongNote={wrong && diff !== 0 ? <span><span className="num">{usd(Math.abs(diff))}</span> {diff > 0 ? 'more' : 'less'} than its lines</span> : undefined}
        editable={editable}
        onEdit={(v) => edit(def.key, v)}
        onConfirm={() => confirmField(def.key)}
        onFocus={() => setSpot(def.key === 'total' ? entry?.source ?? draft.totalsSources.total : entry?.source ?? null)}
      />
    );
  };

  const fixTotal = async (to: number) => {
    const next: Fields = { ...fields, total: { ...(fields.total ?? { reason: null, inferred: false, source: null }), value: String(to), state: 'confirmed' } };
    setFields(next);
    await save(bodyOf(next, lines, noteForApprovers));
  };

  const send = async () => {
    if (sending) return;
    setSending(true);
    try {
      await chain.current;
      await billsApi.confirm(organizationId, billId, body);
      lastSaved.current = bodyText;
      toaster.show('Sent for approval.');
      await refreshAround();
    } catch (e) {
      toaster.show(e instanceof Error ? e.message : 'It couldn’t be sent. Try again.');
    } finally {
      setSending(false);
    }
  };

  const closeBill = () => {
    if (!access.isAdmin) return;
    const closable = findings.find((f) => f.resolutions.some((r) => r.action === 'not_ours'));
    setCard({ kind: 'close', reason: closable ? closeReasonFor(closable.kind) : 'other', note: '' });
  };

  const detailDefs = [...DETAIL_FIELDS, ...(fields.discount?.value ? [DISCOUNT_FIELD] : [])];
  const title = fields.invoiceNumber?.value.trim() || draft.vendor.name || draft.document?.filename || 'A bill';

  return (
    <>
      <div className="bp-body" ref={rowRef}>
        <div className="bp-panel">
          <div className="bp-head">
            <div style={{ minWidth: 0 }}>
              <h1 className="bp-title">{title}</h1>
              <div className="bp-status">
                <span>{fields['vendor.name']?.value || draft.vendor.name}</span>
                <span className="bp-dot">·</span>
                <span className="bp-stage">{header.stageText}</span>
                {header.chip ? (
                  <>
                    <span className="bp-dot">·</span>
                    <span className={`chip ${CHIP_CLASS[header.chip.tone]}`}>{header.chip.text}</span>
                  </>
                ) : null}
              </div>
            </div>
            <div className="bp-amount">
              {total !== null && total > 0 ? <span className="bp-total">{usd(total)}</span> : null}
              {dueDay ? (
                <span className={`bp-due${late ? ' is-late' : ''}`}>Due <span className="num">{calendarDay(dueDay)}</span></span>
              ) : null}
            </div>
          </div>

          <AgentBox
            organizationId={organizationId}
            detail={detail}
            note={note}
            fields={fields}
            lines={lines}
            viewer={viewer}
            access={access}
            editable={editable}
            card={card}
            setCard={setCard}
            onFixTotal={fixTotal}
            onSaveNow={() => save(body)}
            onChanged={refreshAround}
          />

          <div className="bp-sec is-first">
            <div className="bp-sec-head"><div className="bp-sec-title">Vendor</div></div>
            <div className="bp-fields is-vendor">{VENDOR_FIELDS.map(box)}</div>
          </div>
          <div className="bp-sec">
            <div className="bp-sec-head"><div className="bp-sec-title">Bill details</div></div>
            <div className="bp-fields is-details">{detailDefs.map(box)}</div>
          </div>
          <div className="bp-sec">
            <LineItems
              lines={lines}
              tax={tax}
              total={total}
              vendorName={fields['vendor.name']?.value || draft.vendor.name}
              options={draft.categoryOptions}
              editable={editable}
              wrongTotal={figuresWrong}
              viewer={viewer}
              highlighted={lineInHand}
              onChange={(id, patch) => setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)))}
              onRemove={(id) => setLines((ls) => ls.filter((l) => l.id !== id))}
              onAdd={() => setLines((ls) => [...ls, { id: newLineId(), description: '', quantity: '1', unitPrice: '', amount: '', category: null, from: null, settledBy: null, source: null }])}
              onFocusLine={(l) => {
                setLineInHand(l.id);
                setSpot(l.source);
              }}
              onFocusTotals={() => setSpot(draft.totalsSources.total)}
            />
          </div>
          <div className="bp-sec">
            <History detail={detail} note={note} />
          </div>
        </div>
        <Separator rowRef={rowRef} width={doc.width} setWidth={doc.setWidth} />
        <DocPane organizationId={organizationId} document={draft.document} source={spot} width={doc.width} />
      </div>

      <div className="bp-foot">
        {editable ? (
          <span className={`bp-saved${saveState === 'failed' ? ' is-failed' : ''}`}>
            {saveState === 'saved' ? <><b>✓</b> All changes saved</> : saveState === 'saving' ? 'Saving…' : 'Couldn’t save. It will try again with your next change.'}
          </span>
        ) : (
          <span className="bp-foot-note">
            {draft.state === 'draft' && draft.readOnlyReason === 'not_your_job'
              ? 'Only the people who check bills can change it.'
              : detail.status.subStatus.text}
          </span>
        )}
        <span className="bp-foot-gap" />
        {editable ? (
          <>
            <span className="bp-tipwrap" onMouseEnter={() => setCloseTip(true)} onMouseLeave={() => setCloseTip(false)}>
              <button type="button" className="btn is-quiet" aria-disabled={!access.isAdmin} onClick={closeBill}>
                Close this bill
              </button>
              {closeTip && !access.isAdmin ? <span className="tip">Only an admin can do this. Ask one to look.</span> : null}
            </span>
            {gap ? <span className="bp-foot-note">{gap}</span> : null}
            <button type="button" className="btn is-primary" disabled={Boolean(gap) || sending} onClick={() => void send()}>
              Send for approval
            </button>
          </>
        ) : null}
      </div>
    </>
  );
}
