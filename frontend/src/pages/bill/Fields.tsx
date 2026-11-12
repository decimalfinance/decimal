// The facts as boxes (5a): pink where Decimal read a value, peach and dashed
// where it wants a look (a round tick says the reading is right), white with a
// face once a person has changed it or ticked it, dashed grey where the
// document has none, red where the figure is wrong. Every box edits in place,
// and keeps its look while someone types in it: what they did shows when they
// leave it, as "Changed by", with what Decimal read, or "Checked by" for a tick.
// A value typed and put back is no change at all.
import { useState, type ReactNode } from 'react';
import { Avatar } from '../../kit/Avatar';
import { shown, type Face, type FieldDef, type FieldEntry, type Look, parseDay } from './model';
import { TickGlyph } from './parts';

export function lookOf(entry: FieldEntry | undefined, opts: { reading?: boolean; unread?: boolean; wrong?: boolean } = {}): Look {
  if (opts.reading) return 'reading';
  if (opts.wrong) return 'wrong';
  const value = entry?.value.trim() ?? '';
  if (entry?.state === 'changed') return 'changed';
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
  changed: 'is-confirmed',
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
  /** Who changed it, or ticked its reading, once someone has. */
  by: Face | null;
  /** What is wrong with it, under a red box. */
  wrongNote?: ReactNode;
  editable: boolean;
  onEdit: (value: string) => void;
  onConfirm: () => void;
  onFocus: () => void;
}) {
  const [typing, setTyping] = useState<string | null>(null);
  // The box and its note as they were when the person went into it, kept while
  // they type: what they did shows when they leave it, not on each keystroke.
  const [held, setHeld] = useState<{ look: Look; entry: FieldEntry | undefined; by: Face | null } | null>(null);
  const still = typing !== null && held ? held : null;
  const drawn = still ? still.look : look;
  const noteEntry = still ? still.entry : entry;
  const noteBy = still ? still.by : by;
  const value = entry?.value ?? '';
  const display = shown(def.kind, value);
  const mono = def.kind !== 'text';
  const placeholder = drawn === 'unread' ? 'Not read' : drawn === 'none' ? 'Not on the document' : '';

  const change = (text: string) => {
    setTyping(text);
    if (def.kind === 'date') onEdit(parseDay(text) ?? text);
    else onEdit(text);
  };

  let note: ReactNode = null;
  if (drawn === 'look' && noteEntry?.reason) note = <span>{noteEntry.reason}</span>;
  else if (drawn === 'wrong' && wrongNote) note = wrongNote;
  else if (drawn === 'changed') note = <>{noteBy ? <Avatar name={noteBy.name} src={noteBy.avatarUrl} size={12} /> : null}{changeWords(def, noteEntry, noteBy)}</>;
  else if (drawn === 'confirmed' && noteBy) note = <><Avatar name={noteBy.name} src={noteBy.avatarUrl} size={12} />Checked by {noteBy.name}</>;
  else if (drawn === 'read' && noteEntry?.inferred) note = <span>Worked out from the address</span>;

  return (
    <div className={`bp-field ${LOOK_CLASS[drawn]}`} data-focus={`field:${def.key}`}>
      <span className="bp-label">{def.label}</span>
      <div className="bp-box">
        {drawn === 'reading' ? null : editable ? (
          <input
            className={mono ? 'num' : undefined}
            value={typing ?? display}
            placeholder={placeholder}
            aria-label={def.label}
            spellCheck={false}
            onFocus={() => {
              setHeld({ look, entry, by });
              setTyping(def.kind === 'money' ? value : display);
              onFocus();
            }}
            onBlur={() => {
              setTyping(null);
              setHeld(null);
            }}
            onChange={(e) => change(e.target.value)}
          />
        ) : (
          <span className={`bp-box-text${mono && display ? ' num' : ''}${display ? '' : ' bp-box-quiet'}`}>{display || placeholder}</span>
        )}
        {drawn === 'look' && editable ? (
          <button type="button" className="bp-tick" title={`Confirm ${display}`} aria-label={`Confirm ${display}`} onClick={onConfirm}>
            <TickGlyph size={10} />
          </button>
        ) : null}
        {(drawn === 'confirmed' || drawn === 'changed') && by && typing === null ? (
          <span className="bp-done">{drawn === 'confirmed' ? '✓' : null}<Avatar name={by.name} src={by.avatarUrl} size={14} /></span>
        ) : null}
      </div>
      {note ? <span className="bp-note">{note}</span> : null}
    </div>
  );
}

/** What a person did to a field, under it: "Changed by Zara Okafor, was 10 Nov 2026". */
function changeWords(def: FieldDef, entry: FieldEntry | undefined, by: Face | null): string {
  const was = shown(def.kind, entry?.read ?? '');
  const now = entry?.value.trim() ?? '';
  const verb = !now ? 'Removed' : !was ? 'Added' : 'Changed';
  return `${verb}${by ? ` by ${by.name}` : ''}${was ? `, was ${was}` : ''}`;
}
