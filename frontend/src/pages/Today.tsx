// Today — the companion's briefing, and the page you land on.
//
// It speaks in the first person because it is the one who did the work: it
// read what came in, sorted it into what is ready and what needs a person, and
// says so. Each person sees their own work — the review piles for whoever
// reviews, what waits on them for an approver, and who is holding things up
// for an admin. Everything links to the bill it is about.

import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { companionApi, type CompanionBill, type CompanionToday } from '../api';
import { Ico } from '../dec/icons';
import { PageHead } from '../dec/primitives';

function usd(amount: number): string {
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "yesterday at 4:10 pm", "Monday at 9:02 am", "3 Sep at 11:40 am". */
function whenSaid(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (days <= 0) return `${time} today`;
  if (days === 1) return `yesterday at ${time}`;
  if (days < 7) return `${d.toLocaleDateString('en-US', { weekday: 'long' })} at ${time}`;
  return `${d.getDate()} ${d.toLocaleDateString('en-US', { month: 'short' })} at ${time}`;
}

function waitedFor(iso: string): string {
  const hours = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000));
  if (hours < 1) return 'under an hour';
  if (hours < 24) return plural(hours, 'hour');
  return plural(Math.floor(hours / 24), 'day');
}

/** The companion's opening line: what it did, then what is left. */
function openingLine(t: CompanionToday): string {
  const parts: string[] = [];
  if (t.viewer.canReview) {
    const needs = t.needsYou.length;
    const ready = t.ready.length;
    if (t.since && t.arrived.count === 0 && needs === 0 && ready === 0) {
      parts.push(`Nothing new since ${whenSaid(t.since)}. You're clear.`);
    } else {
      if (t.since) parts.push(`Since ${whenSaid(t.since)}, ${plural(t.arrived.count, 'bill')} came in and I've been through ${t.arrived.count === 1 ? 'it' : 'them'}.`);
      else parts.push(`I've been through everything open.`);
      if (ready + needs > 0) parts.push(`${ready} ${ready === 1 ? 'is' : 'are'} ready and ${needs} ${needs === 1 ? 'needs' : 'need'} you.`);
    }
    if (t.arrived.stillReading > 0) parts.push(`I'm still reading ${plural(t.arrived.stillReading, 'document')}.`);
  }
  if (t.waitingOnYou.length > 0) {
    parts.push(`${plural(t.waitingOnYou.length, 'bill')} ${t.waitingOnYou.length === 1 ? 'is' : 'are'} waiting on your approval.`);
  } else if (!t.viewer.canReview) {
    parts.push('Nothing is waiting on your approval.');
  }
  return parts.join(' ');
}

