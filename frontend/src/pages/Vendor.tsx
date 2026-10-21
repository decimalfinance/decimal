// A vendor's page (Vendors.dc.html 2a, and 2d's blocks when they apply): its
// details under its name, its hold and its other names when it has them, then
// every bill it has sent, by stage. No figures and no payment details: neither
// is designed yet.
import { Fragment, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { accessApi, api, billsApi, type WorkbenchBill } from '../api';
import type { Counterparty, VendorPayableHold } from '../types';
import { Avatar } from '../kit/Avatar';
import { Cells } from '../kit/Cells';
import { ConfirmDialog, Dialog } from '../kit/Dialog';
import { fullDay, monthOf, usd } from '../kit/format';
import { useToaster } from '../kit/Toast';
import { classify, STAGE_EMPTY, STAGES, type Stage } from './billStatus';
import { heldBills, isVendor, locationOf, vendorRow, type VendorAddress } from './vendorRows';

type Status = { status: 'payable' | 'held' | 'blocked'; reason: string | null };

function messageOf(e: unknown) {
  return e instanceof Error && e.message ? e.message : 'That didn’t go through. Try again.';
}

export function VendorPage() {
  const { organizationId = '', counterpartyId = '' } = useParams();
  const queryClient = useQueryClient();
  const toaster = useToaster();

  const session = useQuery({ queryKey: ['session'], queryFn: () => api.getSession(), staleTime: Infinity });
  const access = useQuery({
    queryKey: ['my-access', organizationId],
    queryFn: () => accessApi.get(organizationId),
    enabled: Boolean(organizationId),
    staleTime: 60_000,
  });
  const vendors = useQuery({
    queryKey: ['counterparties', organizationId],
    queryFn: () => api.listCounterparties(organizationId),
    enabled: Boolean(organizationId),
  });
  const workbench = useQuery({
    queryKey: ['bills-workbench', organizationId],
    queryFn: () => billsApi.workbench(organizationId),
    enabled: Boolean(organizationId),
  });

  const [stage, setStage] = useState<Stage | 'all'>('all');
  const [holding, setHolding] = useState(false);
  const [releasing, setReleasing] = useState(false);

  const vendor = vendors.data?.items.find((v) => v.counterpartyId === counterpartyId && isVendor(v)) ?? null;
  const row = useMemo(() => (vendor ? vendorRow(vendor, workbench.data?.bills ?? []) : null), [vendor, workbench.data]);
  const me = session.data?.user;
  const canHold = access.data?.isPrimaryOrAdmin ?? false;
  const isPrimary = access.data?.membershipRole === 'primary_admin';
  const viewer = { userId: me?.userId ?? '', canReview: access.data?.capabilities.includes('bills.edit') ?? false };

  const setStatus = useMutation({
    mutationFn: (next: Status) => api.setVendorPayableStatus(organizationId, counterpartyId, next),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['counterparties', organizationId] });
      // A hold changes what blocks the vendor's bills, wherever they are shown.
      void queryClient.invalidateQueries({ queryKey: ['bills-workbench', organizationId] });
      void queryClient.invalidateQueries({ queryKey: ['inbox', organizationId] });
    },
  });

  function change(next: Status, done: string, undo: Status) {
    setStatus.mutate(next, {
      onSuccess: () => {
        setHolding(false);
        setReleasing(false);
        toaster.show(done, {
          undo: () => setStatus.mutate(undo, { onError: (e) => toaster.show(messageOf(e)) }),
        });
      },
      onError: (e) => {
        setReleasing(false);
        // The hold dialog shows its own error and stays open.
        if (!holding) toaster.show(messageOf(e));
      },
    });
  }

  const loaded = vendors.isSuccess && workbench.isSuccess && access.isSuccess;
  const failed = vendors.isError || workbench.isError;
  const name = vendor?.displayName ?? null;

  return (
    <div className="ui vd-page">
      <div className="bp-crumb">
        <Link to={`/organizations/${organizationId}/counterparties`}>Vendors</Link>
        {name ? (
          <>
            <span className="bp-crumb-sep">/</span>
            <span>{name}</span>
          </>
        ) : null}
      </div>

      <div className="vd-scroll">
        {failed ? (
          <div className="vd-note">
            This vendor couldn’t be loaded.
            <button
              type="button"
              className="bl-showall"
              onClick={() => {
                void vendors.refetch();
                void workbench.refetch();
              }}
            >
              Try again
            </button>
          </div>
        ) : !loaded ? null : !vendor || !row ? (
          <div className="vd-note">
            This vendor couldn’t be found.
            <Link to={`/organizations/${organizationId}/counterparties`} className="bl-showall">
              All vendors
            </Link>
          </div>
        ) : (
          <>
            <div className="list-head vd-head">
              <div style={{ minWidth: 0 }}>
                <h1 className="list-title">{vendor.displayName}</h1>
                <div className="list-sub">
                  <SubLine bills={row.bills} location={locationOf(row.address)} />
                </div>
              </div>
              {row.hold ? null : (
                <Gated allowed={canHold} why="Only an admin can put a vendor on hold" className="vd-act">
                  {(off) => (
                    <button
                      type="button"
                      className={`btn${off ? ' is-primary' : ''}`}
                      aria-disabled={off || undefined}
                      tabIndex={off ? -1 : undefined}
                      onClick={
                        off
                          ? undefined
                          : () => {
                              setStatus.reset();
                              setHolding(true);
                            }
                      }
                    >
                      Put on hold
                    </button>
                  )}
                </Gated>
              )}
            </div>

            <Details email={row.email} address={row.address} />

            {row.hold || row.aliases.length > 0 ? (
              <div className="vd-blocks">
                {row.hold ? (
                  <HoldBox
                    vendor={vendor}
                    hold={row.hold}
                    held={heldBills(row)}
                    canRelease={canHold && (row.hold.status !== 'blocked' || isPrimary)}
                    why={
                      canHold ? 'Only the primary admin can unblock a vendor' : 'Only an admin can release a hold'
                    }
                    onRelease={() => setReleasing(true)}
                  />
                ) : null}
                {row.aliases.length > 0 ? (
                  <div className="vd-block">
                    <div className="vd-block-title">Also billed as</div>
                    {row.aliases.map((a) => (
                      <div key={a} className="vd-alias">
                        {a}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            <BillTable
              bills={row.bills}
              stage={stage}
              onStage={setStage}
              viewer={viewer}
              organizationId={organizationId}
            />
          </>
        )}
      </div>

      {holding && vendor ? (
        <HoldDialog
          name={vendor.displayName}
          busy={setStatus.isPending}
          error={setStatus.isError ? messageOf(setStatus.error) : null}
          onCancel={() => {
            setHolding(false);
            setStatus.reset();
          }}
          onConfirm={(reason) =>
            change({ status: 'held', reason }, `${vendor.displayName} is on hold.`, { status: 'payable', reason: null })
          }
        />
      ) : null}
      {releasing && vendor && row?.hold ? (
        <ConfirmDialog
          title={`Release the hold on ${vendor.displayName}?`}
          line="Its bills can be sent for approval again."
          confirmLabel="Release hold"
          busy={setStatus.isPending}
          onCancel={() => setReleasing(false)}
          onConfirm={() => {
            const was = row.hold!;
            change({ status: 'payable', reason: null }, `The hold on ${vendor.displayName} is released.`, {
              status: was.status,
              reason: was.reason,
            });
          }}
        />
      ) : null}
    </div>
  );
}

/** "Tacoma, WA · 14 bills since Mar 2025" */
function SubLine({ bills, location }: { bills: WorkbenchBill[]; location: string | null }) {
  const first = bills[bills.length - 1];
  return (
    <>
      {location ? `${location} · ` : null}
      {first ? (
        <>
          <span className="num">{bills.length}</span> {bills.length === 1 ? 'bill' : 'bills'} since{' '}
          <span className="num">{monthOf(first.createdAt)}</span>
        </>
      ) : (
        'No bills yet'
      )}
    </>
  );
}

/** A control someone may not use: greyed, and on pointing it says who can. */
function Gated({
  allowed,
  why,
  className,
  children,
}: {
  allowed: boolean;
  why: string;
  className?: string;
  children: (off: boolean) => ReactNode;
}) {
  const [tip, setTip] = useState(false);
  return (
    <span
      className={`bp-tipwrap${className ? ` ${className}` : ''}`}
      onMouseEnter={allowed ? undefined : () => setTip(true)}
      onMouseLeave={allowed ? undefined : () => setTip(false)}
    >
      {children(!allowed)}
      {tip && !allowed ? <span className="tip">{why}</span> : null}
    </span>
  );
}

/** Digits in Geist Mono, the words around them not. */
function Figures({ text }: { text: string }) {
  return <>{text.split(/(\d[\d,.-]*)/).map((part, i) => (i % 2 ? <span key={i} className="num">{part}</span> : part))}</>;
}

/** The vendor's details as its newest bill gives them: a plain grid, no box, no title. */
function Details({ email, address }: { email: string | null; address: VendorAddress | null }) {
  if (!email && !(address && Object.values(address).some(Boolean))) return null;
  const value = (text: string | null | undefined, figures = false) =>
    text ? (
      <span className="bp-kv-v">{figures ? <Figures text={text} /> : text}</span>
    ) : (
      <span className="bp-kv-v is-none">—</span>
    );
  const rows: Array<[string, ReactNode, string, ReactNode]> = [
    ['Email', value(email), 'Street', value(address?.street, true)],
    ['City', value(address?.city), 'State', value(address?.state)],
    ['ZIP code', value(address?.zip, true), 'Country', value(address?.country)],
  ];
  return (
    <div className="vd-details">
      <div className="bp-kv">
        {rows.map(([k1, v1, k2, v2]) => (
          <Fragment key={k1}>
            <span className="bp-kv-k">{k1}</span>
            {v1}
            <span />
            <span className="bp-kv-k">{k2}</span>
            {v2}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/** "Holds 1 bill: OT-118 · $6,210.00"; past two, "OT-118, OT-131 and 2 more". */
function holdsLine(bills: WorkbenchBill[]) {
  const shown = bills.length <= 2 ? bills : bills.slice(0, 2);
  const number = (b: WorkbenchBill) =>
    b.invoiceNumber ? <span className="num">{b.invoiceNumber}</span> : 'one with no number';
  const total = bills.reduce((sum, b) => sum + b.amountUsd, 0);
  return (
    <>
      Holds <span className="num">{bills.length}</span> {bills.length === 1 ? 'bill' : 'bills'}:{' '}
      {shown.map((b, i) => (
        <Fragment key={b.paymentOrderId}>
          {i === 0 ? null : bills.length <= 2 ? ' and ' : ', '}
          {number(b)}
        </Fragment>
      ))}
      {bills.length > 2 ? (
        <>
          {' and '}
          <span className="num">{bills.length - 2}</span> more
        </>
      ) : null}
      {' · '}
      <span className="num">{usd(total)}</span>
    </>
  );
}

/** Who held it, when, why, and what it is holding (2d). White: a person did this, not Decimal. */
function HoldBox({
  vendor,
  hold,
  held,
  canRelease,
  why,
  onRelease,
}: {
  vendor: Counterparty;
  hold: VendorPayableHold;
  held: WorkbenchBill[];
  canRelease: boolean;
  why: string;
  onRelease: () => void;
}) {
  const blocked = hold.status === 'blocked';
  return (
    <div className="vd-block">
      <div className="vd-block-title">{blocked ? 'Blocked' : 'On hold'}</div>
      <div className="vd-hold">
        <div className="vd-hold-name">
          <span>{vendor.displayName}</span>
          <span className="chip is-hold">{blocked ? 'Blocked' : 'On hold'}</span>
        </div>
        <Gated allowed={canRelease} why={why} className="vd-hold-act">
          {(off) => (
            <button
              type="button"
              className={`btn vd-small${off ? ' is-primary' : ''}`}
              aria-disabled={off || undefined}
              tabIndex={off ? -1 : undefined}
              onClick={off ? undefined : onRelease}
            >
              Release hold
            </button>
          )}
        </Gated>
        <div className="vd-hold-by">
          <Avatar name={hold.byName} size={14} />
          <span>
            {blocked ? 'Blocked' : 'Held'} by {hold.byName}
            {hold.at ? (
              <>
                {' · '}
                <span className="num">{fullDay(hold.at)}</span>
              </>
            ) : null}
          </span>
        </div>
        <div className="vd-hold-why">
          {hold.reason ? `“${hold.reason}”` : null}
          {hold.reason && held.length > 0 ? ' ' : null}
          {held.length > 0 ? <span className="vd-hold-holds">{holdsLine(held)}</span> : null}
        </div>
      </div>
    </div>
  );
}

/** The stage bar and every bill the vendor has sent, newest first. */
function BillTable({
  bills,
  stage,
  onStage,
  viewer,
  organizationId,
}: {
  bills: WorkbenchBill[];
  stage: Stage | 'all';
  onStage: (stage: Stage | 'all') => void;
  viewer: { userId: string; canReview: boolean };
  organizationId: string;
}) {
  const rows = bills.map((bill) => ({ bill, ...classify(bill, viewer) }));
  const counts: Record<Stage | 'all', number> = { all: rows.length, review: 0, approval: 0, done: 0 };
  for (const r of rows) counts[r.stage] += 1;
  const shown = rows.filter((r) => stage === 'all' || r.stage === stage);
  return (
    <>
      <div className="bl-bar">
        <div className="bl-stages" role="tablist" aria-label="Stages">
          {STAGES.map((s) => (
            <button
              key={s.key}
              type="button"
              role="tab"
              aria-selected={stage === s.key}
              className={`bl-stage${stage === s.key ? ' is-on' : ''}`}
              onClick={() => onStage(s.key)}
            >
              {s.label}
              <span className="bl-stage-n">{counts[s.key]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="bl-table">
        <div className="vd-grid">
          <div className="bl-head">
            <Cells>
              <span className="bl-th">INVOICE</span>
              <span className="bl-th">FOR</span>
              <span className="bl-th">ARRIVED</span>
              <span className="bl-th is-end">AMOUNT</span>
              <span className="bl-th">STATUS</span>
            </Cells>
          </div>
          {shown.map(({ bill, chip, part }) => (
            <Link
              key={bill.paymentOrderId}
              to={`/organizations/${organizationId}/bills/${bill.paymentOrderId}${bill.bucket === 'draft' ? '/draft' : ''}`}
              className="bl-row"
              title={`Opens ${bill.invoiceNumber ?? 'the bill'}`}
            >
              <Cells>
                <span className="bl-td bl-amt num">{bill.invoiceNumber ?? '—'}</span>
                <span className="bl-td bl-desc">
                  <span>{bill.description ?? ''}</span>
                </span>
                <span className="bl-td bl-due num">{fullDay(bill.createdAt)}</span>
                <span className="bl-td is-end bl-amt num">{usd(bill.amountUsd)}</span>
                <span className="bl-td">
                  <span className={`chip is-${part.tone}`}>{chip}</span>
                </span>
              </Cells>
            </Link>
          ))}
        </div>
        {shown.length === 0 ? <div className="bl-empty">{STAGE_EMPTY[stage]}</div> : null}
      </div>
    </>
  );
}

/** Putting a vendor on hold asks why: the reason goes on its record. */
function HoldDialog({
  name,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  name: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const problem = missing ? 'Say why you’re putting it on hold.' : error;

  function submit() {
    if (busy) return;
    const why = reason.trim();
    if (!why) {
      setMissing(true);
      field.current?.focus();
      return;
    }
    onConfirm(why);
  }

  return (
    <Dialog
      title={`Put ${name} on hold?`}
      line="Its bills can’t be sent for approval until an admin releases the hold. Say why: it goes on the vendor’s record."
      onCancel={() => {
        if (!busy) onCancel();
      }}
      onConfirm={submit}
      actions={
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn is-primary" aria-busy={busy} onClick={submit}>
            {busy ? 'Putting on hold…' : 'Put on hold'}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">Why</span>
        <input
          ref={field}
          className={`input${problem ? ' is-error' : ''}`}
          maxLength={300}
          placeholder="For example: until the boxes on OT-118 arrive"
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setMissing(false);
          }}
          data-autofocus
        />
        {problem ? <span className="field-error">{problem}</span> : null}
      </label>
    </Dialog>
  );
}

