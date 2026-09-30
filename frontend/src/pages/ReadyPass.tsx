// The quick pass through ready bills.
//
// One by one, never all at once: the person looks at each ready bill on its
// own screen, and Enter sends it for approval exactly as read, then opens the
// next. → skips, Esc stops. The server re-checks every bill at the click
// (confirm-as-read), so a bill that stopped being ready since the list was
// made is refused, not sent. A bill someone has edited on screen is sent with
// the page's own Confirm, never from here: Enter would drop the edits.
//
// The pass lives in the URL (?pass=1&skipped=…), so a reload keeps your place.

import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { companionApi } from '../api';
import { Ico } from '../dec/icons';
import { useToast } from '../ui/Toast';

const useReadyBills = (organizationId: string) => useQuery({
  queryKey: ['ready-bills', organizationId],
  queryFn: () => companionApi.ready(organizationId),
  enabled: Boolean(organizationId),
});

const passUrl = (organizationId: string, billId: string, skipped: string[]) =>
  `/organizations/${organizationId}/bills/${billId}/draft?pass=1${skipped.length ? `&skipped=${skipped.join(',')}` : ''}`;

/** "Quick pass · 4 ready", for the pages a pass starts from. Nothing when none are ready. */
export function ReadyPassButton({ organizationId }: { organizationId: string }) {
  const navigate = useNavigate();
  const q = useReadyBills(organizationId);
  const first = q.data?.bills[0];
  if (!first) return null;
  return (
    <button type="button" className="btn btn-secondary" onClick={() => navigate(passUrl(organizationId, first.billId, []))}>
      <Ico.sparkle w={15} /> Quick pass · {q.data!.bills.length} ready
    </button>
  );
}

/** The pass's controls, in a bill's top bar. Only while a pass is on. */
export function ReadyPassBar({ organizationId, billId, dirty }: {
  organizationId: string;
  billId: string;
  /** The person changed something on this bill: send it with Confirm, not from here. */
  dirty: boolean;
}) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [sending, setSending] = useState(false);
  const on = params.get('pass') === '1';
  const skipped = (params.get('skipped') ?? '').split(',').filter(Boolean);
  const q = useReadyBills(on ? organizationId : '');
  const list = q.data?.bills ?? [];
  const here = list.find((b) => b.billId === billId) ?? null;
  const rest = list.filter((b) => b.billId !== billId && !skipped.includes(b.billId));

  const stop = () => navigate(`/organizations/${organizationId}/bills/${billId}/draft`, { replace: true });
  const goOn = (alsoSkip: string[]) => {
    const next = rest[0];
    if (next) {
      navigate(passUrl(organizationId, next.billId, [...skipped, ...alsoSkip]));
    } else {
      toast.success(skipped.length + alsoSkip.length > 0 ? 'The ones you skipped are still in Bills.' : 'Nothing else is ready to send.', 'That was the last ready bill');
      navigate(`/organizations/${organizationId}/bills`);
    }
  };
  const canSend = Boolean(here) && !dirty && !sending;
  const send = async () => {
    if (!here || dirty || sending) return;
    setSending(true);
    try {
      await companionApi.confirmAsRead(organizationId, billId);
      toast.success(`${here.vendorName}${here.invoiceNumber ? ` ${here.invoiceNumber}` : ''}`, 'Sent for approval');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['ready-bills', organizationId] }),
        queryClient.invalidateQueries({ queryKey: ['bills-workbench', organizationId] }),
        queryClient.invalidateQueries({ queryKey: ['inbox', organizationId] }),
      ]);
      goOn([]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'That did not go through.');
      await queryClient.invalidateQueries({ queryKey: ['ready-bills', organizationId] });
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const el = e.target as HTMLElement | null;
      // Typing, a focused control, or an open dialog keeps its own Enter.
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(el.tagName))) return;
      if (document.querySelector('.overlay')) return;
      if (e.key === 'Enter') { e.preventDefault(); void send(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goOn([billId]); }
      else if (e.key === 'Escape') { e.preventDefault(); stop(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!on || !q.data) return null;
  const left = rest.length + (here ? 1 : 0);
  const note = !here
    ? 'This bill is no longer ready to send as read.'
    : dirty ? 'You changed this bill: send it with Confirm below.' : null;

  return (
    <div className="tb-right">
      <span className="rp-count">Quick pass · {left} left</span>
      {note ? <span className="rp-note">{note}</span> : null}
      <button type="button" className="btn btn-ghost btn-sm" onClick={stop}>Stop <span className="kbd">Esc</span></button>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => goOn([billId])}>Skip <span className="kbd">→</span></button>
      <button type="button" className="btn btn-primary btn-sm" disabled={!canSend} onClick={() => void send()}>
        {sending ? 'Sending…' : 'Send for approval'} <span className="kbd">⏎</span>
      </button>
    </div>
  );
}
