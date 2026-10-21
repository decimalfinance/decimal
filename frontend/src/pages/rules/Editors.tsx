// What floats over the Approval rules canvas (Approval rules.dc.html L75-L94):
// the step editor (its name, who approves, how many must), the split editor
// (by amount, vendor, category or a vendor's first bill) and the menu that
// adds a step, a split or an end.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Avatar } from '../../kit/Avatar';
import { firstName } from '../../kit/format';
import { Icon } from '../../kit/icons';
import { TickGlyph } from '../bill/parts';
import type { Person } from './Canvas';
import { kindOf, setSplitKind, toggleCategory, togglePerson, toggleVendor, type InsertKind, type Split, type SplitKind, type Step } from './flowTree';
import { quorumChoices } from './words';

/** Most vendors or categories one split can name (the API's limit). */
const SPLIT_LIST_MAX = 30;

/** A text edit merges into the last undo entry when it's the same field, typed within a moment. */
export type Change<T> = (next: T, field?: string) => void;

function Head({ label, htmlFor, onClose }: { label: string; htmlFor?: string; onClose: () => void }) {
  return (
    <div className="ar-ed-head">
      {htmlFor ? <label className="field-label" htmlFor={htmlFor}>{label}</label> : <span className="field-label">{label}</span>}
      <button type="button" className="ar-x" aria-label="Close" onClick={onClose}>
        <Icon.x size={10} strokeWidth={2.2} />
      </button>
    </div>
  );
}

function Actions({ remove, onRemove, onDone }: { remove: string; onRemove: () => void; onDone: () => void }) {
  return (
    <div className="ar-ed-actions">
      <button type="button" className="btn ar-remove" onClick={onRemove}>{remove}</button>
      <button type="button" className="btn is-primary" onClick={onDone}>Done</button>
    </div>
  );
}

/** Why someone can't be picked, as the row says it and as its note explains it. */
function cannotApprove(p: Person) {
  const first = firstName(p.name);
  if (p.role === 'Viewer') {
    return { sub: 'Viewer · can look, not approve', why: `Viewers can only look. An admin can change ${first}’s role on Team members.` };
  }
  return { sub: `${p.role} · approving isn’t their job`, why: `Approving is an approver’s job. An admin can make ${first} an approver on Team members.` };
}

