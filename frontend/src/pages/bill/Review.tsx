// A bill in review (5a): the header, Decimal's box, the facts as boxes, the
// line items and History on the left; the document on the right, behind a
// hairline that drags; the bar along the bottom with what still stands
// between the bill and approval. Every change saves itself a moment later.
//
// The same page while Decimal reads the bill (5r): its parts land in order as
// the reading arrives, and nothing can be changed or sent until it's done. And
// a bill nothing could be read from (5u): every box says "Not read", the file
// sits faded, and the person removes it or enters the details by hand. And a
// bill sent back (5e): the route it came back by, and why, above Decimal's box.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { billsApi, type BillCompanionNote, type BillDetail, type ConfirmBillBody, type DocSource } from '../../api';
import { Avatar } from '../../kit/Avatar';
import { useToaster } from '../../kit/Toast';
import { ago, calendarDay, daysPast, fileSize, stamp, usd } from '../../kit/format';
import { AgentBox } from './AgentBox';
import { Chain, chainOf } from './Chain';
import { DocPane, Separator, useDocWidth } from './DocPane';
import { FieldBox, lookOf } from './Fields';
import type { Access, OpenCard } from './Findings';
import { History } from './History';
import { LineItems } from './Lines';
import { Figures } from './parts';
import {
  DETAIL_FIELDS,
  DISCOUNT_FIELD,
  VENDOR_FIELDS,
  landsAt,
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
  type ChipTone,
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
  reading,
  onRefetch,
}: {
  organizationId: string;
  detail: BillDetail;
  note: BillCompanionNote | null | undefined;
  viewer: Face;
  access: Access;
  /** While Decimal reads the bill, the tick its landing has reached (5r); null once read. */
  reading: number | null;
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
  const [byHand, setByHand] = useState(false);

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

  const isReading = reading !== null;
  const landed = (key: string) => reading === null || reading >= landsAt(key);
  // Nothing changes while Decimal is still reading: its reading would land on top.
  const canEdit = editable && !isReading;
  const unreadable = draft.unreadable;
  const typedAny = Object.values(fields).some((f) => f.state === 'confirmed') || lines.some((l) => l.description.trim());
  // Until somebody starts typing, a bill nothing could be read from says so.
  const couldntRead = unreadable && !isReading && !byHand && !typedAny;
  const filename = draft.document?.filename ?? null;
  const arrived = detail.history.before.find((h) => h.kind === 'uploaded' || h.kind === 'forwarded') ?? null;
  const arrivedBy = arrived?.person ? ` by ${arrived.person.name}` : '';
  const arrivedVerb = arrived?.kind === 'forwarded' ? 'Forwarded' : 'Uploaded';

  const header = headerOf(detail, fields);
  const chip: { text: string; tone: ChipTone } | null = couldntRead ? { text: 'Couldn’t be read', tone: 'blocking' }
    // Typed in by hand, nothing about it is "checked" yet.
    : unreadable && header.chip?.tone === 'checked' ? { text: 'Needs a check', tone: 'yours' }
    // Sent back is the reviewer's to act on; for anyone else it only waits.
    : header.chip?.text === 'Sent back' && !editable ? { text: 'Sent back', tone: 'waiting' }
    : header.chip;

  // Sent back (5e): the route it came back by, and the reason, above Decimal's box.
  const sentBack = draft.sentBack;
  const backStep = detail.approval?.steps.find((s) => s.state === 'declined' && s.person) ?? null;
  const backNodes = useMemo(() => (sentBack && backStep ? chainOf(detail, { sentBack: true }) : []), [detail, sentBack, backStep]);
  const backBy: Face | null = !sentBack ? null
    : backStep?.person && (!sentBack.byName || backStep.person.name === sentBack.byName) ? { name: backStep.person.name, avatarUrl: backStep.person.avatarUrl }
    : sentBack.byName ? { name: sentBack.byName, avatarUrl: null }
    : null;
  const youSentItBack = Boolean(sentBack && (backStep?.person?.personId === detail.viewer.personId || sentBack.byName === detail.viewer.name));
  const sentBefore = [...detail.history.before, ...detail.history.after].some((h) => h.kind === 'submitted');
  const routeBack = sentBack && backBy ? (
    <div className="bp-route is-back">
      {backNodes.length > 0 ? <Chain nodes={backNodes} /> : null}
      <div className="bp-route-said">
        <Avatar name={backBy.name} src={backBy.avatarUrl} size={14} />
        {sentBack.reason ? <><b>{backBy.name}:</b> <Figures text={sentBack.reason} /></> : <><b>{backBy.name}</b> sent it back.</>}
      </div>
    </div>
  ) : null;
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
        look={!landed(def.key) ? 'reading' : unreadable ? lookOf(entry, { unread: true }) : lookOf(entry, { wrong })}
        by={byOf(def.key)}
        wrongNote={wrong && diff !== 0 ? <span><span className="num">{usd(Math.abs(diff))}</span> {diff > 0 ? 'more' : 'less'} than its lines</span> : undefined}
        editable={canEdit}
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
    setCard({ kind: 'close', reason: unreadable ? 'unreadable' : closable ? closeReasonFor(closable.kind) : 'other', note: '' });
  };

  const startByHand = () => {
    setByHand(true);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLInputElement>('[data-focus="field:vendor.name"] input')?.focus();
    });
  };

  const detailDefs = [...DETAIL_FIELDS, ...(fields.discount?.value ? [DISCOUNT_FIELD] : [])];
  const number = fields.invoiceNumber?.value.trim() ?? '';
  // A file's name until its invoice number is known: while it's read, and when it couldn't be.
  const showFile = (isReading || unreadable) && filename !== null && !(number && landed('invoiceNumber'));
  const title = showFile ? filename : number || draft.vendor.name || filename || 'A bill';
  const vendorText = isReading && !landed('vendor.name') ? 'New bill'
    : fields['vendor.name']?.value || (unreadable ? 'New bill' : draft.vendor.name);

  const lead = isReading ? { text: `Extracting the details from ${filename ?? 'the document'}.`, working: true }
    : couldntRead ? { text: `I couldn’t read ${filename ?? 'this document'}, so nothing here is filled in and nothing was guessed. Enter the details by hand and I’ll check them.`, working: false }
    // Typing it in: what it found about a placeholder vendor would only mislead.
    : unreadable && !draft.flags.some((f) => f.blocking) ? { text: `I couldn’t read ${filename ?? 'this document'}, so the details are yours to type in. I’ll check them once they’re in.`, working: false }
    : null;

  return (
    <>
      <div className="bp-body" ref={rowRef}>
        <div className="bp-panel">
          <div className="bp-head">
            <div style={{ minWidth: 0 }}>
              <h1 className={`bp-title${showFile ? ' is-file' : ''}`}>{title}</h1>
              {couldntRead ? (
                <div className="bp-status">
                  <span>
                    {arrived?.at ? `${arrivedVerb} ${stamp(arrived.at)}${arrivedBy}` : arrivedVerb}
                    {draft.document?.pageCount ? ` · ${draft.document.pageCount} ${draft.document.pageCount === 1 ? 'page' : 'pages'}` : ''}
                    {draft.document?.byteSize ? ` · ${fileSize(draft.document.byteSize)}` : ''}
                  </span>
                  <span className="bp-dot">·</span>
                  <span className={`chip ${CHIP_CLASS[chip!.tone]}`}>{chip!.text}</span>
                </div>
              ) : (
                <div className="bp-status">
                  <span>{vendorText}</span>
                  <span className="bp-dot">·</span>
                  <span className={`bp-stage${isReading ? ' is-reading' : ''}`}>{isReading ? 'Extracting' : header.stageText}</span>
                  {chip && !isReading ? (
                    <>
                      <span className="bp-dot">·</span>
                      <span className={`chip ${CHIP_CLASS[chip.tone]}`}>{chip.text}</span>
                    </>
                  ) : null}
                </div>
              )}
            </div>
            {isReading ? (
              <div className="bp-amount">
                {total !== null && total > 0 && landed('total') ? <span className="bp-total">{usd(total)}</span> : <span className="bp-total-reading" />}
                <span className="bp-due">{arrived?.at ? `${arrivedVerb} ${ago(arrived.at)}${arrivedBy}` : `${arrivedVerb}${arrivedBy}`}</span>
              </div>
            ) : couldntRead ? null : (
              <div className="bp-amount">
                {total !== null && total > 0 ? <span className="bp-total">{usd(total)}</span> : null}
                {dueDay ? (
                  <span className={`bp-due${late ? ' is-late' : ''}`}>Due <span className="num">{calendarDay(dueDay)}</span></span>
                ) : null}
              </div>
            )}
          </div>

          <AgentBox
            organizationId={organizationId}
            detail={detail}
            note={note}
            fields={fields}
            lines={lines}
            viewer={viewer}
            access={access}
            editable={canEdit}
            card={card}
            setCard={setCard}
            onFixTotal={fixTotal}
            onSaveNow={() => save(body)}
            onChanged={refreshAround}
            lead={lead}
            above={isReading || couldntRead ? null : routeBack}
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
              editable={canEdit}
              wrongTotal={figuresWrong}
              viewer={viewer}
              highlighted={lineInHand}
              reading={reading}
              emptyText={unreadable ? 'None read' : undefined}
              bare={couldntRead}
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
          {isReading || couldntRead ? null : (
            <div className="bp-sec">
              <History detail={detail} note={note} />
            </div>
          )}
        </div>
        <Separator rowRef={rowRef} width={doc.width} setWidth={doc.setWidth} />
        <DocPane organizationId={organizationId} document={draft.document} source={spot} width={doc.width} faint={couldntRead} />
      </div>

      {isReading ? (
        <div className="bp-foot">
          <span className="bp-saved">Extracting…</span>
          <span className="bp-foot-gap" />
          {editable ? (
            <>
              <span className="bp-foot-note">Once the details are in</span>
              <button type="button" className="btn is-primary" disabled>Send for approval</button>
            </>
          ) : null}
        </div>
      ) : couldntRead ? (
        <div className="bp-foot">
          <span className="bp-saved">Nothing read</span>
          <span className="bp-foot-gap" />
          {editable ? (
            <>
              <span className="tip-wrap" onMouseEnter={() => setCloseTip(true)} onMouseLeave={() => setCloseTip(false)}>
                <button type="button" className="btn is-quiet-red" aria-disabled={!access.isAdmin} onClick={closeBill}>
                  Not a bill? Remove this file
                </button>
                {closeTip && !access.isAdmin ? <span className="tip">Only an admin can do this. Ask one to look.</span> : null}
              </span>
              <button type="button" className="btn" onClick={startByHand}>Enter the details by hand</button>
            </>
          ) : null}
        </div>
      ) : (
      <div className="bp-foot">
        {editable ? (
          <span className={`bp-saved${saveState === 'failed' ? ' is-failed' : ''}`}>
            {saveState === 'saved' ? <><b>✓</b> All changes saved</> : saveState === 'saving' ? 'Saving…' : 'Couldn’t save. It will try again with your next change.'}
          </span>
        ) : (
          <span className="bp-foot-note">
            {youSentItBack ? 'You sent it back for review'
              : draft.state === 'draft' && draft.readOnlyReason === 'not_your_job'
                ? 'Only the people who check bills can change it.'
                : detail.status.subStatus.text}
          </span>
        )}
        <span className="bp-foot-gap" />
        {editable ? (
          <>
            <span className="tip-wrap" onMouseEnter={() => setCloseTip(true)} onMouseLeave={() => setCloseTip(false)}>
              <button type="button" className="btn is-quiet" aria-disabled={!access.isAdmin} onClick={closeBill}>
                Close this bill
              </button>
              {closeTip && !access.isAdmin ? <span className="tip">Only an admin can do this. Ask one to look.</span> : null}
            </span>
            {gap ? <span className="bp-foot-note">{gap}</span> : null}
            <button type="button" className="btn is-primary" disabled={Boolean(gap) || sending} onClick={() => void send()}>
              {sentBefore ? 'Send for approval again' : 'Send for approval'}
            </button>
          </>
        ) : null}
      </div>
      )}
    </>
  );
}
