// Line items (5a): description, quantity, unit price, category and amount,
// each editable in place, with the lines, tax and total under them. A line's
// category says where it came from: pink when the team settled one like it
// before, peach and dashed when it is a first guess (the tick confirms it),
// white with a face once a person has settled it.
import { useMemo, useRef, useState } from 'react';
import type { CategoryOption } from '../../api';
import { Avatar } from '../../kit/Avatar';
import { useDismiss } from '../../kit/hooks';
import { Icon } from '../../kit/icons';
import { usd } from '../../kit/format';
import { CATEGORIES_AT, lineLandsAt, linesSum, parseMoney, parseNumber, type Face, type LineEntry } from './model';
import { Chevron, TickGlyph } from './parts';

const COLUMNS = ['Description', 'Qty', 'Unit', 'Category', 'Amount'];
/** How wide each bar breathes while a line is read: varied, as lines are. */
const READING_WIDTHS = [190, 150, 110, 160, 140];

const Bar = ({ width }: { width: number }) => <span className="bl-reading" style={{ width }} />;

/** A line Decimal hasn't read yet: a bar where each figure will be. */
function ReadingRow({ width }: { width: number }) {
  return (
    <div className="bp-lrow">
      <div className="bp-lc is-first"><Bar width={width} /></div>
      <div className="bp-lc" />
      <div className="bp-lc is-num"><Bar width={14} /></div>
      <div className="bp-lc" />
      <div className="bp-lc is-num"><Bar width={40} /></div>
      <div className="bp-lc" />
      <div className="bp-lc is-cat"><Bar width={90} /></div>
      <div className="bp-lc" />
      <div className="bp-lc is-num is-last"><Bar width={52} /></div>
    </div>
  );
}

function Grow({ value, onChange, placeholder, label, mono, onFocus, editable }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label: string;
  mono?: boolean;
  onFocus?: () => void;
  editable: boolean;
}) {
  if (!editable) return <span className={mono ? 'num' : undefined} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</span>;
  return (
    <span className={`bp-grow${mono ? ' num' : ''}`} data-value={value || placeholder || ''}>
      <input
        value={value}
        placeholder={placeholder}
        aria-label={label}
        spellCheck={false}
        size={1}
        onFocus={onFocus}
        onChange={(e) => onChange(e.target.value)}
      />
    </span>
  );
}

/** A money cell: "$425.00" at rest, the plain figure while typing. */
function MoneyCell({ value, onChange, label, editable, onFocus }: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  editable: boolean;
  onFocus?: () => void;
}) {
  const [typing, setTyping] = useState(false);
  const n = parseMoney(value);
  const display = typing ? value : n == null ? value : usd(n);
  if (!editable) return <span className="num" style={{ whiteSpace: 'nowrap' }}>{display}</span>;
  return (
    <span className="bp-grow num" data-value={display || '$0.00'}>
      <input
        value={display}
        placeholder="$0.00"
        aria-label={label}
        size={1}
        onFocus={() => { setTyping(true); onFocus?.(); }}
        onBlur={() => setTyping(false)}
        onChange={(e) => onChange(e.target.value)}
      />
    </span>
  );
}

function provenance(line: LineEntry, vendorName: string): string | null {
  if (line.settledBy) {
    return `Confirmed by ${line.settledBy.name} · from ${vendorName}’s next bill, this line gets ${line.category}`;
  }
  const from = line.from;
  if (!from) return null;
  if (from.kind === 'memory') {
    return `Known · like ${from.invoiceNumber ?? 'an earlier bill'}${from.by ? `, settled by ${from.by}` : ''}`;
  }
  if (from.kind === 'similar') {
    return `A first guess · similar to “${from.like}” on ${from.vendorName ?? vendorName}${from.invoiceNumber ? ` ${from.invoiceNumber}` : ''}`;
  }
  return 'A first guess, from what the line is for.';
}

