/**
 * The screen a finished setup leaves behind, for admins (IntegrationSetup.tsx shows
 * it once Go is pressed, while posting holds). A settings page:
 *
 * - Connection: the company bills post to, since when and who turned it on (or
 *   Sign in again, when Intuit's sign-in has run out), the setup conversation one
 *   click away and read only, and Disconnect.
 * - What Decimal follows: the closing date in force, then what the setup decided,
 *   in the API's words. The closing date moves as months close, so it is the one
 *   thing changed here, and only while it is Decimal's: when the books keep their
 *   own, posting goes by that one and so does this page. The books are read live
 *   for it, which takes a second or two, so only that row waits on them.
 * - The bills posting has dealt with since Go: those that need someone first, then
 *   what posted. Each opens its bill, where it is acted on.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  integrationSetupApi,
  type IntegrationBooksClosingDate,
  type IntegrationPosting,
  type IntegrationPostingBill,
  type IntegrationSetup,
  type IntegrationSetupFinished,
  type IntegrationSystem,
} from '../api';
import { Cells } from '../kit/Cells';
import { ConfirmDialog } from '../kit/Dialog';
import { calendarDay, fullDay, usd } from '../kit/format';
import { useToaster } from '../kit/Toast';
import { syncProblem } from './bill/model';
import { ChangedBy, Failed, Heading, messageOf } from './settings/parts';

const amount = (bill: IntegrationPostingBill) => usd(Number(bill.amountRaw) / 1_000_000);
const billPath = (organizationId: string, bill: IntegrationPostingBill) => `/organizations/${organizationId}/bills/${bill.paymentOrderId}`;

export function PostingScreen({ organizationId, system, name, setup, finished, meId, signingIn, onSignIn, onShow }: {
  organizationId: string;
  system: IntegrationSystem;
  name: string;
  setup: IntegrationSetup;
  finished: IntegrationSetupFinished;
  meId: string | null;
  signingIn: boolean;
  onSignIn: (path: string) => void;
  onShow: (next: IntegrationSetup) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toaster = useToaster();
  const [disconnect, setDisconnect] = useState<null | 'asking' | 'busy'>(null);
  const posting = useQuery({
    queryKey: ['integration-posting', organizationId, system],
    queryFn: () => integrationSetupApi.posting(organizationId, system),
  });
  const booksDate = useQuery({
    queryKey: ['integration-books-closing-date', organizationId, system],
    queryFn: () => integrationSetupApi.booksClosingDate(organizationId, system),
  });

  const company = setup.company.name ?? name;
  const signInAgain = setup.posting === 'signed_out' ? setup.signInAgain : null;
  const needYou = posting.data?.needYou ?? [];
  const sub = signInAgain
    ? `Decimal’s sign-in to ${name} expired, so nothing posts there until an admin signs in again.`
    : `Approved bills post to ${company}.${needYou.length === 0 ? '' : needYou.length === 1 ? ' One needs attention.' : ` ${needYou.length} need attention.`}`;

  async function disconnectNow() {
    setDisconnect('busy');
    try {
      // QuickBooks is the only system so far.
      await api.disconnectQuickBooks(organizationId);
      queryClient.removeQueries({ queryKey: ['integration-posting', organizationId, system] });
      queryClient.removeQueries({ queryKey: ['integration-books-closing-date', organizationId, system] });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['integration-setup', organizationId, system] }),
        queryClient.invalidateQueries({ queryKey: ['accounting-status', organizationId] }),
      ]);
      toaster.show(`Disconnected. Nothing posts to ${name} now, and nothing already there changed.`);
      setDisconnect(null);
    } catch (e) {
      toaster.show(messageOf(e));
      setDisconnect(null);
    }
  }

  return (
    <div className="ui page su-after">
      <h1 className="page-title">{name}</h1>
      <p className="page-sub">{sub}</p>
      {posting.isError ? (
        <div className="st-blocks">
          <div className="st-rows">
            <Failed what="This page" retry={() => void posting.refetch()} />
          </div>
        </div>
      ) : posting.isSuccess ? (
        <div className="st-blocks">
          <section>
            <Heading title="Connection" tight />
            <div className="st-rows">
              <div className="st-row">
                <div className="st-left">
                  <div className="st-label">{company}</div>
                  <div className="st-line">
                    {signInAgain
                      ? 'Intuit’s sign-in ran out, so approved bills wait. Sign in again to this company and they post.'
                      : `${finished.by ? `Turned on by ${finished.by.name}. ` : ''}Each bill posts as soon as it’s approved.`}
                  </div>
                </div>
                <div className="st-right">
                  {signInAgain ? (
                    <button type="button" className="st-pill is-primary" disabled={signingIn} onClick={() => onSignIn(signInAgain)}>
                      Sign in again
                    </button>
                  ) : finished.postingFrom ? (
                    <span className="st-value num">Posting since {fullDay(finished.postingFrom)}</span>
                  ) : null}
                </div>
              </div>
              <div className="st-row">
                <div className="st-left">
                  <div className="st-label">Setup conversation</div>
                  <div className="st-line">What Decimal found in your books and what was decided, as it was said.</div>
                </div>
                <div className="st-right">
                  <button type="button" className="st-pill" onClick={() => navigate({ search: '?view=conversation' })}>
                    Open
                  </button>
                </div>
              </div>
              <div className="st-row">
                <div className="st-left">
                  <div className="st-label">Disconnect</div>
                  <div className="st-line">Approved bills stop posting to {name}. Nothing already there changes.</div>
                </div>
                <div className="st-right">
                  <button type="button" className="st-pill" onClick={() => setDisconnect('asking')}>
                    Disconnect
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section>
            <Heading title="What Decimal follows" tight />
            <p className="st-sub">Agreed in the setup conversation. The closing date can change here as you close each month.</p>
            <div className="st-rows">
              <ClosingDateRow
                organizationId={organizationId}
                setupId={setup.setupId}
                name={name}
                said={finished.closingDate}
                inBooks={booksDate.isError ? { inBooks: null, read: false } : booksDate.data}
                meId={meId}
                onShow={onShow}
              />
              {finished.decisions.map((d) => (
                <div key={d.title} className="st-row">
                  <div className="st-left">
                    <div className="st-label">{d.title}</div>
                    <div className="st-line">{d.line}</div>
                  </div>
                  {d.value ? (
                    <div className="st-right">
                      <span className="st-value clip" title={d.value}>
                        {d.value}
                      </span>
                    </div>
                  ) : null}
                </div>
              ))}
              {finished.fromHistory.lines > 0 ? (
                <div className="st-row">
                  <div className="st-left">
                    <div className="st-label">Categories from your history</div>
                    <div className="st-line">When a line on a new bill matches one on your past bills, its Category is filled in the way it was coded then.</div>
                  </div>
                  <div className="st-right">
                    <span className="st-value num">
                      {finished.fromHistory.vendors} {finished.fromHistory.vendors === 1 ? 'vendor' : 'vendors'}
                    </span>
                  </div>
                </div>
              ) : null}
              {finished.worthKnowing.length > 0 ? (
                <div className="st-row">
                  <div className="st-left">
                    <div className="st-label">Worth knowing</div>
                    <div className="st-line">{finished.worthKnowing.join(' ')}</div>
                  </div>
                </div>
              ) : null}
            </div>
          </section>

          {needYou.length > 0 ? (
            <section>
              <Heading title="Needs attention" count={needYou.length} tight />
              <div className="st-rows">
                {needYou.map((bill) => (
                  <div key={bill.paymentOrderId} className="st-row">
                    <div className="st-left">
                      <div className="st-label">
                        {bill.vendor}
                        {bill.invoiceNumber ? <span className="num"> · {bill.invoiceNumber}</span> : null}
                      </div>
                      <div className="st-line">
                        {bill.status === 'held'
                          ? `${name} may have this bill already, so it’s held back. Say on the bill whether it’s the same one.`
                          : `${name} refused it: ${syncProblem(bill.error) ?? 'it gave no reason'}.${bill.retrying ? ' Decimal tries again by itself.' : ''}`}
                      </div>
                    </div>
                    <div className="st-right">
                      <span className="st-value num">{amount(bill)}</span>
                      <button type="button" className="st-pill" onClick={() => navigate(billPath(organizationId, bill))}>
                        Open
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <Posted organizationId={organizationId} name={name} posting={posting.data} />
        </div>
      ) : null}

      {disconnect ? (
        <ConfirmDialog
          title={`Disconnect ${name}?`}
          line={`Approved bills stop posting to ${company}. Nothing already in ${name} changes. To post there again, it’s set up again.`}
          confirmLabel="Disconnect"
          cancelLabel="Keep it"
          tone="remove"
          busy={disconnect === 'busy'}
          onConfirm={() => void disconnectNow()}
          onCancel={() => setDisconnect(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * The date the books are closed through: a bill dated on or before it doesn't post.
 * The books' own wins when they keep one, as posting reads it, and then it is only
 * shown. Otherwise it is Decimal's, changed here: empty means never closed. Until
 * the books have answered, the value is blank: which date is in force isn't known.
 */
