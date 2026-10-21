// A bill past review, read rather than edited (5d to 5h): its facts as labels
// and values with no boxes, and its lines in bands. Who settled a value shows
// only on hover; a value a person changed keeps what the document printed,
// struck through, with their face beside it.
import { useState, type ReactNode } from 'react';
import type { BillDetail } from '../../api';
import { Avatar } from '../../kit/Avatar';
import { usd } from '../../kit/format';
import {
  DETAIL_FIELDS,
  DISCOUNT_FIELD,
  VENDOR_FIELDS,
  fieldsFrom,
  linesFrom,
  linesSum,
  parseMoney,
  parseNumber,
  shown,
  type Face,
  type FieldDef,
  type LineEntry,
} from './model';

/** A value with a dark note above it while the pointer rests on it. */
function Hover({ note, end, children }: { note: ReactNode | null; end?: boolean; children: ReactNode }) {
  const [on, setOn] = useState(false);
  if (!note) return <>{children}</>;
  return (
    <span className="bp-hover" onMouseEnter={() => setOn(true)} onMouseLeave={() => setOn(false)}>
      {children}
      {on ? <span className={`bp-note-tip is-above ${end ? 'is-end' : 'is-mid'}`} role="tooltip">{note}</span> : null}
    </span>
  );
}

function ByNote({ face, text }: { face: Face | null; text: ReactNode }) {
  return (
    <>
      {face ? <Avatar name={face.name} src={face.avatarUrl} size={14} /> : null}
      <span>{text}</span>
    </>
  );
}

/** Figures in mono: a whole code, date or amount, or the numbers in a street or terms. */
function Value({ def, text }: { def: FieldDef; text: string }) {
  if (def.kind !== 'text') return <span className="num">{text}</span>;
  if (def.key !== 'remitTo.street' && def.key !== 'terms') return <>{text}</>;
  return <>{text.split(/(\d[\d,.]*)/).map((part, i) => (i % 2 ? <span key={i} className="num">{part}</span> : part))}</>;
}

// Corrections are keyed by the reading's names; the page's keys differ for two.
const CORRECTED_KEY: Record<string, string> = { vendorName: 'vendor.name', vendorEmail: 'vendor.email', tax: 'taxAmount', taxAmount: 'taxAmount' };

const FROM_ROWS: string[][] = [['vendor.name', 'vendor.email'], ['remitTo.street', 'remitTo.city'], ['remitTo.state', 'remitTo.zip'], ['remitTo.country']];
const DETAIL_ROWS: string[][] = [['invoiceNumber', 'poNumber'], ['invoiceDate', 'currency'], ['dueDate', 'taxAmount'], ['terms', 'total']];
const DEFS: Record<string, FieldDef> = Object.fromEntries([...VENDOR_FIELDS, ...DETAIL_FIELDS, DISCOUNT_FIELD].map((d) => [d.key, d]));
const LABEL: Record<string, string> = { 'vendor.name': 'Vendor' };

export function Facts({ detail }: { detail: BillDetail }) {
  const draft = detail.draft;
  const fields = fieldsFrom(draft);
  const changed = new Map(detail.corrections.map((c) => [CORRECTED_KEY[c.field] ?? c.field, c]));

  const cell = (key: string) => {
    const def = DEFS[key]!;
    const entry = fields[key];
    const text = shown(def.kind, entry?.value.trim() ?? '');
    const label = <span key={`${key}-k`} className="bp-kv-k">{LABEL[key] ?? def.label}</span>;
    if (!text) {
      return [label, <span key={`${key}-v`} className="bp-kv-v is-none">Not on the document</span>];
    }
    const change = changed.get(key);
    const settler = draft.confirmedBy?.[key] ?? null;
    if (change && change.from !== 'not on document') {
      const was = shown(def.kind, change.from);
      const face = change.by ? (settler?.name === change.by ? settler : { name: change.by, avatarUrl: null }) : null;
      const note = <ByNote face={face} text={<>Changed by {change.by ?? 'a person'} · the document says <Value def={def} text={was} /></>} />;
      return [
        label,
        <span key={`${key}-v`} className="bp-kv-v">
          <Hover note={note}><span className="bp-kv-now"><Value def={def} text={text} /></span></Hover>
          <span className="bp-kv-was">{was}</span>
          {face ? <Avatar name={face.name} src={face.avatarUrl} size={12} /> : null}
        </span>,
      ];
    }
    const note = entry?.state === 'confirmed' && settler ? <ByNote face={settler} text={`Confirmed by ${settler.name}`} /> : null;
    return [label, <span key={`${key}-v`} className="bp-kv-v"><Hover note={note}><Value def={def} text={text} /></Hover></span>];
  };

  const grid = (rows: string[][]) => (
    <div className="bp-kv">
      {rows.flatMap((row, i) => [
        ...cell(row[0]!),
        <span key={`gap-${i}`} />,
        ...(row[1] ? cell(row[1]) : [<span key={`e1-${i}`} />, <span key={`e2-${i}`} />]),
      ])}
    </div>
  );
  const detailRows = fields.discount?.value ? [...DETAIL_ROWS, ['discount']] : DETAIL_ROWS;

  return (
    <>
      <div className="bp-ro is-first">
        <div className="bp-ro-title">From</div>
        {grid(FROM_ROWS)}
      </div>
      <div className="bp-ro">
        <div className="bp-ro-title">Details</div>
        {grid(detailRows)}
      </div>
      <div className="bp-ro">
        <div className="bp-ro-title">Line items</div>
        <ReadLines lines={linesFrom(draft)} tax={parseMoney(fields.taxAmount?.value) ?? 0} total={parseMoney(fields.total?.value)} vendorName={fields['vendor.name']?.value || draft.vendor.name} />
      </div>
    </>
  );
}