function CategoryMenu({ options, current, onPick, onClose }: {
  options: CategoryOption[];
  current: string | null;
  onPick: (value: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = options.filter((o) => !q || o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q));
    const by = new Map<string, CategoryOption[]>();
    for (const o of hit) {
      const list = by.get(o.group) ?? [];
      list.push(o);
      by.set(o.group, list);
    }
    return [...by.entries()];
  }, [options, query]);
  return (
    <div className="menu bp-catmenu" role="listbox">
      <div className="bp-catmenu-search">
        <Icon.search size={11} />
        <input
          autoFocus
          value={query}
          placeholder="Find a category"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const first = groups[0]?.[1][0];
              if (first) onPick(first.value);
            }
            if (e.key === 'Escape') onClose();
          }}
        />
      </div>
      {groups.length === 0 ? <div className="bp-catmenu-group">Nothing matches</div> : null}
      {groups.map(([group, list]) => (
        <div key={group}>
          {groups.length > 1 ? <div className="bp-catmenu-group">{group}</div> : null}
          {list.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === current}
              className={`menu-item${o.value === current ? ' is-on' : ''}`}
              onClick={() => onPick(o.value)}
            >
              <span>{o.label}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function CategoryCell({ line, vendorName, options, editable, onPick, onConfirm }: {
  line: LineEntry;
  vendorName: string;
  options: CategoryOption[];
  editable: boolean;
  onPick: (value: string) => void;
  onConfirm: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useDismiss(open, ref, () => setOpen(false));
  const note = provenance(line, vendorName);
  const tone = !line.category ? 'is-empty'
    : line.settledBy ? ''
    : line.from?.kind === 'memory' ? 'is-known'
    : line.from ? 'is-guess'
    : '';
  const guess = tone === 'is-guess';

  if (!editable) {
    return (
      <div className="bp-lc is-cat" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        {hover && note ? <span className="bp-note-tip">{note}</span> : null}
        <span className={`bp-cat is-plain`}>
          <span className="bp-cat-name">{line.category ?? 'No category'}</span>
          {line.settledBy ? <Avatar name={line.settledBy.name} src={line.settledBy.avatarUrl} size={14} /> : null}
        </span>
      </div>
    );
  }

  return (
    <div ref={ref} className="bp-lc is-cat" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {hover && note && !open ? <span className="bp-note-tip">{note}</span> : null}
      <span
        role="button"
        tabIndex={0}
        className={`bp-cat ${tone}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        <span className="bp-cat-name">{line.category ?? 'Choose a category'}</span>
        {guess ? (
          <button
            type="button"
            className="bp-tick is-small"
            title={`Confirm ${line.category}`}
            aria-label={`Confirm ${line.category}`}
            onClick={(e) => {
              e.stopPropagation();
              onConfirm();
            }}
          >
            <TickGlyph size={8} width={3.2} />
          </button>
        ) : null}
        {line.settledBy ? <Avatar name={line.settledBy.name} src={line.settledBy.avatarUrl} size={14} /> : null}
        <Chevron size={8} />
      </span>
      {open ? (
        <CategoryMenu
          options={options}
          current={line.category}
          onClose={() => setOpen(false)}
          onPick={(value) => {
            setOpen(false);
            onPick(value);
          }}
        />
      ) : null}
    </div>
  );
}

export function LineItems({
  lines,
  tax,
  total,
  vendorName,
  options,
  editable,
  wrongTotal,
  viewer,
  highlighted,
  reading = null,
  emptyText = 'No lines yet.',
  bare = false,
  onChange,
  onRemove,
  onAdd,
  onFocusLine,
  onFocusTotals,
}: {
  lines: LineEntry[];
  tax: number;
  total: number | null;
  vendorName: string;
  options: CategoryOption[];
  editable: boolean;
  /** The printed total disagrees with the lines: it reads red. */
  wrongTotal: boolean;
  viewer: Face;
  highlighted: string | null;
  /** While Decimal reads the bill, the tick its landing has reached (5r). */
  reading?: number | null;
  /** What the table says with no lines. */
  emptyText?: string;
  /** Without the lines, tax and total under the table. */
  bare?: boolean;
  onChange: (id: string, patch: Partial<LineEntry>) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
  onFocusLine: (line: LineEntry) => void;
  onFocusTotals: () => void;
}) {
  const sum = linesSum(lines);
  const setAmountFrom = (line: LineEntry, patch: Partial<LineEntry>) => {
    // Quantity times unit price is the amount; changing either keeps it so.
    const next = { ...line, ...patch };
    const q = parseNumber(next.quantity);
    const u = parseMoney(next.unitPrice);
    const amount = q != null && u != null ? String(Math.round(q * u * 100) / 100) : next.amount;
    onChange(line.id, { ...patch, amount });
  };
  return (
    <>
      <div className="bp-sec-head">
        <div className="bp-sec-title">Line items</div>
        {editable && reading === null ? <button type="button" className="bp-add" onClick={onAdd}>+ Add a line</button> : null}
      </div>
      <div className="bp-lines">
        <div className="bp-lines-grid">
          <div className="bp-lrow is-head">
            {COLUMNS.map((c, i) => (
              <div key={c} style={{ display: 'contents' }}>
                {i > 0 ? <div className="bp-lc" /> : null}
                <div className={`bp-lc${i === 0 ? ' is-first' : ''}${i === 4 ? ' is-last' : ''}${i === 1 || i === 2 || i === 4 ? ' is-num' : ''}`}>
                  <span className="bp-lh">{c}</span>
                </div>
              </div>
            ))}
          </div>
          {lines.length === 0 && reading !== null ? READING_WIDTHS.map((w) => <ReadingRow key={w} width={w} />) : null}
          {lines.length === 0 && reading === null ? <div className="bp-empty-lines">{emptyText}</div> : null}
          {lines.map((line, i) => reading !== null && reading < lineLandsAt(i, lines.length) ? (
            <ReadingRow key={line.id} width={READING_WIDTHS[i % READING_WIDTHS.length]!} />
          ) : (
            <div key={line.id} className={`bp-lrow${highlighted === line.id ? ' is-hl' : ''}`} data-focus={`line:${i}`}>
              <div className="bp-lc is-first">
                <Grow
                  value={line.description}
                  placeholder="What it’s for"
                  label={`Line ${i + 1} description`}
                  editable={editable}
                  onFocus={() => onFocusLine(line)}
                  onChange={(v) => onChange(line.id, { description: v })}
                />
              </div>
              <div className="bp-lc" />
              <div className="bp-lc is-num">
                <Grow
                  value={line.quantity}
                  placeholder="1"
                  label={`Line ${i + 1} quantity`}
                  mono
                  editable={editable}
                  onFocus={() => onFocusLine(line)}
                  onChange={(v) => setAmountFrom(line, { quantity: v })}
                />
              </div>
              <div className="bp-lc" />
              <div className="bp-lc is-num">
                <MoneyCell value={line.unitPrice} label={`Line ${i + 1} unit price`} editable={editable} onFocus={() => onFocusLine(line)} onChange={(v) => setAmountFrom(line, { unitPrice: v })} />
              </div>
              <div className="bp-lc" />
              {reading !== null && reading < CATEGORIES_AT ? (
                <div className="bp-lc is-cat"><Bar width={90} /></div>
              ) : (
                <CategoryCell
                  line={line}
                  vendorName={vendorName}
                  options={options}
                  editable={editable}
                  onPick={(value) => onChange(line.id, { category: value, from: null, settledBy: viewer })}
                  onConfirm={() => onChange(line.id, { from: null, settledBy: viewer })}
                />
              )}
              <div className="bp-lc" />
              <div className="bp-lc is-num is-last">
                <MoneyCell value={line.amount} label={`Line ${i + 1} amount`} editable={editable} onFocus={() => onFocusLine(line)} onChange={(v) => onChange(line.id, { amount: v })} />
                {editable ? (
                  <button type="button" className="bp-line-x" title="Remove this line" aria-label={`Remove line ${i + 1}`} onClick={() => onRemove(line.id)}>
                    <Icon.x size={8} />
                  </button>
                ) : null}
              </div>
            </div>
          ))}
          {reading === null && !bare ? (
            <>
              <div className="bp-lrow" onClick={onFocusTotals}>
                <div className="bp-lsum is-top">Lines</div>
                <div className="bp-lsum-gap is-top" />
                <div className="bp-lsum-amt is-top num">{usd(sum)}</div>
              </div>
              <div className="bp-lrow">
                <div className="bp-lsum">Tax</div>
                <div className="bp-lsum-gap" />
                <div className="bp-lsum-amt num">{usd(tax)}</div>
              </div>
              <div className="bp-lrow">
                <div className="bp-lsum is-end">Total on the document</div>
                <div className="bp-lsum-gap" />
                <div className={`bp-lsum-amt is-end num${wrongTotal ? ' is-wrong' : ''}`}>{total == null ? '—' : usd(total)}</div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
