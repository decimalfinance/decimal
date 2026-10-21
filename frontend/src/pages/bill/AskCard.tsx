// The companion's ask cards in the chat (61o–r): a question Decimal drafted,
// with Send question; one the person already has, so nothing is sent; or
// someone who only views bills, who can't be asked.
import type { CompanionActionCard } from '../../api';
import { Avatar } from '../../kit/Avatar';
import { Figures, TickGlyph, chatTime } from './parts';

const ASK_KINDS = new Set(['question', 'already_asked', 'cannot_ask']);
export const isAskCard = (card: CompanionActionCard) => ASK_KINDS.has(card.kind);

/**
 * A question Decimal drafted in the chat, with Send question; one the person
 * already has, so nothing is sent; or someone who only views bills, who can't
 * be asked. The person's face, then the bill, then the words.
 */
export function AskCard({ card, busy, sentAt, onRun }: {
  card: CompanionActionCard;
  busy: boolean;
  /** When the question it sent was asked, once it is on the bill. */
  sentAt: string | null;
  onRun: () => void;
}) {
  const split = /^(.*?):\s(.*)$/.exec(card.title);
  const head = split ? split[1]! : card.title;
  const bill = split?.[2] ?? '';
  const ref = /^(.*)\s(\S*\d\S*)$/.exec(bill);
  const person = card.kind === 'question' ? head.replace(/^Ask\s+/, '')
    : card.kind === 'already_asked' ? head.replace(/\s+already has this$/, '')
    : head.replace(/^Can['’]t ask\s+/, '');
  const asked = card.kind === 'question' ? (/^"([\s\S]*)"(?:\s·\s[^"]*)?$/.exec(card.detail)?.[1] ?? card.detail) : null;
  return (
    <div className="bp-askcard">
      <div className="bp-askcard-head">
        <Avatar name={person} size={16} />
        <span>
          <b>{head}:</b> {ref ? <>{ref[1]} <span className="num bp-askcard-ref">{ref[2]}</span></> : bill}
        </span>
      </div>
      {asked !== null
        ? <div className="bp-askcard-body">“<Figures text={asked} />”</div>
        : <div className="bp-askcard-body is-quiet"><Figures text={card.detail} /></div>}
      {card.kind !== 'question' ? null : card.status === 'proposed' ? (
        <div className="bp-askcard-foot">
          <button type="button" className="bp-pill is-primary" disabled={busy} onClick={onRun}>Send question</button>
        </div>
      ) : card.status === 'done' ? (
        <div className="bp-askcard-foot">
          <span className="bp-askcard-sent"><span className="bp-askcard-tick"><TickGlyph size={8} width={3.8} /></span>Question sent</span>
          {sentAt ? <span className="bp-askcard-time num">{chatTime(sentAt)}</span> : null}
        </div>
      ) : card.status === 'failed' ? (
        <div className="bp-askcard-foot is-failed">{card.result ?? 'That didn’t go through.'}</div>
      ) : null}
    </div>
  );
}