/** Where a line's category came from, in a sentence. */
function categoryNote(line: LineEntry, vendorName: string): ReactNode | null {
  if (line.settledBy) return <ByNote face={line.settledBy} text={`Confirmed by ${line.settledBy.name}`} />;
  const from = line.from;
  if (!from) return null;
  if (from.kind === 'memory') {
    return <ByNote face={null} text={`Picked by the Decimal agent · like ${from.invoiceNumber ?? 'an earlier bill'}${from.by ? `, settled by ${from.by}` : ''}`} />;
  }
  if (from.kind === 'similar') {
    return <ByNote face={null} text={`Picked by the Decimal agent · similar to “${from.like}” on ${from.vendorName ?? vendorName}${from.invoiceNumber ? ` ${from.invoiceNumber}` : ''}`} />;
  }
  return <ByNote face={null} text="Picked by the Decimal agent · from what the line is for" />;
}

function ReadLines({ lines, tax, total, vendorName }: { lines: LineEntry[]; tax: number; total: number | null; vendorName: string }) {
  const sum = linesSum(lines);
  const money = (text: string) => {
    const n = parseMoney(text);
    return n == null ? '' : usd(n);
  };
  return (
    <div className="bp-lines-grid is-banded">
      <div className="bp-lrow is-head">
        <span className="bp-lc is-first"><span className="bp-lh">Description</span></span>
        <span className="bp-lc" />
        <span className="bp-lc is-num"><span className="bp-lh">Qty</span></span>
        <span className="bp-lc" />
        <span className="bp-lc is-num"><span className="bp-lh">Unit</span></span>
        <span className="bp-lc" />
        <span className="bp-lc"><span className="bp-lh">Category</span></span>
        <span className="bp-lc" />
        <span className="bp-lc is-num is-last"><span className="bp-lh">Amount</span></span>
      </div>
      {lines.length === 0 ? <div className="bp-empty-lines">No lines.</div> : null}
      {lines.map((line, i) => {
        const qty = parseNumber(line.quantity);
        return (
          <div key={line.id} className={`bp-lrow${i % 2 === 0 ? ' is-band' : ''}`}>
            <span className="bp-lc is-first"><span className="bp-ldesc" title={line.description}>{line.description}</span></span>
            <span className="bp-lc" />
            <span className="bp-lc is-num"><span className="num">{qty == null ? '' : qty}</span></span>
            <span className="bp-lc" />
            <span className="bp-lc is-num"><span className="num">{money(line.unitPrice)}</span></span>
            <span className="bp-lc" />
            <span className="bp-lc">
              {line.category ? <Hover note={categoryNote(line, vendorName)} end>{line.category}</Hover> : <span className="bp-kv-v is-none">No category</span>}
            </span>
            <span className="bp-lc" />
            <span className="bp-lc is-num is-last"><span className="num">{money(line.amount)}</span></span>
          </div>
        );
      })}
      <span className="bp-lsum is-top">Lines</span>
      <span className="bp-lsum-gap is-top" />
      <span className="bp-lsum-amt is-top"><span className="num">{usd(sum)}</span></span>
      <span className="bp-lsum">Tax</span>
      <span className="bp-lsum-gap" />
      <span className="bp-lsum-amt"><span className="num">{usd(tax)}</span></span>
      <span className="bp-lsum is-end">Total</span>
      <span className="bp-lsum-gap" />
      <span className="bp-lsum-amt is-end"><span className="num">{total == null ? '–' : usd(total)}</span></span>
    </div>
  );
}
