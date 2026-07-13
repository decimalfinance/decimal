// Protections — org-wide guarantees as a settings surface: one row per
// protection, a switch you flip. Turning one OFF is ceremonious (modal:
// consequences, safeguards, password); turning it back ON is instant.
// Design: protections-surface-design.md · patterns: PAGE-PLAYBOOK.md.
import { useState } from 'react';
import { useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, policiesApi, protectionsApi, type ProtectionCard } from '../api';
import type { OrganizationMember } from '../types';
import { useToast } from '../ui/Toast';
import { Ico } from '../dec/icons';
import { PageHead } from '../dec/primitives';

const SAFEGUARDS = [
  'Every exception carries a visible badge — on the bill, in the approval trail, in exports',
  'All of them land in your monthly exceptions digest',
  "We'll check in when your team reaches 6 people",
];

const CONSEQUENCE: Record<string, string> = {
  R1: 'approve bills they requested themselves',
  R2: 'approve bills they entered',
  R5: 'release payments for bills they approved',
};

export function ProtectionsPage() {
  const { organizationId } = useParams<{ organizationId: string }>();
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();
  const [confirming, setConfirming] = useState<ProtectionCard | null>(null);
  const [password, setPassword] = useState('');
  const [scopeEveryone, setScopeEveryone] = useState(true);
  const [selectedPeople, setSelectedPeople] = useState<Set<string>>(new Set());

  const protectionsQuery = useQuery({
    queryKey: ['protections', organizationId],
    queryFn: () => protectionsApi.list(organizationId!),
    enabled: Boolean(organizationId),
  });
  const membersQuery = useQuery({
    queryKey: ['organization-members', organizationId] as const,
    queryFn: () => api.listOrganizationMembers(organizationId!),
    enabled: Boolean(organizationId),
  });
  // Always-on gates + the bill ceiling (the rest of the Policies page).
  const policiesQuery = useQuery({
    queryKey: ['policies-overview', organizationId] as const,
    queryFn: () => policiesApi.get(organizationId!),
    enabled: Boolean(organizationId),
  });
  const [ceilingDraft, setCeilingDraft] = useState('');
  const ceilingMutation = useMutation({
    mutationFn: (amountUsd: number | null) => policiesApi.setCeiling(organizationId!, amountUsd),
    onSuccess: (r) => {
      success(r.ceilingUsd === null ? 'Ceiling removed — no org-wide cap.' : `Bill ceiling set: bills over $${r.ceilingUsd.toLocaleString()} are blocked.`);
      setCeilingDraft('');
      void queryClient.invalidateQueries({ queryKey: ['policies-overview', organizationId] });
    },
    onError: (e: Error) => toastError(e.message),
  });

  const members = membersQuery.data?.items ?? [];
  const cards = protectionsQuery.data?.protections ?? [];
  const people = protectionsQuery.data?.people ?? [];
  const requiresPassword = protectionsQuery.data?.requiresPassword ?? false;
  const avatarByEmail = new Map<string, string | null>(
    (membersQuery.data?.items ?? []).map((m: OrganizationMember) => [m.user.email, m.user.avatarUrl ?? null] as const),
  );
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['protections', organizationId] });

  const turnOff = useMutation({
    mutationFn: (card: ProtectionCard) =>
      protectionsApi.relax(organizationId!, card.code, {
        password: password || undefined,
        scopedPersonIds: scopeEveryone ? null : [...selectedPeople],
        sheetContent: {
          protection: card.displayName,
          scope: scopeEveryone ? 'everyone' : people.filter((p) => selectedPeople.has(p.id)).map((p) => p.name),
          safeguards: SAFEGUARDS,
        },
      }),
    onSuccess: () => {
      success('Protection off — every exception will be flagged and collected in your digest');
      setConfirming(null);
      setPassword('');
      void invalidate();
    },
    onError: (e: Error) => toastError(e.message),
  });

  const turnOn = useMutation({
    mutationFn: (code: string) => protectionsApi.retighten(organizationId!, code),
    onSuccess: (r) => {
      success(
        r.sweptTasks > 0
          ? `Protection back on — ${r.sweptTasks} pending self-approval${r.sweptTasks === 1 ? '' : 's'} re-routed`
          : 'Protection back on',
      );
      void invalidate();
    },
    onError: (e: Error) => toastError(e.message),
  });

  const busy = turnOff.isPending || turnOn.isPending;

  return (
    <div className="page">
      <div className="stack stack-24">
        <PageHead
          eyebrow="Governance"
          title="Policies"
          desc="The organization's standing rules — gates that hold no matter who approves what."
        />

        <section>
          <div className="sec-head">
            <div className="sh-titles">
              <h2>Separation of duties</h2>
              <p className="sh-desc">Who may not wear two hats on the same bill. Relaxing one is an owner decision, on the record, with safeguards.</p>
            </div>
          </div>
          <div className="tbl-card">
            {protectionsQuery.isLoading ? (
              <div style={{ padding: 20 }}>
                <div className="skeleton" style={{ height: 40, marginBottom: 10 }} />
                <div className="skeleton" style={{ height: 40, marginBottom: 10 }} />
                <div className="skeleton" style={{ height: 40 }} />
              </div>
            ) : (
              cards.map((c) => (
                <div className="setting-row" key={c.code}>
                  <div className="sr-text">
                    <span className="sr-name">{c.displayName}</span>
                    <span className="sr-desc">{c.oneLiner}</span>
                  </div>
                  <div className="sr-controls">
                    {!c.relaxable ? (
                      <>
                        <span className="pill pill-min pill-info"><span className="dot" />Always on</span>
                        <button className="switch on is-locked" disabled aria-label="Always on">
                          <span className="knob" />
                        </button>
                      </>
                    ) : (
                      <>
                        {c.relaxed ? (
                          <span className="pill pill-min pill-warning">
                            <span className="dot" />
                            {c.scopedPeople && c.scopedPeople.length > 0
                              ? `Off for ${c.scopedPeople.map((p) => p.name.split(' ')[0]).join(', ')}`
                              : 'Off for everyone'} · safeguards on · {c.relaxedBy}
                            {c.relaxedAt ? ` · ${new Date(c.relaxedAt).toLocaleDateString()}` : ''}
                          </span>
                        ) : null}
                        <button
                          className={`switch${c.relaxed ? '' : ' on'}`}
                          disabled={busy}
                          aria-label={c.relaxed ? `Turn ${c.displayName} on` : `Turn ${c.displayName} off`}
                          onClick={() => {
                            if (c.relaxed) turnOn.mutate(c.code);
                            else { setConfirming(c); setPassword(''); setScopeEveryone(true); setSelectedPeople(new Set()); }
                          }}
                        >
                          <span className="knob" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <section>
          <div className="sec-head">
            <div className="sh-titles">
              <h2>Payment gates</h2>
              <p className="sh-desc">Always on. Settlement here is irreversible, so these block rather than warn — and every override is a named, logged decision.</p>
            </div>
          </div>
          <div className="tbl-card">
            <div className="setting-row">
              <div className="sr-text">
                <span className="sr-name">Duplicate bills</span>
                <span className="sr-desc">Same vendor and invoice number — or same amount within 14 days — is blocked in review and re-checked at release. Admins clear false positives with a logged reason.</span>
              </div>
              <div className="sr-controls">
                {policiesQuery.data && policiesQuery.data.gates.duplicate.overridesLast30Days > 0 ? (
                  <span className="pill pill-min pill-warning"><span className="dot" />{policiesQuery.data.gates.duplicate.overridesLast30Days} cleared in 30 days</span>
                ) : null}
                <span className="pill pill-min pill-info"><span className="dot" />Always on</span>
              </div>
            </div>
            <div className="setting-row">
              <div className="sr-text">
                <span className="sr-name">Vendor payable status</span>
                <span className="sr-desc">A held or blocked vendor's bills can't leave review, no matter who approves. Holds are set and released on the Vendors page.</span>
              </div>
              <div className="sr-controls">
                {policiesQuery.data && (policiesQuery.data.gates.payable.held > 0 || policiesQuery.data.gates.payable.blocked > 0) ? (
                  <span className="pill pill-min pill-warning">
                    <span className="dot" />
                    {[policiesQuery.data.gates.payable.held > 0 ? `${policiesQuery.data.gates.payable.held} on hold` : null,
                      policiesQuery.data.gates.payable.blocked > 0 ? `${policiesQuery.data.gates.payable.blocked} blocked` : null].filter(Boolean).join(' · ')}
                  </span>
                ) : null}
                <span className="pill pill-min pill-info"><span className="dot" />Always on</span>
              </div>
            </div>
            <div className="setting-row">
              <div className="sr-text">
                <span className="sr-name">Pinned payout destination</span>
                <span className="sr-desc">Approving a bill pins where the money goes. If the vendor's payment details change afterwards, the bill goes back through approval before it can be paid.</span>
              </div>
              <div className="sr-controls">
                <span className="pill pill-min pill-info"><span className="dot" />Always on</span>
              </div>
            </div>
          </div>
        </section>

        <section>
          <div className="sec-head">
            <div className="sh-titles">
              <h2>Bill ceiling</h2>
              <p className="sh-desc">A hard cap no single bill may cross — regardless of the approval flow. Only the primary admin can change it.</p>
            </div>
          </div>
          <div className="tbl-card">
            <div className="setting-row">
              <div className="sr-text">
                <span className="sr-name">
                  {policiesQuery.data?.ceilingUsd != null
                    ? `Bills over $${policiesQuery.data.ceilingUsd.toLocaleString()} are blocked`
                    : 'No ceiling set'}
                </span>
                <span className="sr-desc">
                  {policiesQuery.data?.ceilingUsd != null
                    ? 'Blocked in review and re-checked at release — raising the ceiling is the only way through.'
                    : 'Bills of any size can move through your flows.'}
                </span>
              </div>
              <div className="sr-controls" style={{ gap: 8 }}>
                <input
                  className="input"
                  type="number"
                  min={1}
                  placeholder="e.g. 50,000"
                  value={ceilingDraft}
                  onChange={(e) => setCeilingDraft(e.target.value)}
                  style={{ width: 130, height: 32 }}
                />
                <button type="button" className="btn btn-secondary btn-sm" disabled={ceilingMutation.isPending || !(Number(ceilingDraft) > 0)}
                  onClick={() => ceilingMutation.mutate(Number(ceilingDraft))}>
                  Set
                </button>
                {policiesQuery.data?.ceilingUsd != null ? (
                  <button type="button" className="btn btn-secondary btn-sm" disabled={ceilingMutation.isPending}
                    onClick={() => ceilingMutation.mutate(null)}>
                    Remove
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </section>

        <section>
          <div className="sec-head">
            <div className="sh-titles">
              <h2>Exceptions</h2>
              <p className="sh-desc">Anything approved while a protection is off shows up here and in your monthly digest.</p>
            </div>
          </div>
          <div className="tbl-card">
            <div className="empty">
              <div className="empty-icon"><Ico.proposals w={22} /></div>
              <h4>Nothing here</h4>
              <p>No bill has been approved under a switched-off protection this month.</p>
            </div>
          </div>
        </section>
      </div>

      {confirming ? (
        <div
          className="overlay"
          style={{ position: 'fixed', inset: 0, zIndex: 60 }}
          onClick={(e) => { if (e.target === e.currentTarget && !turnOff.isPending) setConfirming(null); }}
        >
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="protection-off-title"
            style={{ maxWidth: 660, width: 660 }}
          >
            <div className="dialog-head">
              <div>
                <h2 id="protection-off-title">Turn off "{confirming.displayName}"</h2>
                <p style={{ maxWidth: 'none' }}>This is recorded permanently and every affected bill will show it.</p>
              </div>
              <button type="button" className="drawer-x" onClick={() => setConfirming(null)} aria-label="Close">
                ×
              </button>
            </div>
            <div className="dialog-body">
              <div className="callout callout-danger">
                <Ico.shield w={16} />
                <span>
                  {scopeEveryone
                    ? <>Everyone in this organization could {CONSEQUENCE[confirming.code]}.</>
                    : selectedPeople.size > 0
                      ? <><strong>{people.filter((p) => selectedPeople.has(p.id)).map((p) => p.name).join(' and ')}</strong> could {CONSEQUENCE[confirming.code]}.</>
                      : <>Pick who below — only they will be able to {CONSEQUENCE[confirming.code]}.</>}
                </span>
              </div>

              <div className="field">
                <label className="field-label">Who this applies to</label>
                <div className="tabs" style={{ alignSelf: 'flex-start' }}>
                  <button type="button" className={`tab${scopeEveryone ? ' on' : ''}`} onClick={() => setScopeEveryone(true)}>
                    Everyone
                  </button>
                  <button type="button" className={`tab${scopeEveryone ? '' : ' on'}`} onClick={() => setScopeEveryone(false)}>
                    Specific people
                  </button>
                </div>
              </div>

              {!scopeEveryone ? (
                <div className="check-list">
                  {people.map((person) => {
                    const on = selectedPeople.has(person.id);
                    const toggle = () => {
                      const next = new Set(selectedPeople);
                      if (on) next.delete(person.id); else next.add(person.id);
                      setSelectedPeople(next);
                    };
                    return (
                      <div className={`check-item${on ? ' on' : ''}`} key={person.id} onClick={toggle}>
                        <PersonAvatar avatarUrl={avatarByEmail.get(person.email) ?? null} name={person.name} email={person.email} />
                        <span className="ci-name">{person.name}</span>
                        <span className="ci-sub">{person.email}</span>
                        <button
                          type="button"
                          className={`switch${on ? ' on' : ''}`}
                          aria-label={on ? `Remove ${person.name}` : `Allow ${person.name}`}
                          onClick={(e) => { e.stopPropagation(); toggle(); }}
                        >
                          <span className="knob" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              <div className="field">
                <label className="field-label">Safeguards that stay on</label>
                <div className="tick-list">
                  {SAFEGUARDS.map((sg) => (
                    <div key={sg} className="tick-item">
                      <Ico.check w={15} />
                      <span>{sg}</span>
                    </div>
                  ))}
                </div>
              </div>

              {requiresPassword ? (
                <div className="field">
                  <label className="field-label" htmlFor="protection-password">Confirm your password</label>
                  <input
                    id="protection-password"
                    className="input"
                    type="password"
                    value={password}
                    placeholder="Your password"
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
              ) : (
                <p className="input-help" style={{ margin: 0 }}>
                  You're signed in with Google — confirming below acts as your acknowledgment.
                </p>
              )}
            </div>
            <div className="dialog-foot" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirming(null)}>Cancel</button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={turnOff.isPending || (!scopeEveryone && selectedPeople.size === 0) || (requiresPassword && !password)}
                onClick={() => turnOff.mutate(confirming)}
              >
                {scopeEveryone
                  ? 'Turn off for everyone'
                  : selectedPeople.size > 0
                    ? `Turn off for ${selectedPeople.size} ${selectedPeople.size === 1 ? 'person' : 'people'}`
                    : 'Turn off'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PersonAvatar({ avatarUrl, name, email }: { avatarUrl: string | null; name: string; email: string }) {
  const [failed, setFailed] = useState(false);
  const src = name?.trim() || email;
  const parts = src.split(/\s+/);
  const initials = (parts.length >= 2 ? parts[0]![0]! + parts[1]![0]! : src.slice(0, 2)).toUpperCase();
  if (!avatarUrl || failed) {
    return <span className="ci-av">{initials}</span>;
  }
  return (
    <span className="ci-av" style={{ padding: 0, overflow: 'hidden', background: 'transparent' }}>
      <img src={avatarUrl} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
    </span>
  );
}
