// Small pieces the bill's page draws in many places: the evidence marks, a
// face that may be Decimal's, the dark note that sits under something on
// hover, and figures set in mono inside a sentence.
import { useState, type ReactNode } from 'react';
import { Avatar } from '../../kit/Avatar';
import { Orb } from '../../kit/Orb';
import { figureParts, type Face } from './model';

/** A green tick, a red cross or a yellow "!" in a 14px disc. */
export function Mark({ tone, size = 14 }: { tone: 'ok' | 'bad' | 'warn'; size?: number }) {
  if (tone === 'warn') {
    return (
      <svg className="bp-warn-mark" width={size} height={size} viewBox="2 2 20 20" aria-hidden>
        <circle cx="12" cy="12" r="10" />
        <rect x="11" y="7" width="2" height="6" />
        <rect x="11" y="15" width="2" height="2" />
      </svg>
    );
  }
  return (
    <span className={`bp-point-mark ${tone === 'ok' ? 'is-ok' : 'is-bad'}`} style={{ width: size, height: size }}>
      <svg width={Math.round(size * 0.64)} height={Math.round(size * 0.64)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {tone === 'ok' ? <path d="m5 12.5 4.5 4.5L19 7.5" /> : <path d="M7 7l10 10M17 7 7 17" />}
      </svg>
    </span>
  );
}

/** The small badge on a face in History: a tick or a cross. */
export function Badge({ good }: { good: boolean }) {
  return (
    <span className={`bp-badge ${good ? 'is-good' : 'is-bad'}`}>
      <svg width="6" height="6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {good ? <path d="m5.5 12.5 4 4 9-9" /> : <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />}
      </svg>
    </span>
  );
}

/** The chain's yellow badge: still waiting on this person. */
export function WaitBadge() {
  return (
    <span className="bp-badge is-waiting">
      <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <circle cx="4.5" cy="12" r="2.6" />
        <circle cx="12" cy="12" r="2.6" />
        <circle cx="19.5" cy="12" r="2.6" />
      </svg>
    </span>
  );
}

/** Someone's face, or Decimal's orb when it was Decimal. */
export function FaceOf({ who, size, orb = 'rest', bg = 'surf' }: {
  who: Face | 'decimal';
  size: number;
  orb?: 'rest' | 'work' | 'still';
  bg?: 'surf' | 'page' | 'white';
}) {
  if (who === 'decimal') {
    return (
      <span style={{ display: 'block', width: size, height: size }} title="Decimal agent">
        <Orb size={size} state={orb} bg={bg} />
      </span>
    );
  }
  return <Avatar name={who.name} src={who.avatarUrl} size={size} />;
}

/** "10:14" today, "12 Aug, 9:12" before. */
export function chatTime(value: string | Date, now = new Date()) {
  const d = new Date(value);
  const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return time;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getDate()} ${months[d.getMonth()]}${d.getFullYear() === now.getFullYear() ? '' : ` ${d.getFullYear()}`}, ${time}`;
}

export function Chevron({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: 'block' }}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function TickGlyph({ size = 10, width = 3 }: { size?: number; width?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: 'block' }}>
      <path d="m5.5 12.5 4 4 9-9" />
    </svg>
  );
}

/** A sentence with its money, dates and references set in mono. */
export function Figures({ text }: { text: string }) {
  return (
    <>
      {figureParts(text).map((p, i) => (p.mono ? <span key={i} className="num">{p.t}</span> : p.t))}
    </>
  );
}

/** A dark note under its anchor while the pointer rests on it. */
export function WithNote({ note, children, className }: { note: ReactNode | null; children: ReactNode; className?: string }) {
  const [on, setOn] = useState(false);
  return (
    <span
      className={className}
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setOn(true)}
      onMouseLeave={() => setOn(false)}
    >
      {children}
      {on && note ? <span className="bp-note-tip" role="tooltip">{note}</span> : null}
    </span>
  );
}

/** "Today, 10:14", "12 Aug, 9:12", "12 Aug 2025, 9:12". */
export function dayAndTime(value: string | Date, now = new Date()) {
  const d = new Date(value);
  const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return `Today, ${time}`;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = `${d.getDate()} ${months[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? `${day}, ${time}` : `${day} ${d.getFullYear()}, ${time}`;
}
