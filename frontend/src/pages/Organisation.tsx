/**
 * Organisation (3a): the organisation's details, the other names its bills
 * use, the policies that protect every bill, and the bills that went through
 * with one set aside. Admins change the details; only the primary admin
 * changes the policies, behind their password, and every change is on the
 * record. Everyone else in the organisation reads it.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  accessApi,
  api,
  inboundEmailApi,
  organizationApi,
  policiesApi,
  protectionsApi,
  rolesApi,
  separationApi,
  type TradingName,
} from '../api';
import { ConfirmDialog } from '../kit/Dialog';
import { fullDay, usd } from '../kit/format';
import { useCopy } from '../kit/hooks';
import { Icon } from '../kit/icons';
import { roleLabel } from '../kit/people';
import { useToaster } from '../kit/Toast';
import { Exceptions } from './settings/Exceptions';
import { CeilingDialog, TurnBackOnDialog, TurnOffDialog, type Sender } from './settings/PolicyDialogs';
import { ChangedBy, Failed, Heading, NameRow, codeOf, joinNames, messageOf, possessive } from './settings/parts';

// Who can send a bill for approval, in the order the turn-off dialog lists them.
const SENDER_ORDER = ['Bill clerk', 'Admin', 'Primary admin'];

type Policy = null | 'off' | 'on' | 'ceiling';

export function OrganisationPage() {
  const { organizationId = '' } = useParams();
  const queryClient = useQueryClient();
  const toaster = useToaster();
  const on = Boolean(organizationId);

  const session = useQuery({ queryKey: ['session'], queryFn: () => api.getSession(), staleTime: Infinity });
  const access = useQuery({
    queryKey: ['my-access', organizationId],
    queryFn: () => accessApi.get(organizationId),
    enabled: on,
    staleTime: 60_000,
  });
  const address = useQuery({
    queryKey: ['inbound-email-address', organizationId],
    queryFn: () => inboundEmailApi.address(organizationId),
    enabled: on,
    staleTime: 5 * 60_000,
  });
  const names = useQuery({
    queryKey: ['trading-names', organizationId],
    queryFn: () => organizationApi.tradingNames(organizationId),
    enabled: on,
  });
  const protections = useQuery({
    queryKey: ['protections', organizationId],
    queryFn: () => protectionsApi.list(organizationId),
    enabled: on,
  });
  // The old Approval flow page's switch, which let senders approve outside
  // the record. While it's set, No self-approval is off for everyone.
  const separation = useQuery({
    queryKey: ['separation', organizationId],
    queryFn: () => separationApi.get(organizationId),
    enabled: on,
  });
  const policies = useQuery({
    queryKey: ['policies-overview', organizationId],
    queryFn: () => policiesApi.get(organizationId),
    enabled: on,
  });
  const roster = useQuery({
    queryKey: ['members-roles', organizationId],
    queryFn: () => rolesApi.get(organizationId),
    enabled: on,
  });

  const [removing, setRemoving] = useState<TradingName | null>(null);
  const [policy, setPolicy] = useState<Policy>(null);

  const me = session.data?.user;
  const orgName = session.data?.organizations.find((o) => o.organizationId === organizationId)?.organizationName ?? '';
  const isAdmin = access.data?.isPrimaryOrAdmin ?? false;
  const isPrimary = access.data?.membershipRole === 'primary_admin';
  const requiresPassword = protections.data?.requiresPassword ?? true;
  const members = roster.data?.members ?? [];
  const myPersonId = members.find((m) => m.userId === me?.userId)?.personId ?? null;
  const primaryName = members.find((m) => m.access === 'primary_admin')?.name;

  const senders = useMemo<Sender[]>(
    () =>
      members
        .filter((m) => m.personId && (m.access === 'primary_admin' || m.access === 'admin' || m.roles.includes('bill_clerk')))
        .map((m) => ({
          personId: m.personId!,
          name: m.name,
          avatarUrl: m.avatarUrl,
          role: roleLabel({ membershipRole: m.access, roles: m.roles }),
          you: m.userId === me?.userId,
        }))
        .sort((a, b) => SENDER_ORDER.indexOf(a.role) - SENDER_ORDER.indexOf(b.role) || a.name.localeCompare(b.name)),
    [members, me?.userId],
  );

  const r1 = protections.data?.protections.find((p) => p.code === 'R1');
  const flagOff = separation.data?.submitterCanApprove === true;
  const state: 'on' | 'all' | 'some' = flagOff || (r1?.relaxed && !r1.scopedPeople) ? 'all' : r1?.relaxed ? 'some' : 'on';
  const exceptFor = state === 'some' ? (r1?.scopedPeople ?? []).map((p) => p.name) : null;
  const policyReady = protections.isSuccess && separation.isSuccess;

  function afterPolicy(said: ReactNode) {
    setPolicy(null);
    toaster.show(said);
    for (const key of ['protections', 'separation', 'policies-overview', 'policy-exceptions']) {
      void queryClient.invalidateQueries({ queryKey: [key, organizationId] });
    }
  }

  async function rename(next: string, before: string): Promise<string | null> {
    try {
      await organizationApi.rename(organizationId, next);
    } catch (e) {
      return codeOf(e) === 'organization_name_taken' ? `An organisation called “${next}” already exists. Try another name.` : messageOf(e);
    }
    await queryClient.invalidateQueries({ queryKey: ['session'] });
    toaster.show(`Renamed to “${next}”. The forwarding address stays the same.`, {
      undo: () => {
        organizationApi
          .rename(organizationId, before)
          .then(() => queryClient.invalidateQueries({ queryKey: ['session'] }))
          .catch((e) => toaster.show(`Couldn’t put “${before}” back. ${messageOf(e)}`));
      },
    });
    return null;
  }

  async function removeName(entry: TradingName) {
    setRemoving(null);
    const key = ['trading-names', organizationId];
    // The row goes at once; the list comes back from the server either way.
    queryClient.setQueryData<{ items: TradingName[] }>(key, (old) => old && { items: old.items.filter((i) => i.name !== entry.name) });
    try {
      await organizationApi.removeTradingName(organizationId, entry.name);
      toaster.show(`“${entry.name}” removed. Bills addressed to it will be asked about again.`, {
        undo: () => {
          organizationApi
            .restoreTradingName(organizationId, entry.name)
            .catch((e) => toaster.show(`Couldn’t put “${entry.name}” back. ${messageOf(e)}`))
            .finally(() => void queryClient.invalidateQueries({ queryKey: key }));
        },
      });
    } catch (e) {
      toaster.show(`Couldn’t remove “${entry.name}”. ${messageOf(e)}`);
    } finally {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  }

  const intro = isPrimary
    ? requiresPassword
      ? 'Admins can change the details; only you can change the policies, with your password, and every change is recorded.'
      : 'Admins can change the details; only you can change the policies, and every change is recorded.'
    : primaryName
      ? `Only ${primaryName}, the primary admin, can change the policies.`
      : 'Only the primary admin can change the policies.';

  return (
    <div className="ui page">
      <h1 className="page-title">Organisation</h1>
      {access.isSuccess ? <p className="page-sub">{intro}</p> : null}

      <div className="st-blocks">
        <div className="st-pair">
          <section className="st-col">
            <Heading title={orgName || 'Your organisation'} hint="Admins can change these" />
            <div className="st-rows">
              <NameRow
                label="Organisation name"
                line="No other organisation may use it."
                value={orgName}
                canEdit={isAdmin && Boolean(orgName)}
                action="Rename"
                fieldLabel="Organisation name"
                emptyError="Enter a name for the organisation."
                save={(next) => rename(next, orgName)}
              />
              <AddressRow address={address.data?.address ?? null} loaded={address.isSuccess || address.isError} />
            </div>
          </section>

          <section className="st-col">
            <Heading title="Other names" hint="Added when someone answers “This is us” on a bill." />
            <div className="st-rows">
              {!names.isSuccess ? (
                names.isError ? <Failed what="Other names" retry={() => void names.refetch()} /> : null
              ) : names.data.items.length === 0 ? (
                <div className="st-empty">No other names yet.</div>
              ) : (
                names.data.items.map((n) => (
                  <div key={n.name} className="st-row">
                    <div className="st-left">
                      <div className="st-label clip" title={n.name}>
                        {n.name}
                      </div>
                      <AddedLine entry={n} />
                    </div>
                    {isAdmin ? (
                      <div className="st-right">
                        <button type="button" className="st-pill" aria-label={`Remove “${n.name}”`} onClick={() => setRemoving(n)}>
                          Remove
                        </button>
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        <section>
          <Heading title="Separation of duties" tight />
          <div className="st-rows">
            {!policyReady ? (
              protections.isError || separation.isError ? (
                <Failed
                  what="Separation of duties"
                  retry={() => {
                    void protections.refetch();
                    void separation.refetch();
                  }}
                />
              ) : null
            ) : (
              <>
                <div className="st-row">
                  <div className="st-left">
                    <div className="st-label">No self-approval</div>
                    <div className="st-line">Whoever sent a bill for approval can’t approve it.</div>
                  </div>
                  <div className="st-right">
                    <span className={`chip ${state === 'all' ? 'is-warning' : 'is-checked'}`}>{state === 'all' ? 'Off' : 'On'}</span>
                    <span className={`st-scope${state === 'on' ? '' : ' is-warn'}`}>
                      {state === 'some' ? `Except for ${joinNames(exceptFor ?? [])}` : 'For everyone'}
                    </span>
                    {isPrimary ? (
                      <button type="button" className="st-pill is-policy" onClick={() => setPolicy(state === 'on' ? 'off' : 'on')}>
                        {state === 'on' ? 'Turn off' : 'Turn back on'}
                      </button>
                    ) : null}
                  </div>
                </div>
                {r1?.lastChange ? (
                  <div className="st-foot">
                    <ChangedBy change={r1.lastChange} myPersonId={myPersonId} />
                  </div>
                ) : null}
              </>
            )}
          </div>
        </section>

        <div className="st-pair is-stretch">
          <section className="st-col">
            <Heading title="Bill ceiling" tight />
            <div className="st-rows">
              {!policies.isSuccess ? (
                policies.isError ? <Failed what="The bill ceiling" retry={() => void policies.refetch()} /> : null
              ) : (
                <div className="st-card">
                  <div className="st-card-top">
                    <div className="st-left">
                      <div className="st-label">Largest bill</div>
                      <div className="st-line">A bill over this needs an exception from the primary admin before anyone can approve it.</div>
                    </div>
                    <div className="st-card-value">
                      {policies.data.ceilingUsd === null ? (
                        <span className="st-amount is-quiet">Not set</span>
                      ) : (
                        <span className="st-amount num">{usd(policies.data.ceilingUsd)}</span>
                      )}
                      <ChangedBy change={policies.data.ceilingChange} myPersonId={myPersonId} />
                    </div>
                  </div>
                  <div className="st-spacer" />
                  {isPrimary ? (
                    <div className="st-card-actions">
                      <button type="button" className="st-pill is-policy" onClick={() => setPolicy('ceiling')}>
                        Change
                      </button>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </section>

          <section className="st-col">
            <Heading title="Checks on every bill" tight />
            <div className="st-rows">
              <Check label="Possible duplicates" line="A bill that may be a duplicate stays in review until someone checks it." />
              <Check label="Vendors on hold" line="Bills from a vendor on hold stay in review until an admin releases the hold." />
            </div>
          </section>
        </div>

        <Exceptions organizationId={organizationId} />
      </div>

      {removing ? (
        <ConfirmDialog
          title={`Remove “${removing.name}”?`}
          line={`Bills addressed to ${removing.name} will no longer be recognised as ${possessive(orgName)}. Each will be asked about again, and an admin can add the name back by answering “This is us”.`}
          cancelLabel="Keep it"
          confirmLabel="Remove"
          tone="remove"
          onCancel={() => setRemoving(null)}
          onConfirm={() => void removeName(removing)}
        />
      ) : null}

      {policy === 'off' ? (
        <TurnOffDialog
          organizationId={organizationId}
          senders={senders}
          requiresPassword={requiresPassword}
          onDone={afterPolicy}
          onCancel={() => setPolicy(null)}
        />
      ) : null}
      {policy === 'on' ? (
        <TurnBackOnDialog
          organizationId={organizationId}
          exceptFor={exceptFor}
          requiresPassword={requiresPassword}
          onDone={afterPolicy}
          onCancel={() => setPolicy(null)}
        />
      ) : null}
      {policy === 'ceiling' ? (
        <CeilingDialog
          organizationId={organizationId}
          currentUsd={policies.data?.ceilingUsd ?? null}
          requiresPassword={requiresPassword}
          onDone={afterPolicy}
          onCancel={() => setPolicy(null)}
        />
      ) : null}
    </div>
  );
}

function AddressRow({ address, loaded }: { address: string | null; loaded: boolean }) {
  const { copied, copy } = useCopy(address);
  return (
    <div className="st-row">
      <div className="st-left">
        <div className="st-label">Forwarding address</div>
        <div className="st-line">Only your team’s forwards are read.</div>
      </div>
      <div className="st-right">
        {address ? (
          <>
            <span className="st-value num clip" title={address}>
              {address}
            </span>
            <button
              type="button"
              className={`st-copy${copied ? ' is-done' : ''}`}
              title={copied ? 'Copied' : 'Copy'}
              aria-label="Copy the address"
              onClick={copy}
            >
              {copied ? <Icon.tick size={12} /> : <Icon.copy size={12} />}
            </button>
          </>
        ) : loaded ? (
          <span className="st-value is-quiet">Not set up</span>
        ) : null}
      </div>
    </div>
  );
}

/** "Added by Zara Okafor on BW-2219 · 2 Oct 2026", with whatever is known. */
function AddedLine({ entry }: { entry: TradingName }) {
  if (!entry.addedByName && !entry.invoiceNumber && !entry.addedAt) return null;
  return (
    <div className="st-line clip">
      Added
      {entry.addedByName ? ` by ${entry.addedByName}` : ''}
      {entry.invoiceNumber ? (
        <>
          {' '}
          on <span className="num">{entry.invoiceNumber}</span>
        </>
      ) : null}
      {entry.addedAt ? (
        <>
          {' · '}
          <span className="num">{fullDay(entry.addedAt)}</span>
        </>
      ) : null}
    </div>
  );
}

function Check({ label, line }: { label: string; line: string }) {
  return (
    <div className="st-row">
      <div className="st-left">
        <div className="st-label">{label}</div>
        <div className="st-line">{line}</div>
      </div>
      <span className="caps">Always on</span>
    </div>
  );
}
