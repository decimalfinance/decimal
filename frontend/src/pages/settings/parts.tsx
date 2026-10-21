// The pieces Organisation and Your account share: a block's heading, a row
// that couldn't be loaded, a name edited in place, and who changed a policy.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, type PolicyChange } from '../../api';
import { fullDay, when } from '../../kit/format';

export function messageOf(e: unknown) {
  return e instanceof Error && e.message ? e.message : 'That didn’t go through. Try again.';
}

export function codeOf(e: unknown) {
  return e instanceof ApiError ? e.code : null;
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: string[]) {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "Testing Labs’", "Acme’s". */
export function possessive(name: string) {
  return /s$/i.test(name) ? `${name}’` : `${name}’s`;
}

/** Trimmed, with runs of spaces made one: how a name is kept. */
export function tidy(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

export function Heading({ title, hint, count, tight }: { title: ReactNode; hint?: ReactNode; count?: number; tight?: boolean }) {
  return (
    <div className={`st-heading${tight ? ' is-tight' : ''}`}>
      <h2 className="section-title">{title}</h2>
      {hint ? <span className="st-hint">{hint}</span> : null}
      {count !== undefined ? <span className="st-count num">{count}</span> : null}
    </div>
  );
}

/** In place of rows that couldn't be loaded. */
export function Failed({ what, retry }: { what: string; retry: () => void }) {
  return (
    <div className="st-empty">
      {what} couldn’t be loaded.
      <button type="button" className="st-again" onClick={retry}>
        Try again
      </button>
    </div>
  );
}

/**
 * "Changed by you · 2 Oct 2026", or "Today, 10:15" for a change made today:
 * the last recorded change to a policy, or nothing when none is on record.
 */
export function ChangedBy({ change, myPersonId }: { change: PolicyChange | null | undefined; myPersonId: string | null }) {
  if (!change) return null;
  const at = new Date(change.at);
  const who = change.personId && change.personId === myPersonId ? 'you' : change.name ?? 'someone';
  const today = at.toDateString() === new Date().toDateString();
  return (
    <span className="st-changed">
      Changed by {who} ·{' '}
      {today ? (
        <>
          Today, <span className="num">{when(at)}</span>
        </>
      ) : (
        <span className="num">{fullDay(at)}</span>
      )}
    </span>
  );
}

/**
 * A row whose value is a name, edited in place: the value becomes a field,
 * Enter saves and Esc cancels. `save` answers with the reason it was refused,
 * which takes the place of the row's line, or null once it's saved.
 */
export function NameRow({
  label,
  line,
  value,
  canEdit,
  action,
  fieldLabel,
  wide,
  emptyError,
  save,
}: {
  label: string;
  line: string;
  value: string;
  canEdit: boolean;
  action: string;
  fieldLabel: string;
  wide?: boolean;
  emptyError: string;
  save: (next: string) => Promise<string | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing) return;
    field.current?.focus({ preventScroll: true });
    field.current?.select();
  }, [editing]);

  function open() {
    setDraft(value);
    setError(null);
    setEditing(true);
  }

  function cancel() {
    if (busy) return;
    setEditing(false);
    setError(null);
  }

  async function commit() {
    if (busy) return;
    const next = tidy(draft);
    if (!next) {
      setError(emptyError);
      return;
    }
    if (next === value) {
      cancel();
      return;
    }
    setBusy(true);
    const refused = await save(next);
    setBusy(false);
    if (refused) {
      setError(refused);
      field.current?.focus({ preventScroll: true });
      return;
    }
    setEditing(false);
  }

  return (
    <div className="st-row">
      <div className="st-left">
        <div className="st-label">{label}</div>
        <div className={`st-line${error ? ' is-error' : ''}`} role={error ? 'alert' : undefined}>
          {error ?? line}
        </div>
      </div>
      <div className="st-right">
        {editing ? (
          <>
            <input
              ref={field}
              className={`st-field${wide ? ' is-wide' : ''}${error ? ' is-error' : ''}`}
              aria-label={fieldLabel}
              aria-invalid={error ? true : undefined}
              value={draft}
              maxLength={120}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void commit();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancel();
                }
              }}
            />
            <button type="button" className="st-pill is-quiet" onClick={cancel}>
              Cancel
            </button>
            <button type="button" className="st-pill is-primary" onClick={() => void commit()} disabled={busy}>
              Save
            </button>
          </>
        ) : (
          <>
            <span className="st-value clip" title={value}>
              {value}
            </span>
            {canEdit ? (
              <button type="button" className="st-pill" onClick={open}>
                {action}
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