function BillRows({ bills, withReason, onOpen }: { bills: CompanionBill[]; withReason: boolean; onOpen: (id: string) => void }) {
  return (
    <div className="tbl-card">
      <table className="tbl" style={{ tableLayout: 'fixed' }}>
        <thead>
          <tr>
            <th style={{ width: withReason ? '28%' : '44%' }}>Vendor</th>
            <th style={{ width: '18%' }}>Invoice</th>
            <th className="num" style={{ width: '16%' }}>Amount</th>
            {withReason ? <th style={{ width: '34%' }}>Why it needs you</th> : null}
            <th style={{ width: '4%' }} />
          </tr>
        </thead>
        <tbody>
          {bills.map((b) => (
            <tr key={b.paymentOrderId} onClick={() => onOpen(b.paymentOrderId)}>
              <td><div className="cell-vendor"><div className="v-name">{b.vendorName}</div></div></td>
              <td><span className="cell-mono">{b.invoiceNumber ?? '—'}</span></td>
              <td className="td-num">{usd(b.amountUsd)}</td>
              {withReason ? <td style={{ color: 'var(--text-muted)' }}>{b.reason}</td> : null}
              <td><span className="row-arrow"><Ico.arrowRight w={14} /></span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TodayPage() {
  const { organizationId = '' } = useParams();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['companion-today', organizationId],
    queryFn: () => companionApi.today(organizationId),
    enabled: Boolean(organizationId),
    refetchInterval: 30_000,
  });
  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 5) return 'Working late';
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }, []);
  const openDraft = (id: string) => navigate(`/organizations/${organizationId}/bills/${id}/draft`);
  const openBill = (id: string) => navigate(`/organizations/${organizationId}/bills/${id}`);
  const t = q.data;
  const firstName = t?.viewer.name?.trim().split(/\s+/)[0];

  return (
    <div className="page page-wide">
      <div className="stack stack-24">
        <PageHead
          greet
          eyebrow="Operations"
          title={firstName ? `${greeting}, ${firstName}` : greeting}
          desc={t ? <><Ico.sparkle w={14} /> {openingLine(t)}</> : undefined}
          actions={t && t.ready.length > 0 ? (
            <button type="button" className="btn btn-primary" onClick={() => openDraft(t.ready[0]!.paymentOrderId)}>
              Review the ready bills
            </button>
          ) : undefined}
        />

        {q.isLoading ? <div className="skeleton" style={{ height: 280 }} /> : null}
        {q.isError ? (
          <div className="empty">
            <div className="empty-icon"><Ico.info w={22} /></div>
            <h4>I couldn't put the briefing together</h4>
            <p>Your bills are unaffected. Try again in a moment.</p>
          </div>
        ) : null}

        {t ? (
          <>
            {t.needsYou.length > 0 ? (
              <section>
                <div className="sec-head">
                  <div className="sh-titles">
                    <h2>Needs you</h2>
                    <p className="sh-desc">Each one has something I can't decide for you. Blocked bills first, then the largest.</p>
                  </div>
                </div>
                <BillRows bills={t.needsYou} withReason onOpen={openDraft} />
              </section>
            ) : null}

            {t.waitingOnYou.length > 0 ? (
              <section>
                <div className="sec-head">
                  <div className="sh-titles">
                    <h2>Waiting on your approval</h2>
                    <p className="sh-desc">Most overdue first.</p>
                  </div>
                </div>
                <div className="tbl-card">
                  <table className="tbl" style={{ tableLayout: 'fixed' }}>
                    <thead>
                      <tr><th style={{ width: '40%' }}>Vendor</th><th style={{ width: '20%' }}>Invoice</th><th className="num" style={{ width: '18%' }}>Amount</th><th style={{ width: '18%' }}>Due</th><th style={{ width: '4%' }} /></tr>
                    </thead>
                    <tbody>
                      {t.waitingOnYou.map((w) => (
                        <tr key={w.paymentOrderId} onClick={() => openBill(w.paymentOrderId)}>
                          <td><div className="cell-vendor"><div className="v-name">{w.vendorName}</div></div></td>
                          <td><span className="cell-mono">{w.invoiceNumber ?? '—'}</span></td>
                          <td className="td-num">{usd(w.amountUsd)}</td>
                          <td>{w.blocked ? 'Waiting on an answer' : w.overdueDays ? <span className="due-overdue">{plural(w.overdueDays, 'day')} overdue</span> : '—'}</td>
                          <td><span className="row-arrow"><Ico.arrowRight w={14} /></span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : null}

            {t.ready.length > 0 ? (
              <section>
                <div className="sec-head">
                  <div className="sh-titles">
                    <h2>Ready</h2>
                    <p className="sh-desc">Known vendors, coded from habits I've learned, nothing doubtful. They still need your confirm before they go to approval.</p>
                  </div>
                </div>
                <BillRows bills={t.ready} withReason={false} onOpen={openDraft} />
              </section>
            ) : null}

            {t.viewer.isAdmin && t.holding.length > 0 ? (
              <section>
                <div className="sec-head">
                  <div className="sh-titles">
                    <h2>Holding approvals</h2>
                    <p className="sh-desc">Who has bills waiting on them, longest wait first.</p>
                  </div>
                </div>
                <div className="tbl-card">
                  <table className="tbl" style={{ tableLayout: 'fixed' }}>
                    <thead><tr><th style={{ width: '50%' }}>Person</th><th style={{ width: '25%' }}>Waiting</th><th style={{ width: '25%' }}>Oldest for</th></tr></thead>
                    <tbody>
                      {t.holding.map((h) => (
                        <tr key={h.name} style={{ cursor: 'default' }}>
                          <td>{h.name}{h.isYou ? ' (you)' : ''}</td>
                          <td>{plural(h.openCount, 'bill')}</td>
                          <td>{waitedFor(h.waitingSince)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : null}

            {t.learned.length > 0 ? (
              <section>
                <div className="sec-head">
                  <div className="sh-titles">
                    <h2>What I learned</h2>
                    <p className="sh-desc">Habits I picked up from how your team codes bills. I apply them to new bills from these vendors.</p>
                  </div>
                </div>
                <div className="tick-list">
                  {t.learned.map((l) => (
                    <div key={l.id} className="tick-item">
                      <Ico.checkSm w={15} />
                      <span><strong>{l.vendorName}</strong> goes to <strong>{l.category}</strong>, from {plural(l.fromBills, 'bill')} coded that way.</span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
