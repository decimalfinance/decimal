// The facts as boxes (5a): pink where Decimal read a value, peach and dashed
// where it wants a look (a round tick confirms it), white with a face once a
// person has settled it, dashed grey where the document has none, red where
// the figure is wrong. Every box edits in place; typing settles it.
import { useState, type ReactNode } from 'react';
import { Avatar } from '../../kit/Avatar';
import { shown, type Face, type FieldDef, type FieldEntry, type Look, parseDay } from './model';
import { TickGlyph } from './parts';

export function lookOf(entry: FieldEntry | undefined, opts: { reading?: boolean; unread?: boolean; wrong?: boolean } = {}): Look {
  if (opts.reading) return 'reading';
  if (opts.wrong) return 'wrong';
  const value = entry?.value.trim() ?? '';
  if (opts.unread && entry?.state !== 'confirmed') return value ? 'confirmed' : 'unread';
  if (!value) return 'none';
  if (entry!.state === 'confirmed' || entry!.state === 'not_on_document') return 'confirmed';
  if (entry!.state === 'needs_look') return 'look';
  return 'read';
}

const LOOK_CLASS: Record<Look, string> = {
  read: 'is-read',
  look: 'is-look',
  confirmed: 'is-confirmed',
  none: 'is-none',
  wrong: 'is-wrong',
  reading: 'is-reading',
  unread: 'is-unread',
};

export function FieldBox({
  def,
  entry,
  look,
  by,
  wrongNote,
  editable,
  onEdit,
  onConfirm,
  onFocus,
}: {
  def: FieldDef;
  entry: FieldEntry | undefined;
  look: Look;
  /** Who settled it, once someone has. */
  by: Face | null;
  /** What is wrong with it, under a red box. */
  wrongNote?: ReactNode;
  editable: boolean;
  onEdit: (value: string) => void;
  onConfirm: () => void;
  onFocus: () => void;
}) {
  const [typing, setTyping] = useState<string | null>(null);
  const value = entry?.value ?? '';
  const display = shown(def.kind, value);
  const mono = def.kind !== 'text';
  const placeholder = look === 'unread' ? 'Not read' : look === 'none' ? 'Not on the document' : '';

  const change = (text: string) => {
    setTyping(text);
    if (def.kind === 'date') onEdit(parseDay(text) ?? text);
    else onEdit(text);
  };

  let note: ReactNode = null;
  if (look === 'look' && entry?.reason) note = <span>{entry.reason}</span>;
  else if (look === 'wrong' && wrongNote) note = wrongNote;
  else if (look === 'confirmed' && by) note = <><Avatar name={by.name} src={by.avatarUrl} size={12} />Confirmed by {by.name}</>;
  else if (look === 'read' && entry?.inferred) note = <span>Worked out from the address</span>;

  return (
    <div className={`bp-field ${LOOK_CLASS[look]}`} data-focus={`field:${def.key}`}>
      <span className="bp-label">{def.label}</span>
      <div className="bp-box">
        {look === 'reading' ? null : editable ? (
          <input
            className={mono ? 'num' : undefined}
            value={typing ?? display}
            placeholder={placeholder}
            aria-label={def.label}
            spellCheck={false}
            onFocus={() => {
              setTyping(def.kind === 'money' ? value : display);
              onFocus();
            }}
            onBlur={() => setTyping(null)}
            onChange={(e) => change(e.target.value)}
          />
        ) : (
          <span className={`bp-box-text${mono && display ? ' num' : ''}${display ? '' : ' bp-box-quiet'}`}>{display || placeholder}</span>
        )}
        {look === 'look' && editable ? (
          <button type="button" className="bp-tick" title={`Confirm ${display}`} aria-label={`Confirm ${display}`} onClick={onConfirm}>
            <TickGlyph size={10} />
          </button>
        ) : null}
        {look === 'confirmed' && by && typing === null ? (
          <span className="bp-done">✓<Avatar name={by.name} src={by.avatarUrl} size={14} /></span>
        ) : null}
      </div>
      {note ? <span className="bp-note">{note}</span> : null}
    </div>
  );
}
