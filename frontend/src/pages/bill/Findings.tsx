// What Decimal found on a bill and the ways to settle it (5a, 28*, 29*, 41a):
// the finding in a sentence with its evidence under it, the ways to settle it
// as pills (the recommended one filled, the ones you may not take greyed with
// a note), and the white confirmation card each way opens in the
// conversation. Nothing here acts on its own: the card's button does.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { BillDraft } from '../../api';
import { usd } from '../../kit/format';
import { CLOSE_REASONS, closeReasonFor, type CloseReason, type Flag } from './model';
import { Chevron, Figures, Mark } from './parts';

export type Action = Flag['resolutions'][number]['action'];
export type Access = { isAdmin: boolean; isPrimary: boolean; canEdit: boolean; worksOnBills: boolean };

/** A confirmation card in the conversation: settling a finding, or closing the bill. */
export type OpenCard =
  | { kind: 'finding'; flagKind: string; action: Action; targetId?: string }
  | { kind: 'close'; reason: CloseReason; note: string };

export type Pill = {
  key: string;
  label: string;
  action: Action;
  targetId?: string;
  allowed: boolean;
  why: string | null;
  recommended: boolean;
};

const NO_PILL = new Set<Action>(['ask_someone']);
const PAYMENT_FLAGS = new Set(['payee_mismatch', 'unreadable_payment_details']);

function labelFor(flag: Flag, action: Action, label: string) {
  if (action === 'not_ours') {
    if (flag.kind === 'possible_duplicate') return 'Close as a duplicate';
    if (flag.kind === 'looks_like_statement') return 'Close as a statement';
    if (flag.kind === 'looks_like_credit_note') return 'Close as a credit note';
    return 'Close as not ours';
  }
  if (action === 'pay_the_lines') return 'Use the itemised total';
  if (action === 'raise_ceiling') return 'Review the limit';
  return label;
}

export function recommendedOf(flag: Flag): Action | null {
  const fromFinding = flag.finding?.status === 'ready' ? flag.finding.recommended?.action : null;
  if (fromFinding) return fromFinding as Action;
  const fromBrief = flag.brief?.status === 'ready' ? flag.brief.recommendedAction : null;
  if (fromBrief === 'not_ours' || fromBrief === 'clear_duplicate') return fromBrief;
  return null;
}

export function pillsFor(flag: Flag, access: Access): Pill[] {
  const recommended = recommendedOf(flag);
  return flag.resolutions
    .filter((r) => !NO_PILL.has(r.action) && !(r.action === 'fix_fields' && PAYMENT_FLAGS.has(flag.kind)))
    .map((r) => {
      const allowed = r.requires === 'primary_admin' ? access.isPrimary
        : r.requires === 'admin' ? access.isAdmin
        : access.canEdit;
      return {
        key: `${flag.kind}:${r.action}:${r.targetId ?? ''}`,
        label: labelFor(flag, r.action, r.label),
        action: r.action,
        targetId: r.targetId,
        allowed,
        why: allowed ? null
          : r.requires === 'primary_admin' ? 'Only the primary admin can do this.'
          : r.requires === 'admin' ? 'Only an admin can do this. Ask one to look.'
          : 'Only someone who checks bills can do this.',
        recommended: recommended === r.action,
      };
    });
}

export function ActionPills({ pills, open, small, onPick }: {
  pills: Pill[];
  open: string | null;
  small?: boolean;
  onPick: (pill: Pill) => void;
}) {
  const [tip, setTip] = useState<string | null>(null);
  return (
    <>
      {pills.map((p) => (
        <button
          key={p.key}
          type="button"
          className={`bp-act${small ? ' is-small' : ''}${!p.allowed ? ' is-off' : p.recommended && open !== p.key ? ' is-primary' : ''}${open === p.key ? ' is-open' : ''}`}
          aria-disabled={!p.allowed}
          onMouseEnter={() => setTip(p.key)}
          onMouseLeave={() => setTip(null)}
          onClick={() => (p.allowed ? onPick(p) : undefined)}
        >
          {p.label}
          {!p.allowed && tip === p.key && p.why ? <span className="tip">{p.why}</span> : null}
        </button>
      ))}
    </>
  );
}

