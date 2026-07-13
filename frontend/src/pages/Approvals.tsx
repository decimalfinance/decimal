// Approvals inbox (Screen 4, ap-claude-code-handoff-approvals.md) — the
// approver's worklist. The star is the SIGNAL column: each waiting bill is
// clean (wave through inline) or flagged (Review only — must look first),
// classified server-side from correction events + vendor history.
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { approvalsApi, approvalsInboxApi, oooApi, rolesApi, type InboxWaitingRow, type InboxInFlightRow } from '../api';
import { approvalActErrorMessage } from '../lib/app-helpers';
import { useToast } from '../ui/Toast';
import { Ico } from '../dec/icons';
import { PageHead } from '../dec/primitives';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export function ApprovalsPage() {
  const { organizationId = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'you' | 'flight'>('you');
  const [search, setSearch] = useState('');
  const [approvingId, setApprovingId] = useState<string | null>(null);

  const inbox = useQuery({
    queryKey: ['approvals-inbox', organizationId],
    queryFn: () => approvalsInboxApi.get(organizationId),
    enabled: Boolean(organizationId),
    refetchInterval: 30_000,
  });

  // Out-of-office fill-in: while you're away, your approvals also go to them.
  const [oooOpen, setOooOpen] = useState(false);
  const ooo = useQuery({ queryKey: ['ooo', organizationId], queryFn: () => oooApi.get(organizationId), enabled: Boolean(organizationId) });
  const teamQ = useQuery({ queryKey: ['members-roles', organizationId], queryFn: () => rolesApi.get(organizationId), enabled: oooOpen });
  const setOooM = useMutation({
    mutationFn: (v: { substitutePersonId: string; endsAt: string }) => oooApi.set(organizationId, v.substitutePersonId, v.endsAt),
    onSuccess: (r) => {
      setOooOpen(false);
      toast.success('Fill-in set', r.mirrored > 0 ? `${r.mirrored} waiting bill${r.mirrored === 1 ? '' : 's'} shared with them right away.` : 'New approvals will reach them too while you are away.');
      void queryClient.invalidateQueries({ queryKey: ['ooo', organizationId] });
      void queryClient.invalidateQueries({ queryKey: ['approvals-inbox', organizationId] });
    },
    onError: (e) => toast.error('Could not set your fill-in', e instanceof Error ? e.message : 'Try again.'),
  });
  const clearOooM = useMutation({
    mutationFn: () => oooApi.clear(organizationId),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['ooo', organizationId] }); },
  });
  const activeOoo = ooo.data?.outOfOffice ?? null;

  const data = inbox.data;
  const q = search.trim().toLowerCase();
  const match = (vendor: string, invoice: string | null) =>
    !q || vendor.toLowerCase().includes(q) || (invoice ?? '').toLowerCase().includes(q);

  const waiting = useMemo(() => (data?.waitingOnYou ?? []).filter((r) => match(r.vendor, r.invoice)), [data, q]);
  const flight = useMemo(() => (data?.inFlight ?? []).filter((r) => match(r.vendor, r.invoice)), [data, q]);

  const openBill = (paymentOrderId: string) =>
    navigate(`/organizations/${organizationId}/bills/${paymentOrderId}`);

  const approveInline = async (row: InboxWaitingRow) => {
    if (approvingId) return;
    setApprovingId(row.taskId);
    try {
      await approvalsApi.actOnTask(organizationId, row.taskId, { kind: 'approve' });
      toast.success('Approved', `${row.vendor} · ${usd(row.amountUsd)}`);
      void queryClient.invalidateQueries({ queryKey: ['approvals-inbox', organizationId] });
      void queryClient.invalidateQueries({ queryKey: ['bills-workbench', organizationId] });
    } catch (err) {
      toast.error('Could not approve', approvalActErrorMessage(err));
    } finally {
      setApprovingId(null);
    }
  };

  const reviewFirst = () => {
    const firstFlag = waiting.find((r) => !r.signal.clean);
    if (firstFlag) openBill(firstFlag.paymentOrderId);
  };

  return (
    <div className="page page-wide">
      <div className="stack stack-24">
        <PageHead
          eyebrow="Governance"
          title="Approvals"
          desc={tab === 'you'
            ? 'Your worklist. The risky ones raise their hand — clear the rest fast.'
            : "Bills you've approved that are still moving through the route."}
          actions={
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button type="button" className="btn btn-secondary" onClick={() => setOooOpen(true)}>
                <Ico.members w={14} /> Away?
              </button>
              <div className="input-search" style={{ width: 260 }}>
                <Ico.search w={15} />
                <input className="input" placeholder="Search vendor or invoice #" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
            </div>
          }
        />

        {activeOoo ? (
          <div className="callout callout-info" style={{ alignItems: 'center' }}>
            <Ico.members w={15} />
            <span style={{ flex: 1 }}>
              While you're away, <b>{activeOoo.substituteName}</b> can approve in your place until <b>{new Date(activeOoo.endsAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</b>.
            </span>
            <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--accent)', flex: 'none' }} disabled={clearOooM.isPending} onClick={() => clearOooM.mutate()}>I'm back</button>
          </div>
        ) : null}

        <div className="filterbar">
          <div className="tabs">
            <button type="button" className={`tab${tab === 'you' ? ' on' : ''}`} onClick={() => setTab('you')}>
              Waiting on you<span className="tab-count">{data?.waitingOnYou.length ?? 0}</span>
            </button>
            <button type="button" className={`tab${tab === 'flight' ? ' on' : ''}`} onClick={() => setTab('flight')}>
              In flight<span className="tab-count">{data?.inFlight.length ?? 0}</span>
            </button>
          </div>
        </div>

        {inbox.isLoading ? (
          <div className="skeleton" style={{ height: 320 }} />
        ) : tab === 'you' ? (
          waiting.length === 0 ? (
            <div className="empty" style={{ margin: '40px 0' }}>
              <span className="empty-icon"><Ico.checkSm w={22} /></span>
              <h4>You're all caught up</h4>
              <p>Nothing is waiting on you right now. Bills routed to you will show up here.</p>
            </div>
          ) : (
            <>
              {data && data.summary.flagCount + data.summary.cleanCount > 0 ? (
                <div className="ai-strip">
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 16 }}>
                    {data.summary.flagCount > 0 ? (
                      <span className="sig sig-flag" style={{ height: 26 }}><Ico.shield w={12} />{data.summary.flagCount} need a look</span>
                    ) : null}
                    <span className="sig sig-clean" style={{ height: 26 }}><Ico.checkSm w={12} />{data.summary.cleanCount} ready to wave through</span>
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{usd(data.summary.totalWaitingUsd)} total waiting</span>
                  {data.summary.flagCount > 0 ? (
                    <button type="button" className="btn btn-primary btn-sm" onClick={reviewFirst}>
                      Review the {data.summary.flagCount}
                    </button>
                  ) : null}
                </div>
              ) : null}

              <div className="tbl-card">
                <table className="tbl ai-tbl" style={{ tableLayout: 'fixed' }}>
                  <thead>
                    <tr>
                      <th style={{ width: '21%' }}>Vendor</th>
                      <th className="num" style={{ width: '13%' }}>Amount</th>
                      <th style={{ width: '20%' }}>Where it is</th>
                      <th style={{ width: '27%' }}>Anything to check?</th>
                      <th style={{ width: '19%' }} />
                    </tr>
                  </thead>
                  <tbody>
                    {waiting.map((row) => (
                      <tr
                        key={row.taskId}
                        className={!row.signal.clean ? 'flag-row' : undefined}
                        onClick={() => openBill(row.paymentOrderId)}
                      >
                        <td>
                          <div style={{ fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>{row.vendor}</div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {row.what}{row.invoice ? <> · <span className="mono">{row.invoice}</span></> : null}
                          </div>
                        </td>
                        <td className="td-num">
                          <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{usd(row.amountUsd)}</span>
                          {row.overdueDays ? (
                            <div style={{ marginTop: 4, display: 'flex', justifyContent: 'flex-end' }}>
                              <span className="chip-disc chip-over"><Ico.shield w={10} />{row.overdueDays}d overdue</span>
                            </div>
                          ) : row.dueSoonDays != null ? (
                            <div style={{ marginTop: 4, display: 'flex', justifyContent: 'flex-end' }}>
                              <span className="chip-disc">due in {row.dueSoonDays}d</span>
                            </div>
                          ) : null}
                        </td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span className="prog-dot" style={{ background: 'var(--accent)' }} />
                            <span style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>{row.progText}</span>
                          </div>
                          {row.hint ? (
                            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3, paddingLeft: 13 }}>{row.hint}</div>
                          ) : null}
                        </td>
                        <td>
                          <span className={`sig ${row.signal.clean ? 'sig-clean' : 'sig-flag'}`}>
                            {row.signal.clean ? <Ico.checkSm w={12} /> : <Ico.shield w={12} />}
                            {row.signal.label}
                          </span>
                          {row.signal.detail ? (
                            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>{row.signal.detail}</div>
                          ) : null}
                        </td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }} onClick={(e) => e.stopPropagation()}>
                            {row.signal.clean && !row.blocked ? (
                              <>
                                <button type="button" className="qa" disabled={approvingId === row.taskId} onClick={() => approveInline(row)}>
                                  <Ico.checkSm w={13} />{approvingId === row.taskId ? 'Approving…' : 'Approve'}
                                </button>
                                <button type="button" className="btn btn-ghost btn-sm" onClick={() => openBill(row.paymentOrderId)}>Review</button>
                              </>
                            ) : (
                              <button type="button" className="btn btn-secondary btn-sm" onClick={() => openBill(row.paymentOrderId)}>
                                Review <Ico.chevRight w={13} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="tbl-foot">
                  <span className="tf-count">{waiting.length} bill{waiting.length === 1 ? '' : 's'}</span>
                  <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>Most urgent first · overdue, then flagged, then oldest</span>
                </div>
              </div>
            </>
          )
        ) : flight.length === 0 ? (
          <div className="empty" style={{ margin: '40px 0' }}>
            <span className="empty-icon"><Ico.checkSm w={22} /></span>
            <h4>Nothing in flight</h4>
            <p>Bills you approve that are still moving through the route will show up here.</p>
          </div>
        ) : (
          <div className="tbl-card">
            <table className="tbl ai-tbl" style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <th style={{ width: '26%' }}>Vendor</th>
                  <th className="num" style={{ width: '15%' }}>Amount</th>
                  <th style={{ width: '40%' }}>Where it is</th>
                  <th style={{ width: '19%' }} />
                </tr>
              </thead>
              <tbody>
                {flight.map((row: InboxInFlightRow) => (
                  <tr key={row.taskId} onClick={() => openBill(row.paymentOrderId)}>
                    <td>
                      <div style={{ fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>{row.vendor}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                        {row.what}{row.invoice ? <> · <span className="mono">{row.invoice}</span></> : null}
                      </div>
                    </td>
                    <td className="td-num"><span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{usd(row.amountUsd)}</span></td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span className="prog-dot" style={{ background: 'var(--text-faint)' }} />
                        <span style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>
                          {row.nowWith ? `Waiting on ${row.nowWith.split(' ')[0]}` : 'Moving to payment'}
                        </span>
                        {row.stalledDays ? (
                          <span className="chip-disc chip-over" style={{ marginLeft: 6 }}>stuck {row.stalledDays}d · may need a nudge</span>
                        ) : null}
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3, paddingLeft: 13 }}>You approved this</div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => openBill(row.paymentOrderId)}>
                          Track <Ico.chevRight w={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="tbl-foot">
              <span className="tf-count">{flight.length} bill{flight.length === 1 ? '' : 's'}</span>
              <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>Newest activity first</span>
            </div>
          </div>
        )}
      </div>

      {oooOpen ? (
        <OooDialog
          people={(teamQ.data?.members ?? []).filter((m) => m.personId)}
          current={activeOoo}
          busy={setOooM.isPending}
          onClose={() => setOooOpen(false)}
          onSave={(substitutePersonId, endsAt) => setOooM.mutate({ substitutePersonId, endsAt })}
        />
      ) : null}
    </div>
  );
}

// Pick who covers your approvals while you're away, and until when. Both of you
// can act on the same bills — audit history shows who actually approved.
function OooDialog(props: {
  people: Array<{ personId: string | null; name: string; email: string }>;
  current: { substitutePersonId: string; endsAt: string } | null;
  busy: boolean;
  onClose: () => void;
  onSave: (substitutePersonId: string, endsAt: string) => void;
}) {
  const [personId, setPersonId] = useState(props.current?.substitutePersonId ?? '');
  const [until, setUntil] = useState(() => {
    const d = props.current ? new Date(props.current.endsAt) : new Date(Date.now() + 7 * 24 * 3_600_000);
    return d.toISOString().slice(0, 10);
  });
  const submit = () => {
    if (!personId || !until) return;
    props.onSave(personId, new Date(`${until}T23:59:59`).toISOString());
  };
  return (
    <div className="overlay" style={{ position: 'fixed', inset: 0, zIndex: 60 }} onClick={(e) => { if (e.target === e.currentTarget && !props.busy) props.onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" style={{ maxWidth: 440 }}>
        <div className="dialog-head">
          <div><h2>Going away?</h2><p>Pick a fill-in — bills waiting on you can be approved by them too, and the record shows who acted.</p></div>
          <button type="button" className="drawer-x" onClick={props.onClose} aria-label="Close">×</button>
        </div>
        <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="field">
            <span className="field-label">Your fill-in</span>
            <div className="select">
              <select value={personId} onChange={(e) => setPersonId(e.target.value)}>
                <option value="">Pick a person…</option>
                {props.people.map((m) => (
                  <option key={m.personId!} value={m.personId!}>{m.name}</option>
                ))}
              </select>
            </div>
            <div className="input-help">Same rules apply to them — no one approves a bill they entered.</div>
          </div>
          <div className="field">
            <span className="field-label">Until</span>
            <input className="input" type="date" value={until} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setUntil(e.target.value)} />
          </div>
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn btn-secondary" onClick={props.onClose} disabled={props.busy}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={props.busy || !personId || !until}>{props.busy ? 'Saving…' : 'Set fill-in'}</button>
        </div>
      </div>
    </div>
  );
}