function ClosingDateRow({ organizationId, setupId, name, said, inBooks, meId, onShow }: {
  organizationId: string;
  setupId: string;
  name: string;
  said: IntegrationSetupFinished['closingDate'];
  /** Undefined until the books have answered. */
  inBooks: IntegrationBooksClosingDate | undefined;
  meId: string | null;
  onShow: (next: IntegrationSetup) => void;
}) {
  const toaster = useToaster();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) field.current?.focus({ preventScroll: true });
  }, [editing]);

  if (!inBooks) {
    return (
      <div className="st-row">
        <div className="st-left">
          <div className="st-label">Closing date</div>
          <div className="st-line">A bill dated on or before it doesn’t post.</div>
        </div>
      </div>
    );
  }

  if (inBooks.read && inBooks.inBooks) {
    return (
      <div className="st-row">
        <div className="st-left">
          <div className="st-label">Closing date</div>
          <div className="st-line">Set in {name}, so Decimal goes by it as you close each month there. A bill dated on or before it doesn’t post.</div>
        </div>
        <div className="st-right">
          <span className="st-value num">{calendarDay(inBooks.inBooks)}</span>
        </div>
      </div>
    );
  }

  const change = async (date: string | null) => onShow(await integrationSetupApi.closingDate(organizationId, setupId, date));

  function open() {
    setDraft(said.said ?? '');
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
    const next = draft || null;
    if (next === said.said) {
      cancel();
      return;
    }
    const before = said.said;
    setBusy(true);
    try {
      await change(next);
      setEditing(false);
      toaster.show(next ? `Closed through ${calendarDay(next)} now.` : 'Never closed now, so no bill is held back for its date.', {
        undo: () => void change(before).catch((e) => toaster.show(messageOf(e))),
      });
    } catch (e) {
      setError(messageOf(e));
      field.current?.focus({ preventScroll: true });
    } finally {
      setBusy(false);
    }
  }

  const line = editing
    ? 'Leave it empty if the books have never been closed.'
    : inBooks.read
      ? `A bill dated on or before it doesn’t post. ${name} keeps no closing date of its own, so change this one when you close a month.`
      : 'A bill dated on or before it doesn’t post. Change it when you close a month.';
  const today = new Date();
  const max = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  return (
    <div className="st-row">
      <div className="st-left">
        <div className="st-label">Closing date</div>
        <div className={`st-line${error ? ' is-error' : ''}`} role={error ? 'alert' : undefined}>
          {error ?? line}
        </div>
      </div>
      <div className="st-right">
        {editing ? (
          <>
            <input
              ref={field}
              type="date"
              className={`st-field${error ? ' is-error' : ''}`}
              aria-label="Closed through"
              aria-invalid={error ? true : undefined}
              value={draft}
              max={max}
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
            <div className="st-card-value">
              <span className={`st-value num${said.said ? '' : ' is-quiet'}`}>{said.said ? calendarDay(said.said) : 'Never closed'}</span>
              {said.changed ? (
                <ChangedBy change={{ at: said.changed.at, personId: said.changed.by?.userId ?? null, name: said.changed.by?.name ?? null }} myPersonId={meId} />
              ) : null}
            </div>
            <button type="button" className="st-pill" onClick={open}>
              Change
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** What posting did since Go, still posting first. Each row opens its bill. */
function Posted({ organizationId, name, posting }: { organizationId: string; name: string; posting: IntegrationPosting }) {
  const { posted, postedCount } = posting;
  return (
    <section>
      <Heading title="Posted" count={postedCount} tight />
      {posted.length === 0 ? (
        <div className="st-rows">
          <div className="st-empty">Nothing posted yet. A bill posts to {name} as soon as it’s approved.</div>
        </div>
      ) : (
        <div className="su-posted">
          <div className="bl-head">
            <Cells>
              <span className="bl-th">VENDOR</span>
              <span className="bl-th">INVOICE</span>
              <span className="bl-th is-end">AMOUNT</span>
              <span className="bl-th">POSTED</span>
            </Cells>
          </div>
          {posted.map((bill) => (
            <Link key={bill.paymentOrderId} to={billPath(organizationId, bill)} className="bl-row" title={`Opens ${bill.invoiceNumber ?? 'the bill'}`}>
              <Cells>
                <span className="bl-td bl-vendor">{bill.vendor}</span>
                <span className="bl-td bl-inv num">{bill.invoiceNumber ?? '—'}</span>
                <span className="bl-td is-end bl-amt num">{amount(bill)}</span>
                {bill.status === 'pending' ? (
                  <span className="bl-td bl-due">Posting…</span>
                ) : bill.linked ? (
                  <span className="bl-td bl-due" title={`It was in ${name} already, entered by hand, so Decimal linked this bill to it.`}>
                    Already there
                  </span>
                ) : (
                  <span className="bl-td bl-due num">{fullDay(bill.at)}</span>
                )}
              </Cells>
            </Link>
          ))}
        </div>
      )}
      {postedCount > posted.length ? (
        <p className="st-sub su-more">
          The latest {posted.length} of {postedCount}.
        </p>
      ) : null}
    </section>
  );
}
