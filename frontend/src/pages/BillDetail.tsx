// Bill detail (Screen 3) + approver task view (Screen 4) — one layout, driven
// by who's looking and where the bill is (ap-claude-code-handoff-screen3).
// The approval route is the star: the compiled plan's people WITH their
// routing reasons, task states, and inline info-request threads — all from
// the engine's plan + event log, never hardcoded.
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  accessApi,
  approvalsApi,
  billsApi,
  type BillDetail,
  type BillDetailStepNode,
} from '../api';
import { Ico } from '../dec/icons';
import { useToast } from '../ui/Toast';
import { approvalActErrorMessage } from '../lib/app-helpers';
import { DocumentPane } from './InvoiceReview';

function usd(amount: number): string {
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// Deterministic person color (people get colored avatars; vendors never do).
const PERSON_COLORS = ['#B4632B', '#A24B6B', '#3F5FA8', '#2E7D5B', '#7A5CA8', '#3A7CA5', '#A8574A', '#5B7F3B'];
function personColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PERSON_COLORS[h % PERSON_COLORS.length]!;
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    + ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLowerCase();
}

const TONE_PILL: Record<string, string> = {
  success: 'pill-success', warning: 'pill-warning', danger: 'pill-danger', info: 'pill-info', neutral: 'pill-neutral',
};

type ComposerKind = 'reject' | 'info' | 'reply' | 'sendback';