/** The finding in words: its headline and the evidence under it. */
export function FindingText({ flag, organizationId, folded }: { flag: Flag; organizationId: string; folded?: boolean }) {
  const brief = flag.brief;
  const finding = flag.finding;
  const running = finding?.status === 'running' || brief?.status === 'running';
  const headline = finding?.headline ?? (brief?.status === 'ready' ? brief.headline : null) ?? flag.message;
  if (folded) return <div className="bp-msg is-folded"><Figures text={headline} /></div>;
  return (
    <>
      <div className="bp-msg">
        <Figures text={headline} />
        {running && !finding ? <span className="bp-live"> Comparing it with the other bill</span> : null}
      </div>
      {finding && finding.points.length > 0 ? (
        <div className="bp-points">
          {finding.points.map((p, i) => (
            <div key={i} className="bp-point">
              <Mark tone={p.tone} />
              <span className="bp-point-text">
                <Figures text={p.text} />
                {p.billId ? <> <Link to={`/organizations/${organizationId}/bills/${p.billId}`}>Open it</Link></> : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {brief?.status === 'ready' ? <Comparison flag={flag} organizationId={organizationId} /> : null}
    </>
  );
}

/** A duplicate side by side with the bill it repeats. */
function Comparison({ flag, organizationId }: { flag: Flag; organizationId: string }) {
  const brief = flag.brief!;
  const cmp = brief.comparison;
  const differences = cmp ? cmp.rows.filter((r) => r.same === false).length : 0;
  const other = brief.otherBill;
  const claims = brief.findings.map((f) => f.claim).filter(Boolean);
  return (
    <>
      {cmp ? (
        <div className="bp-compare">
          <div className="bp-compare-verdict">
            {cmp.identical || differences === 0 ? 'Every figure matches.' : `${differences} ${differences === 1 ? 'difference' : 'differences'}.`}
          </div>
          <div className="bp-compare-row is-head">
            <span>Fact</span>
            <span>This upload</span>
            <span>{brief.side === 'newer' ? 'The original' : 'The later copy'}</span>
            <span />
          </div>
          {cmp.rows.map((r) => (
            <div key={r.key} className="bp-compare-row">
              <span>{r.label}</span>
              <span className="num">{r.here ?? '—'}</span>
              <span className="num">{r.there ?? '—'}</span>
              {r.same === true ? <Mark tone="ok" size={12} /> : r.same === false ? <span className="bp-compare-differs">Differs</span> : <span />}
            </div>
          ))}
          <div className="bp-compare-foot">
            <Link to={`/organizations/${organizationId}/bills/${other.paymentOrderId}`}>
              Open {brief.side === 'newer' ? 'the original' : 'the later copy'}
            </Link>
            {claims[0] ? <> · {claims[0]}</> : null}
          </div>
        </div>
      ) : null}
      {brief.reason ? <div className="bp-reason">{brief.reason}</div> : null}
      {brief.couldNotCheck.length > 0 ? <div className="bp-reason">Couldn’t check: {brief.couldNotCheck.join('; ')}.</div> : null}
    </>
  );
}

/** A required one-line reason in the card's grey field. Enter confirms, Shift+Enter breaks the line. */
function Reason({ value, onChange, placeholder, onEnter, needed, areaRef, autoFocus = true }: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  onEnter: () => void;
  /** Ringed red: someone tried to confirm without it. */
  needed: boolean;
  areaRef?: { current: HTMLTextAreaElement | null };
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  useEffect(() => {
    if (areaRef) areaRef.current = ref.current;
  }, [areaRef]);
  // A prefilled note is sized to its words on open.
  useEffect(() => {
    const el = ref.current;
    if (!el || !el.value) return;
    el.style.height = '18px';
    el.style.height = `${Math.min(108, el.scrollHeight)}px`;
  }, []);
  const grow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '18px';
    el.style.height = `${Math.min(108, el.scrollHeight)}px`;
    el.style.overflow = el.scrollHeight > 108 ? 'auto' : 'hidden';
  };
  return (
    <div className={`bp-write${needed && !value.trim() ? ' is-needed' : ''}`}>
      <textarea
        ref={ref}
        rows={1}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          grow();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onEnter();
          }
        }}
      />
    </div>
  );
}

function FiguresStrip({ was, wasLabel, now, nowLabel }: { was: number; wasLabel: string; now: number; nowLabel: string }) {
  return (
    <div className="bp-figs">
      <div className="bp-fig">
        <span className="bp-fig-label">{wasLabel}</span>
        <span className="bp-fig-was">{usd(was)}</span>
      </div>
      <span className="bp-fig-arrow">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </span>
      <div className="bp-fig">
        <span className="bp-fig-label">{nowLabel}</span>
        <span className="bp-fig-now">{usd(now)}</span>
      </div>
    </div>
  );
}

export type CardResult = { reason?: string; name?: string; closeReason?: CloseReason; note?: string };

/**
 * The confirmation a way of settling opens. Each says what will happen in a
 * sentence, asks for the reason when the reason is the record, and confirms
 * with Enter. Esc and Cancel put it away.
 */
export function ConfirmCard({ card, flag, draft, totals, busy, onConfirm, onCancel }: {
  card: OpenCard;
  flag: Flag | null;
  draft: BillDraft;
  totals: { printed: number; lines: number };
  busy: boolean;
  onConfirm: (result: CardResult) => void;
  onCancel: () => void;
}) {
  const claimed = flag ? /addressed to "([^"]+)"/.exec(flag.message)?.[1] ?? '' : '';
  const initial = card.kind === 'close' ? card.note
    : card.action === 'this_is_us' ? claimed
    : '';
  const [text, setText] = useState(initial);
  const [closeReason, setCloseReason] = useState<CloseReason>(card.kind === 'close' ? card.reason : 'other');
  const [menu, setMenu] = useState(false);
  const [tried, setTried] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;

  // Esc puts the card away; it comes into view once, when it opens.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') cancel.current();
    }
    window.addEventListener('keydown', onKey);
    boxRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Confirming without the reason it needs rings the field and puts you in it.
  const attempt = (ready: boolean, result: CardResult) => {
    if (busy) return;
    if (!ready) {
      setTried(true);
      areaRef.current?.focus();
      return;
    }
    onConfirm(result);
  };

  const buttons = (label: ReactNode, ready: boolean, result: CardResult) => (
    <div className="bp-card-btns">
      <button type="button" className="bp-pill is-primary" disabled={busy} onClick={() => attempt(ready, result)}>{label}</button>
      <button type="button" className="bp-pill" onClick={onCancel}>Cancel</button>
    </div>
  );

  if (card.kind === 'close') {
    const reason = CLOSE_REASONS.find((r) => r.key === closeReason)!;
    const confirm = () => onConfirm({ closeReason, note: text.trim() });
    return (
      <div ref={boxRef} className="bp-card">
        <div className="bp-card-field" style={{ position: 'relative' }}>
          <span className="bp-card-label">Reason</span>
          <button type="button" className="bp-select" onClick={() => setMenu((v) => !v)} aria-haspopup="listbox" aria-expanded={menu}>
            {reason.label}
            <Chevron />
          </button>
          {menu ? (
            <div className="menu" style={{ position: 'absolute', top: '100%', left: 0, zIndex: 8, marginTop: 4, width: 280 }} role="listbox">
              {CLOSE_REASONS.map((r) => (
                <button key={r.key} type="button" className="menu-item" role="option" aria-selected={r.key === closeReason} onClick={() => { setCloseReason(r.key); setMenu(false); }}>
                  {r.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="bp-card-field">
          <span className="bp-card-label">Note</span>
          <Reason value={text} onChange={setText} placeholder="A note the record will carry" onEnter={confirm} needed={false} areaRef={areaRef} />
        </div>
        <div className="bp-card-quiet">Closing stops the bill for good: it is never approved or posted. The bill and its document stay readable.</div>
        {buttons('Close the bill', true, { closeReason, note: text.trim() })}
      </div>
    );
  }

  const action = card.action;
  const reasonCard = (question: string, placeholder: string, label: ReactNode, extra?: ReactNode) => {
    const ready = text.trim().length >= 3;
    return (
      <div ref={boxRef} className="bp-card">
        {extra}
        <div className="bp-card-text">{question}</div>
        <Reason value={text} onChange={setText} placeholder={placeholder} needed={tried} areaRef={areaRef} onEnter={() => attempt(ready, { reason: text.trim() })} />
        {buttons(label, ready, { reason: text.trim() })}
      </div>
    );
  };

  if (action === 'fix_fields') {
    return (
      <div ref={boxRef} className="bp-card">
        <FiguresStrip was={totals.printed} wasLabel="Total on the document" now={totals.lines} nowLabel="The lines add up to" />
        <div className="bp-card-text">
          Was the total read wrong? If so, the bill’s total becomes what the lines add up to. The document keeps the figure it shows, and the change is recorded under your name.
        </div>
        {buttons('Yes, change it', true, {})}
      </div>
    );
  }
  if (action === 'pay_the_lines') {
    return reasonCard(
      'Why use what the lines add up to rather than the printed total? One line; the approvers will read it.',
      'Your reason, in one line',
      <>Use <span className="num">{usd(totals.lines)}</span></>,
      <FiguresStrip was={totals.printed} wasLabel="Total on the document" now={totals.lines} nowLabel="The lines add up to" />,
    );
  }
  if (action === 'clear_duplicate') {
    const brief = flag?.brief?.status === 'ready' ? flag.brief : null;
    const other = brief?.otherBill.invoiceNumber ?? 'the other bill';
    const warning = !brief ? null
      : brief.verdict === 'replacement' ? `A later ${other} corrects this bill. Clearing this means both versions can be approved and posted.`
      : brief.comparison?.identical ? 'Every figure on these two bills matches. Clearing this means both can be approved and posted.'
      : brief.recommendedAction === 'not_ours' || brief.recommendedAction === 'close_other'
        ? `This looks like a second copy of ${other}. Clearing it means both can be approved and posted.`
        : null;
    return reasonCard('Why is it not a duplicate?', 'Your reason, in one line', 'Not a duplicate', warning ? <div className="bp-card-text">{warning}</div> : null);
  }
  if (action === 'allow_over_ceiling') {
    return reasonCard(
      `Allow this ${usd(totals.printed)} bill past the limit? This bill only: the limit stays where it is, and your reason is the record.`,
      'Your reason, in one line',
      'Allow this bill',
    );
  }
  if (action === 'this_is_us') {
    const ready = text.trim().length >= 2;
    return (
      <div ref={boxRef} className="bp-card">
        <div className="bp-card-text">
          Is “{claimed || 'this name'}” a name {draft.organizationName || 'your organisation'} trades under? It is remembered for good: this bill carries on, no future bill addressed to it is flagged, and other open bills addressed to it lose the finding too.
        </div>
        <Reason value={text} onChange={setText} placeholder="The name, as written on the bill" needed={tried} areaRef={areaRef} onEnter={() => attempt(ready, { name: text.trim() })} />
        {buttons('Yes, record it', ready, { name: text.trim() })}
      </div>
    );
  }
  if (action === 'same_vendor') {
    const target = flag ? /you already pay "([^"]+)"/.exec(flag.message)?.[1] ?? 'the vendor you already pay' : 'the vendor you already pay';
    return (
      <div ref={boxRef} className="bp-card">
        <div className="bp-card-text">
          The same company? This bill moves onto “{target}”, and the name it arrived under is remembered, so the next one matches.
        </div>
        {buttons('Yes, same company', true, {})}
      </div>
    );
  }
  return null;
}