export function StepEditor({
  step,
  team,
  personOf,
  fresh,
  onChange,
  onRemove,
  onClose,
}: {
  step: Step;
  /** Everyone on the team, those who can approve first. */
  team: Person[];
  personOf: (id: string) => Person | undefined;
  /** Just added: the name field takes the focus. */
  fresh: boolean;
  onChange: Change<Step>;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const name = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!fresh) return;
    const t = window.setTimeout(() => name.current?.focus({ preventScroll: true }), 40);
    return () => window.clearTimeout(t);
  }, [fresh, step.id]);
  useEffect(() => setPicking(false), [step.id]);

  const others = team.filter((p) => !step.approvers.includes(p.id));
  const choices = step.approvers.length >= 2 ? quorumChoices(step.approvers.length) : [];
  const fieldId = `ar-step-${step.id}`;

  return (
    <div
      className="ar-ed"
      role="dialog"
      aria-label="Edit this step"
      onKeyDown={(e) => {
        // Esc closes the list of people first, then the editor (the page's own Esc).
        if (e.key === 'Escape' && picking) {
          e.stopPropagation();
          setPicking(false);
        }
      }}
    >
      <div className="ar-ed-top">
        <Head label="Step name" htmlFor={fieldId} onClose={onClose} />
        <input
          ref={name}
          id={fieldId}
          className="input ar-input"
          placeholder="Approval step"
          maxLength={120}
          value={step.title === 'Approval step' ? '' : step.title}
          // A renamed step drops the name it was published under, which would otherwise win.
          onChange={(e) => onChange({ ...step, title: e.target.value.trim() ? e.target.value : 'Approval step', purpose: undefined }, `title:${step.id}`)}
        />
      </div>

      <div className="ar-ed-sec">
        <span className="field-label">Who approves</span>
        <div className="ar-box">
          {step.approvers.map((id) => {
            const p = personOf(id);
            const label = p?.name ?? 'Someone who left';
            return (
              <div key={id} className="ar-who">
                <Avatar name={label} src={p?.avatarUrl} size={20} fontSize={8} />
                <span className="ar-who-text">
                  <span className="ar-who-name clip">{label}</span>
                  <span className="ar-who-role">{p?.role ?? 'No longer on the team'}</span>
                </span>
                <button
                  type="button"
                  className="ar-x is-round"
                  aria-label={`Remove ${label}`}
                  title={`Remove ${label}`}
                  onClick={() => onChange(togglePerson(step, id))}
                >
                  <Icon.x size={10} />
                </button>
              </div>
            );
          })}
          {picking ? (
            <div className="ar-pick">
              {team.length <= 1 ? (
                <p className="ar-pick-alone">Only you so far. Invite your team from Team members, then pick them here.</p>
              ) : null}
              {others.map((p) => {
                if (!p.canApprove) {
                  const no = cannotApprove(p);
                  return (
                    <div key={p.id} className="ar-pick-row is-off" title={no.why} aria-disabled="true">
                      <Avatar name={p.name} src={p.avatarUrl} size={20} fontSize={8} tone="var(--bead-spare)" className="is-pale" />
                      <span className="ar-who-text">
                        <span className="ar-who-name clip">{p.name}</span>
                        <span className="ar-who-role">{no.sub}</span>
                      </span>
                    </div>
                  );
                }
                return (
                  <button key={p.id} type="button" className="ar-pick-row" onClick={() => onChange(togglePerson(step, p.id))}>
                    <Avatar name={p.name} src={p.avatarUrl} size={20} fontSize={8} />
                    <span className="ar-who-text">
                      <span className="ar-who-name clip">{p.name}</span>
                      <span className="ar-who-role">{p.role}</span>
                    </span>
                    <span className="ar-pick-add">Add</span>
                  </button>
                );
              })}
              <button type="button" className="ar-pick-close" onClick={() => setPicking(false)}>Close the list</button>
            </div>
          ) : (
            <button type="button" className="ar-add-who" onClick={() => setPicking(true)}>
              <span className="ar-ring is-plus"><Icon.plus size={9} strokeWidth={2.8} /></span>
              Add someone
            </button>
          )}
        </div>
      </div>

      {choices.length ? (
        <div className="ar-ed-sec">
          <span className="field-label" id={`${fieldId}-q`}>How many must approve</span>
          <div className="ar-box" role="radiogroup" aria-labelledby={`${fieldId}-q`}>
            {choices.map((c) => {
              const on = step.quorum === c.value;
              return (
                <button
                  key={String(c.value)}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={`ar-choice${on ? ' is-on' : ''}`}
                  onClick={() => onChange({ ...step, quorum: c.value })}
                >
                  <span className="ar-radio" />
                  <span className="ar-choice-label">{c.label}</span>
                  <span className="ar-choice-line">{c.line}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <Actions remove="Remove this step" onRemove={onRemove} onDone={onClose} />
    </div>
  );
}

const TABS: Array<{ kind: SplitKind; label: string }> = [
  { kind: 'amount', label: 'Amount' },
  { kind: 'vendor', label: 'Vendor' },
  { kind: 'category', label: 'Category' },
  { kind: 'firstBill', label: 'New vendor' },
];

/** "10,000.00" from 10000; nothing for an amount not set yet. */
export const moneyText = (n: number) => (n > 0 ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '');

/** What someone typed as dollars: digits and one point, to the cent. */
export function parseMoney(text: string) {
  const clean = text.replace(/[^0-9.]/g, '');
  const [whole = '', ...rest] = clean.split('.');
  const n = Number(`${whole || '0'}.${rest.join('').slice(0, 2) || '0'}`);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** The "$" field the split editor and Test a bill share: as typed while focused, formatted after. */
export function MoneyField({ id, value, label, onValue, placeholder }: { id: string; value: number; label?: string; onValue: (n: number) => void; placeholder?: string }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <span className="ar-money">
      <span className="ar-money-sign num" aria-hidden>$</span>
      <input
        id={id}
        className="input ar-input num"
        inputMode="decimal"
        aria-label={label}
        placeholder={placeholder}
        value={text ?? moneyText(value)}
        onFocus={() => setText(moneyText(value))}
        onChange={(e) => {
          setText(e.target.value);
          onValue(parseMoney(e.target.value));
        }}
        onBlur={() => setText(null)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    </span>
  );
}

function Checks({ items, isOn, onToggle }: { items: Array<{ key: string; label: string }>; isOn: (key: string) => boolean; onToggle: (key: string) => void }) {
  const chosen = items.filter((i) => isOn(i.key)).length;
  return (
    <div className="ar-checks">
      {items.map((i) => {
        const on = isOn(i.key);
        const full = !on && chosen >= SPLIT_LIST_MAX;
        return (
          <button
            key={i.key}
            type="button"
            role="checkbox"
            aria-checked={on}
            disabled={full}
            title={full ? `A split can name up to ${SPLIT_LIST_MAX}` : undefined}
            className={`ar-check${on ? ' is-on' : ''}`}
            onClick={() => onToggle(i.key)}
          >
            <span className="ar-box-tick">{on ? <TickGlyph size={8} width={3.4} /> : null}</span>
            <span className="clip">{i.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function SplitEditor({
  split,
  vendors,
  categories,
  onChange,
  onRemove,
  onClose,
}: {
  split: Split;
  vendors: Array<{ id: string; name: string }>;
  categories: string[];
  onChange: Change<Split>;
  onRemove: () => void;
  onClose: () => void;
}) {
  const kind = kindOf(split);
  const fieldId = `ar-split-${split.id}`;
  const s = split.split;
  let body: ReactNode;
  if (kind === 'amount') {
    body = (
      <>
        <label className="field-label" htmlFor={fieldId}>Bills of this much or more go down Yes</label>
        <MoneyField id={fieldId} value={split.amountGteUsd} placeholder="10,000.00" onValue={(n) => onChange({ ...split, amountGteUsd: n }, `amount:${split.id}`)} />
        <span className="ar-hint">Smaller bills go down No.</span>
      </>
    );
  } else if (kind === 'vendor') {
    const ids = s?.kind === 'vendor' ? s.vendorIds : [];
    body = (
      <>
        <span className="field-label">Bills from these vendors go down Yes</span>
        {vendors.length ? (
          <Checks
            items={vendors.map((v) => ({ key: v.id, label: v.name }))}
            isOn={(id) => ids.includes(id)}
            onToggle={(id) => onChange(toggleVendor(split, vendors.find((v) => v.id === id) ?? { id, name: '' }))}
          />
        ) : (
          <span className="ar-hint">No vendors yet. A vendor appears when its first bill arrives.</span>
        )}
      </>
    );
  } else if (kind === 'category') {
    const chosen = s?.kind === 'category' ? s.categories : [];
    body = (
      <>
        <span className="field-label">Bills coded to these categories go down Yes</span>
        <Checks items={categories.map((c) => ({ key: c, label: c }))} isOn={(c) => chosen.includes(c)} onToggle={(c) => onChange(toggleCategory(split, c))} />
      </>
    );
  } else {
    body = <p className="ar-ed-text">A vendor’s first bill goes down Yes. Every bill after it from the same vendor goes down No.</p>;
  }

  return (
    <div className="ar-ed" role="dialog" aria-label="Edit this split">
      <div className="ar-ed-top">
        <Head label="Split bills by" onClose={onClose} />
      </div>
      <div className="ar-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.kind}
            type="button"
            role="tab"
            aria-selected={kind === t.kind}
            className={`ar-tab${kind === t.kind ? ' is-on' : ''}`}
            onClick={() => onChange(setSplitKind(split, t.kind))}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="ar-ed-sec">{body}</div>
      <Actions remove="Remove this split" onRemove={onRemove} onDone={onClose} />
    </div>
  );
}

const ITEMS: Array<{ kind: InsertKind; label: string; line: string; icon: ReactNode }> = [
  { kind: 'step', label: 'Add an approval step', line: 'Someone approves the bill here.', icon: <Icon.person size={13} /> },
  { kind: 'split', label: 'Split the path', line: 'By amount, vendor, category or a new vendor.', icon: <Icon.fork size={13} strokeWidth={2.1} /> },
  { kind: 'end', label: 'End the path here', line: 'The bill is approved once it gets this far.', icon: <Icon.ringTick size={13} /> },
];

/** The menu under a "+": a step or a split; at a path's end, ending it too. */
export function InsertMenu({ tail, onPick }: { tail: boolean; onPick: (kind: InsertKind) => void }) {
  return (
    <div className="menu ar-menu" role="menu">
      {ITEMS.filter((i) => tail || i.kind !== 'end').map((i) => (
        <button key={i.kind} type="button" role="menuitem" className="ar-menu-item" onClick={() => onPick(i.kind)}>
          <span className="ar-menu-icon">{i.icon}</span>
          <span className="ar-menu-label">{i.label}</span>
          <span className="ar-menu-line">{i.line}</span>
        </button>
      ))}
    </div>
  );
}
