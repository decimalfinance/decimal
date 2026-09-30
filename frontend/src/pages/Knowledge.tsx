// What I know — every category habit the companion applies, who taught it,
// and what it was told to forget. Anyone on the team can read it: knowing why
// a bill was pre-filled is part of trusting it. Admins keep or forget.

import { useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { knowledgeApi, type Habit } from '../api';
import { Ico } from '../dec/icons';
import { PageHead } from '../dec/primitives';
import { useToast } from '../ui/Toast';

function day(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${d.toLocaleDateString('en-US', { month: 'short' })} ${d.getFullYear()}`;
}

function how(h: Habit): string {
  if (h.source === 'manual') return `Set by ${h.setBy ?? 'a person'}`;
  const who = h.taughtBy.length === 0 ? '' : ` ${h.taughtBy.join(', ')} coded that way`;
  return `Learned from ${h.fromBills} ${h.fromBills === 1 ? 'bill' : 'bills'}${who}`;
}

export function KnowledgePage() {
  const { organizationId = '' } = useParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['knowledge', organizationId],
    queryFn: () => knowledgeApi.get(organizationId),
    enabled: Boolean(organizationId),
  });
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['knowledge', organizationId] }),
    queryClient.invalidateQueries({ queryKey: ['inbox', organizationId] }),
  ]);
  const keep = async (h: Habit) => {
    try { await knowledgeApi.keep(organizationId, h.ruleId); toast.success('Kept', `${h.vendorName} goes to ${h.category}.`); } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not keep it.'); }
    void refresh();
  };
  const forget = async (h: Habit) => {
    try {
      await knowledgeApi.forget(organizationId, h.counterpartyId);
      toast.success('Forgotten', `New ${h.vendorName} bills stop being pre-filled with ${h.category}. Confirmed bills are unchanged.`);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not forget it.'); }
    void refresh();
  };
  const data = q.data;
  const canManage = data?.canManage ?? false;

  return (
    <div className="page page-wide">
      <div className="stack stack-24">
        <PageHead
          eyebrow="Operations"
          title="What I know"
          desc="The category habits I apply to new bills, learned from what your team confirmed or set by hand. Forgetting one stops it at once: drafts nobody has saved are re-coded without it, and confirmed bills keep what was confirmed."
        />
        {q.isLoading ? <div className="skeleton" style={{ height: 240 }} /> : null}

        {data && data.habits.length === 0 ? (
          <div className="empty">
            <div className="empty-icon"><Ico.sparkle w={22} /></div>
            <h4>Nothing learned yet</h4>
            <p>When your team codes three bills from a vendor the same way, I learn it and tell you here and in your Inbox.</p>
          </div>
        ) : null}

        {data && data.habits.length > 0 ? (
          <section>
            <div className="sec-head">
              <div className="sh-titles">
                <h2>Category habits</h2>
                <p className="sh-desc">{data.habits.length} {data.habits.length === 1 ? 'vendor' : 'vendors'}.{canManage ? '' : ' Only an admin can keep or forget one.'}</p>
              </div>
            </div>
            <div className="tbl-card">
              <table className="tbl" style={{ tableLayout: 'fixed' }}>
                <thead>
                  <tr>
                    <th style={{ width: '22%' }}>Vendor</th>
                    <th style={{ width: '20%' }}>Category</th>
                    <th style={{ width: '28%' }}>How I know</th>
                    <th style={{ width: '10%' }}>Since</th>
                    <th className="num" style={{ width: '8%' }}>Bills since</th>
                    <th style={{ width: '12%' }} />
                  </tr>
                </thead>
                <tbody>
                  {data.habits.map((h) => (
                    <tr key={h.ruleId} style={{ cursor: 'default' }}>
                      <td>
                        <div className="cell-vendor"><div className="v-name">{h.vendorName}</div></div>
                        {!h.acknowledged ? <span className="pill pill-min pill-info">New</span> : null}
                      </td>
                      <td>{h.category}</td>
                      <td>{how(h)}</td>
                      <td><span className="cell-mono">{day(h.since)}</span></td>
                      <td className="td-num">{h.billsSince}</td>
                      <td>
                        {canManage ? (
                          <div className="ac-foot" style={{ marginTop: 0, justifyContent: 'flex-end' }}>
                            {!h.acknowledged ? <button type="button" className="ib-tick" onClick={() => void keep(h)}>Keep</button> : null}
                            <button type="button" className="ib-tick" onClick={() => void forget(h)}>Forget</button>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {data && data.forgotten.length > 0 ? (
          <section>
            <div className="sec-head">
              <div className="sh-titles">
                <h2>Forgotten</h2>
                <p className="sh-desc">I will not relearn these from the bills I learned them from. Three new bills coded the same way would teach me again.</p>
              </div>
            </div>
            <div className="tick-list">
              {data.forgotten.map((f) => (
                <div key={f.counterpartyId} className="tick-item">
                  <Ico.x w={14} />
                  <span><strong>{f.vendorName}</strong>{f.category ? ` going to ${f.category}` : ''}: forgotten {day(f.at)}{f.by ? ` by ${f.by}` : ''}.</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