export function BillDetailPage() {
  const { organizationId = '', paymentOrderId = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [composer, setComposer] = useState<ComposerKind | null>(null);
  const [composerText, setComposerText] = useState('');
  const [docOpen, setDocOpen] = useState(false);
  const [acting, setActing] = useState(false);
  const [factsOpen, setFactsOpen] = useState(false);

  const detailQuery = useQuery({
    queryKey: ['bill-detail', organizationId, paymentOrderId],
    queryFn: () => billsApi.detail(organizationId, paymentOrderId),
    enabled: Boolean(organizationId && paymentOrderId),
  });
  const detail = detailQuery.data;
  // Admin tier gates "send back to review" on an approved bill.
  const myAccess = useQuery({
    queryKey: ['my-access', organizationId],
    queryFn: () => accessApi.get(organizationId),
    enabled: Boolean(organizationId),
    staleTime: 60_000,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['bill-detail', organizationId, paymentOrderId] });
    void queryClient.invalidateQueries({ queryKey: ['bills-workbench', organizationId] });
  };

  const act = async (taskId: string | null | undefined, command: Record<string, unknown>, done: string) => {
    if (!taskId || acting) return;
    setActing(true);
    try {
      await approvalsApi.actOnTask(organizationId, taskId, command);
      toast.success(done);
      setComposer(null);
      setComposerText('');
      refresh();
    } catch (err) {
      toast.error('That didn\'t go through', approvalActErrorMessage(err));
    } finally {
      setActing(false);
    }
  };

  if (detailQuery.isLoading || !detail) {
    return (
      <div className="page page-wide">
        <div className="stack stack-24">
          <div className="skeleton" style={{ height: 60 }} />
          <div className="skeleton" style={{ height: 420 }} />
        </div>
      </div>
    );
  }

  const { review, corrections, approval, viewer, requester, status } = detail;
  const macro = approval?.macroState ?? null;
  const rejected = macro === 'rejected';
  const recalled = macro === 'cancelled';
  const approvedOverall = macro === 'approved' || macro === 'auto_approved';
  const steps = approval?.steps ?? [];
  const doneCount = steps.filter((s) => s.state === 'done').length;
  const currentNode = steps.find((s) => s.state === 'current') ?? null;
  const declinedNode = steps.find((s) => s.state === 'declined') ?? null;
  const infoOpenNode = steps.find((s) => s.thread?.open) ?? null;

  const invoiceNumber = String(review.fields.find((f) => f.key === 'invoiceNumber')?.value ?? review.vendor.name);
  const invoiceDate = review.fields.find((f) => f.key === 'invoiceDate')?.value ?? null;
  const terms = review.fields.find((f) => f.key === 'terms')?.value ?? null;
  const dueDate = review.fields.find((f) => f.key === 'dueDate')?.value ?? null;
  const discount = review.fields.find((f) => f.key === 'discount')?.value ?? null;

  const progressText = rejected
    ? `Declined${declinedNode?.person ? ` by ${declinedNode.person.name.split(' ')[0]}` : ''} · route stopped`
    : recalled
      ? 'Recalled by the submitter'
      : approvedOverall
        ? `${doneCount} of ${steps.length} approved`
        : infoOpenNode
          ? `${doneCount} of ${steps.length} approved · ${infoOpenNode.person?.name.split(' ')[0] ?? 'someone'} asked a question`
          : currentNode
            ? `${doneCount} of ${steps.length} approved · waiting on ${currentNode.person?.name.split(' ')[0] ?? 'next approver'}`
            : `${doneCount} of ${steps.length} approved`;

  // Viewer modes
  const viewerHasDecision = Boolean(viewer.openTaskId) && !rejected && !recalled && !approvedOverall;
  const viewerAskedOpen = Boolean(infoOpenNode && viewer.openTaskId
    && infoOpenNode.person?.personId && steps.some((s) => s === infoOpenNode && s.person?.personId !== viewer.personId) === false);
  const viewerBlockedByOwnAsk = Boolean(viewerHasDecision && infoOpenNode && infoOpenNode.person?.personId === viewer.personId);
  const operatorMode = viewer.isRequester && !viewerHasDecision;
  // Approved but unpaid: an admin may unwind the approval — the recovery path
  // when a release gate refuses (pinned destination, ceiling).
  const canSendBack = approvedOverall && review.state === 'draft' && Boolean(myAccess.data?.isOwnerOrAdmin);

  const composerMeta: Record<ComposerKind, { title: string; desc: string; placeholder: string; btn: string; btnClass: string }> = {
    reject: { title: 'Reject this bill', desc: `A reason is required — ${requester?.name ?? 'the submitter'} and the route will see it.`, placeholder: 'Why is this being rejected?', btn: 'Reject bill', btnClass: 'btn-danger' },
    info: { title: 'Request more info', desc: `Send it back to ${requester?.name ?? 'the submitter'} for a detail — the bill stays with you, not reset.`, placeholder: 'What do you need to see before approving?', btn: 'Send request', btnClass: 'btn-primary' },
    reply: { title: 'Reply', desc: 'Your answer goes to the approver who asked, and the route keeps moving.', placeholder: 'Answer the question…', btn: 'Send answer', btnClass: 'btn-primary' },
    sendback: { title: 'Send back to review', desc: 'Unwinds the approval: the bill returns to review, and re-confirming starts a fresh approval run under current rules.', placeholder: 'Why is it going back? Goes on the record.', btn: 'Send back', btnClass: 'btn-danger' },
  };

  const submitComposer = () => {
    const text = composerText.trim();
    if (!text || !composer) return;
    if (composer === 'reject') void act(viewer.openTaskId, { kind: 'reject', reason: text }, 'Rejected — the route stopped.');
    if (composer === 'info' && requester) void act(viewer.openTaskId, { kind: 'request_info', question: text, from: requester.personId }, 'Question sent.');
    if (composer === 'reply') void act(viewer.openAskTaskId, { kind: 'provide_info', answer: text }, 'Answer sent.');
    if (composer === 'sendback') {
      setActing(true);
      billsApi.sendBack(organizationId, paymentOrderId, text)
        .then(() => {
          toast.success('Back in review — the approval was unwound.');
          setComposer(null);
          setComposerText('');
          refresh();
        })
        .catch((err) => toast.error('That didn\'t go through', approvalActErrorMessage(err)))
        .finally(() => setActing(false));
    }
  };

  return (
    <div className="rev-shell">
      {/* Topbar */}
      <div className="topbar">
        <div className="tb-context">
          <button type="button" className="btn btn-ghost tb-back" onClick={() => navigate(`/organizations/${organizationId}/bills`)}>
            <Ico.chevLeft w={15} /> Bills
          </button>
        </div>
        <div className="tb-right">
          {viewer.name ? (
            <>
              <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>Viewing as</span>
              <span className="pill pill-min pill-neutral" style={{ paddingLeft: 4, gap: 6 }}>
                <span className="bd-msg-av" style={{ background: personColor(viewer.name) }}>{initialsOf(viewer.name)}</span>
                {viewer.name.split(' ')[0]} · {viewer.isRequester ? 'submitter' : 'approver'}
              </span>
            </>
          ) : null}
          {review.document ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDocOpen(true)}>
              <Ico.doc w={14} /> View invoice
            </button>
          ) : null}
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {/* Heading band */}
        <div style={{ padding: '22px 32px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 25, letterSpacing: '-0.02em', margin: 0, color: 'var(--text-primary)' }}>
                {invoiceNumber}
              </h1>
              <span className={`pill pill-min ${TONE_PILL[status.subStatus.tone] ?? 'pill-neutral'}`}>
                <span className="dot" />{recalled ? 'Recalled' : status.subStatus.text}
              </span>
            </div>
            <div style={{ fontSize: 13.5, color: 'var(--text-muted)', marginTop: 4 }}>
              {review.vendor.name}{review.lines[0]?.description ? ` · ${review.lines[0].description}` : ''}
            </div>
          </div>
          <div style={{ textAlign: 'right', flex: 'none' }}>
            <div className="mono" style={{ fontSize: 25, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--text-primary)' }}>
              {usd(review.totalUsd)}
            </div>
            {dueDate ? (
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 3 }}>
                Due {String(dueDate)}{discount ? ` · ${String(discount)}` : ''}
              </div>
            ) : null}
          </div>
        </div>

        {recalled ? (
          <div style={{ padding: '20px 32px 0' }}>
            <div className="callout callout-danger" style={{ alignItems: 'center' }}>
              <Ico.x w={16} />
              <span><b>This bill was recalled.</b> It's out of approval and back in the review queue — the approvers were notified.</span>
            </div>
          </div>
        ) : null}

        {/* Two columns */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.32fr 1fr', gap: 30, padding: '24px 32px 40px', alignItems: 'start' }}>

          {/* Left: the approval route */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 26, minWidth: 0 }}>
            <section>
              <div className="sec-head">
                <div className="sh-titles">
                  <h2>Approval route</h2>
                  <p className="sh-desc">
                    {steps.length > 0
                      ? `${steps.length} approver${steps.length === 1 ? '' : 's'}, in order — each chosen by a rule, shown below.`
                      : approval?.macroState === 'auto_approved'
                        ? 'Approved automatically — your flow required no sign-off for a bill like this.'
                        : 'This bill has not entered approval yet.'}
                  </p>
                </div>
                <span style={{ fontSize: 12.5, color: 'var(--text-muted)', flex: 'none' }}>
                  {steps.length > 0 ? progressText : ''}
                  {approval?.flowVersion != null ? (
                    // Provenance: flow edits are never retroactive, so the
                    // version that routed this bill stays true forever.
                    <span style={{ marginLeft: 10, fontSize: 11, color: 'var(--text-faint)' }} title="The published version of your approval flow that routed this bill">
                      flow v{approval.flowVersion}
                    </span>
                  ) : null}
                </span>
              </div>

              {approval?.protectionNote ? (
                <div className="callout callout-info" style={{ marginBottom: 20, alignItems: 'flex-start' }}>
                  <Ico.shield w={16} />
                  <span>{approval.protectionNote}</span>
                </div>
              ) : null}

              <div>
                {steps.map((node, i) => (
                  <StepRow key={`${node.stepIndex}-${node.person?.personId ?? i}`} node={node} last={i === steps.length - 1} />
                ))}
              </div>
            </section>

            {corrections.length > 0 ? (
              <section>
                <div className="sec-head">
                  <div className="sh-titles">
                    <h2>Changed during review</h2>
                    <p className="sh-desc">What a person corrected after the document was read — so you approve numbers a human stands behind, not raw machine output.</p>
                  </div>
                </div>
                <div className="surface" style={{ padding: '4px 16px' }}>
                  {corrections.map((c, i) => (
                    <div key={i} className="bd-chg">
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>{c.field}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span>Read as <span className="bd-strike">{c.from}</span></span>
                          <Ico.arrowRight w={12} />
                          <span><span className="bd-now">{c.to}</span>{c.by ? ` · ${c.by} corrected it` : ''}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </div>

          {/* Right: calm reference */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
            {(review.state === 'draft' || review.state === 'needs_review') ? (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: -8 }}>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFactsOpen(true)}>
                  Complete details
                </button>
              </div>
            ) : null}
            <div className="surface" style={{ padding: '6px 18px' }}>
              <div className="ref-row">
                <span className="ref-k">Vendor</span>
                <span className="ref-v">
                  {review.vendor.name}
                  {review.vendor.email ? (<><br /><span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{review.vendor.email}</span></>) : null}
                </span>
              </div>
              <div className="ref-row"><span className="ref-k">Invoice</span><span className="ref-v mono">{invoiceNumber}</span></div>
              {invoiceDate ? <div className="ref-row"><span className="ref-k">Invoice date</span><span className="ref-v">{String(invoiceDate)}</span></div> : null}
              {terms ? <div className="ref-row"><span className="ref-k">Terms</span><span className="ref-v">{String(terms)}</span></div> : null}
              <div className="ref-row">
                <span className="ref-k">Pay to</span>
                <span className="ref-v mono">
                  {review.paymentBlock.accountLast4
                    ? `Bank account ••••${review.paymentBlock.accountLast4}`
                    : review.paymentBlock.sendToLabel}
                  <br />
                  {review.paymentBlock.matchesVerified
                    ? <span style={{ color: 'var(--success)', fontSize: 11.5 }}>✓ Verified method</span>
                    : <span style={{ color: 'var(--text-muted)', fontSize: 11.5 }}>Verification pending</span>}
                </span>
              </div>
            </div>

            <div className="tbl-card">
              <table className="tbl tbl-slim">
                <thead>
                  <tr><th>Description</th><th>Category</th><th className="num">Amount</th></tr>
                </thead>
                <tbody>
                  {review.lines.map((line, i) => (
                    <tr key={i}>
                      <td>{line.description}</td>
                      <td><span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{line.category ?? '—'}</span></td>
                      <td className="td-num">{line.amount != null ? usd(line.amount) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 190 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24, fontSize: 12.5, color: 'var(--text-muted)' }}>
                    <span>Line items</span><span className="mono" style={{ color: 'var(--text-primary)' }}>{usd(review.lines.reduce((sum, l) => sum + (l.amount ?? 0), 0))}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24, fontSize: 12.5, color: 'var(--text-muted)' }}>
                    <span>Tax</span><span className="mono" style={{ color: 'var(--text-primary)' }}>{usd(review.taxAmount ?? 0)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24, fontSize: 14, fontWeight: 600, borderTop: '1px solid var(--border)', marginTop: 2, paddingTop: 6 }}>
                    <span>Total</span><span className="mono">{usd(review.totalUsd)}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Action bar */}
      <div className="commit-bar">
        {rejected && declinedNode ? (
          <>
            <span className="cb-note" style={{ color: 'var(--danger)', fontWeight: 600 }}>
              {declinedNode.person?.name.split(' ')[0] ?? 'An approver'} declined this bill
            </span>
            <span className="cb-note">The route stopped — nothing is scheduled to pay.</span>
            <span className="commit-spacer" />
          </>
        ) : recalled ? (
          <>
            <span className="cb-note" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Bill recalled — back in the review queue</span>
            <span className="commit-spacer" />
            <button type="button" className="btn btn-secondary" disabled={acting}
              onClick={() => void act(viewer.anyTaskId, { kind: 'resubmit' }, 'Back in approval.')}>Undo recall</button>
            <button type="button" className="btn btn-primary" onClick={() => navigate(`/organizations/${organizationId}/bills/${paymentOrderId}/review`)}>
              Open in review
            </button>
          </>
        ) : viewerHasDecision && viewerBlockedByOwnAsk ? (
          <>
            <span className="cb-note" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
              Waiting on {infoOpenNode?.thread?.waitingOn ?? 'an answer'}
            </span>
            <span className="cb-note">Approve is held until your question is answered.</span>
            <span className="commit-spacer" />
            <button type="button" className="btn btn-danger-ghost" onClick={() => setComposer('reject')} disabled={acting}>Reject</button>
            <button type="button" className="btn btn-primary" disabled>
              <Ico.checkSm w={15} /> Approve
            </button>
          </>
        ) : viewerHasDecision ? (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <span className="cb-note" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Your approval is needed</span>
              <span className="cb-note">You're authorizing {usd(review.totalUsd)} to {review.vendor.name}.</span>
            </div>
            {detail.signal ? (
              // Advisory only — the same routine/worth-a-look classifier as the
              // inbox, here at the moment of decision. It never acts for you.
              <span className={`pill pill-min ${detail.signal.clean ? 'pill-success' : 'pill-warning'}`} title={detail.signal.detail ?? undefined} style={{ flex: 'none', marginLeft: 12 }}>
                <span className="dot" />{detail.signal.label}
              </span>
            ) : null}
            <span className="commit-spacer" />
            <button type="button" className="btn btn-ghost" onClick={() => setComposer('info')} disabled={acting}>Request info</button>
            <button type="button" className="btn btn-secondary" disabled={acting}
              onClick={() => void act(viewer.openTaskId, { kind: 'push_back' }, 'Pushed back — the route was flagged.')}>Push back</button>
            <button type="button" className="btn btn-danger-ghost" onClick={() => setComposer('reject')} disabled={acting}>Reject</button>
            <button type="button" className="btn btn-primary" disabled={acting}
              onClick={() => void act(viewer.openTaskId, { kind: 'approve' }, 'Approved.')}>
              <Ico.checkSm w={15} /> Approve
            </button>
          </>
        ) : operatorMode ? (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <span className="cb-note" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>You submitted this bill</span>
              <span className="cb-note">
                {viewer.viewerHasOpenAsk
                  ? 'An approver asked a question — reply to keep it moving.'
                  : approvedOverall
                    ? 'Approved — moving to payment.'
                    : progressText}
              </span>
            </div>
            <span className="commit-spacer" />
            {viewer.viewerHasOpenAsk ? (
              <button type="button" className="btn btn-primary" onClick={() => setComposer('reply')} disabled={acting}>Reply</button>
            ) : null}
            {!approvedOverall ? (
              <button type="button" className="btn btn-secondary" disabled={acting}
                onClick={() => void act(viewer.anyTaskId, { kind: 'recall' }, 'Recalled — back in your review queue.')}>
                <Ico.reset w={14} /> Recall bill
              </button>
            ) : null}
            {canSendBack ? (
              <button type="button" className="btn btn-secondary" disabled={acting} onClick={() => setComposer('sendback')}>
                <Ico.reset w={14} /> Send back to review
              </button>
            ) : null}
          </>
        ) : (
          <>
            <span className="cb-note">{progressText || 'Tracking this bill.'}</span>
            <span className="commit-spacer" />
            {canSendBack ? (
              <button type="button" className="btn btn-secondary" disabled={acting} onClick={() => setComposer('sendback')}>
                <Ico.reset w={14} /> Send back to review
              </button>
            ) : null}
          </>
        )}
      </div>

      {/* Composer */}
      {composer ? (
        <div className="overlay" style={{ position: 'fixed', inset: 0, zIndex: 60 }}
          onClick={(e) => { if (e.target === e.currentTarget && !acting) setComposer(null); }}>
          <div className="dialog" role="dialog" aria-modal="true" style={{ maxWidth: 440 }}>
            <div className="dialog-head">
              <div>
                <h2>{composerMeta[composer].title}</h2>
                <p>{composerMeta[composer].desc}</p>
              </div>
              <button type="button" className="drawer-x" onClick={() => setComposer(null)} aria-label="Close">×</button>
            </div>
            <div className="dialog-body">
              <div className="bd-composer">
                <textarea
                  value={composerText}
                  placeholder={composerMeta[composer].placeholder}
                  onChange={(e) => setComposerText(e.target.value)}
                  autoFocus
                />
              </div>
            </div>
            <div className="dialog-foot">
              <button type="button" className="btn btn-secondary" onClick={() => setComposer(null)} disabled={acting}>Cancel</button>
              <button type="button" className={`btn ${composerMeta[composer].btnClass}`} onClick={submitComposer} disabled={acting || !composerText.trim()}>
                {composerMeta[composer].btn}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {factsOpen ? (
        <FactsDialog
          organizationId={organizationId}
          paymentOrderId={paymentOrderId}
          review={review}
          onClose={() => setFactsOpen(false)}
          onSaved={() => { setFactsOpen(false); refresh(); }}
        />
      ) : null}

      {/* Document drawer */}
      {docOpen && review.document ? (
        <div className="overlay" style={{ position: 'fixed', inset: 0, zIndex: 60 }}
          onClick={(e) => { if (e.target === e.currentTarget) setDocOpen(false); }}>
          <div className="drawer drawer-wide" style={{ width: 680, display: 'flex', flexDirection: 'column' }}>
            <div className="drawer-head">
              <div>
                <h2 style={{ margin: 0 }}>The invoice</h2>
                <p style={{ margin: '2px 0 0' }}>{review.document.filename} · exactly as {review.vendor.name} sent it</p>
              </div>
              <button type="button" className="drawer-x" onClick={() => setDocOpen(false)} aria-label="Close">×</button>
            </div>
            <DocumentPane organizationId={organizationId} document={review.document} width="100%" />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StepRow({ node, last }: { node: BillDetailStepNode; last: boolean }) {
  const name = node.person?.name ?? 'Unassigned';
  const done = node.state === 'done';
  const current = node.state === 'current';
  const upcoming = node.state === 'upcoming' || node.state === 'stopped';
  const declined = node.state === 'declined';

  const tag = declined
    ? { text: node.actedAt ? `Declined · ${timeLabel(node.actedAt)}` : 'Declined', pill: 'pill-danger' }
    : done
      ? { text: node.actedAt ? `Approved · ${timeLabel(node.actedAt)}` : 'Approved', pill: 'pill-success' }
      : current
        ? node.thread?.open
          ? { text: 'Asked a question', pill: 'pill-warning' }
          : { text: `Waiting on ${name.split(' ')[0]}`, pill: 'pill-info' }
        : node.state === 'stopped'
          ? { text: 'Route stopped', pill: 'pill-neutral' }
          : node.state === 'delegated'
            ? { text: 'Delegated', pill: 'pill-neutral' }
            : { text: 'Not yet their turn', pill: 'pill-neutral' };

  const bg = upcoming
    ? `color-mix(in srgb, ${personColor(name)} 42%, var(--bg-surface-2))`
    : personColor(name);

  return (
    <div style={{ position: 'relative', paddingBottom: 22 }}>
      {!last ? <span className={`bd-rail${done ? ' is-done' : ''}`} /> : null}
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <div style={{ position: 'relative', zIndex: 1, flex: 'none' }}>
          <span className={`bd-av${current ? ' is-current' : ''}`} style={{ background: bg }}>{initialsOf(name)}</span>
          {done ? <span className="bd-check"><Ico.checkSm w={9} /></span> : null}
        </div>
        <div style={{ flex: 1, minWidth: 0, opacity: upcoming ? 0.75 : 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{name}</span>
            <span className={`pill pill-min ${tag.pill}`}><span className="dot" />{tag.text}</span>
          </div>
          {node.purpose ? (
            <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 3 }}>{node.purpose}</div>
          ) : null}
          {node.declineReason ? (
            <div className="bd-comment is-danger">{node.declineReason}</div>
          ) : null}
          {node.thread ? (
            <div className="bd-thread">
              <div className="bd-thread-tag" style={{ color: node.thread.open ? 'var(--warning)' : 'var(--success)' }}>
                <span className="dot-i" />
                {node.thread.open ? `Waiting on ${node.thread.waitingOn ?? 'an answer'}` : 'Resolved'}
              </div>
              {node.thread.messages.map((m, i) => (
                <div key={i} style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
                  <span className="bd-msg-av" style={{ background: personColor(m.person?.name ?? '?') }}>
                    {initialsOf(m.person?.name ?? '?')}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{m.person?.name ?? 'Someone'}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{timeLabel(m.at)}</span>
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--text-primary)', marginTop: 2, lineHeight: 1.5 }}>{m.body}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// Tier-2/3 facts never block approval — they can be completed while the bill is
// already routing. Material fields (total, lines, categories) are absent by
// design: those change the route and go through recall/push-back instead.
function FactsDialog(props: {
  organizationId: string;
  paymentOrderId: string;
  review: BillDetail['review'];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { review } = props;
  const toast = useToast();
  const valueOf = (key: string) => {
    const v = review.fields.find((f) => f.key === key)?.value;
    return v == null ? '' : String(v);
  };
  const remitOf = (part: string) => {
    const v = review.remitFields.find((f) => f.key === `remitTo.${part}`)?.value;
    return v == null ? '' : String(v);
  };
  const [form, setForm] = useState<Record<string, string>>({
    invoiceNumber: valueOf('invoiceNumber'),
    invoiceDate: valueOf('invoiceDate'),
    dueDate: valueOf('dueDate'),
    terms: valueOf('terms'),
    poNumber: valueOf('poNumber'),
    discount: valueOf('discount'),
    vendorEmail: review.vendor.email ?? '',
    street: remitOf('street'),
    city: remitOf('city'),
    state: remitOf('state'),
    zip: remitOf('zip'),
  });
  const [saving, setSaving] = useState(false);
  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const save = async () => {
    setSaving(true);
    try {
      await billsApi.updateFacts(props.organizationId, props.paymentOrderId, {
        invoiceNumber: form.invoiceNumber || null,
        invoiceDate: form.invoiceDate || null,
        dueDate: form.dueDate || null,
        terms: form.terms || null,
        poNumber: form.poNumber || null,
        discount: form.discount || null,
        vendorEmail: form.vendorEmail || null,
        remitTo: { street: form.street || null, city: form.city || null, state: form.state || null, zip: form.zip || null },
      });
      toast.success('Details saved', 'Logged on the bill for the approvers.');
      props.onSaved();
    } catch (err) {
      toast.error('Could not save', err instanceof Error ? err.message : 'Try again.');
      setSaving(false);
    }
  };

  const FIELDS: Array<[string, string]> = [
    ['invoiceNumber', 'Invoice number'], ['invoiceDate', 'Invoice date'], ['dueDate', 'Due date'],
    ['terms', 'Terms'], ['poNumber', 'PO number'], ['discount', 'Discount'], ['vendorEmail', 'Vendor email'],
  ];
  const REMIT: Array<[string, string]> = [['street', 'Street'], ['city', 'City'], ['state', 'State'], ['zip', 'ZIP code']];

  return (
    <div className="overlay" style={{ position: 'fixed', inset: 0, zIndex: 60 }}
      onClick={(e) => { if (e.target === e.currentTarget && !saving) props.onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" style={{ maxWidth: 560 }}>
        <div className="dialog-head">
          <div>
            <h2>Complete details</h2>
            <p>These never hold up approval — add or correct them any time. Every change is logged on the bill.</p>
          </div>
          <button type="button" className="drawer-x" onClick={props.onClose} disabled={saving} aria-label="Close">×</button>
        </div>
        <div className="dialog-body">
          <div className="rev-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
            {FIELDS.map(([key, label]) => (
              <div key={key} className="rev-field">
                <span className="field-label">{label}</span>
                <input className="input" value={form[key] ?? ''} placeholder="Not on document" onChange={set(key)} />
              </div>
            ))}
          </div>
          <div className="rev-grid" style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr', marginTop: 14 }}>
            {REMIT.map(([key, label]) => (
              <div key={key} className="rev-field">
                <span className="field-label">{label}</span>
                <input className="input" value={form[key] ?? ''} placeholder="—" onChange={set(key)} />
              </div>
            ))}
          </div>
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn btn-secondary" onClick={props.onClose} disabled={saving}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save details'}
          </button>
        </div>
      </div>
    </div>
  );
}
