// Vendors — implements PageAddressBook from the design.
// Vendors and counterparties the org pays. Per-row aggregates (last
// payment, total paid, payment count) are computed client-side from
// paymentOrders so we don't need a new endpoint.

import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { accessApi, api } from '../api';
import type {
  AuthenticatedSession,
  Counterparty,
  CounterpartyWallet,
  CounterpartyWalletTrustState,
  PaymentOrder,
} from '../types';
import { useToast } from '../ui/Toast';
import { formatRawUsdcCompact } from '../domain';
import { PageHead, Pill, type PillTone } from '../dec/primitives';
import { Ico } from '../dec/icons';

type LocalTab = 'all' | 'trusted' | 'unreviewed';

function trustTone(t: CounterpartyWalletTrustState): PillTone {
  if (t === 'trusted') return 'success';
  if (t === 'blocked' || t === 'restricted') return 'danger';
  if (t === 'unreviewed') return 'warning';
  return 'neutral';
}

function trustLabel(t: CounterpartyWalletTrustState): string {
  if (t === 'trusted') return 'Verified';
  if (t === 'unreviewed') return 'Unreviewed';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function vendorInitials(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return '??';
}

function fmtDate(s: string | null): string {
  return s
    ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M3 10.5V4A1.5 1.5 0 0 1 4.5 2.5H11" />
    </svg>
  );
}

type VendorRow = {
  wallet: CounterpartyWallet;
  lastPaidAt: string | null;
  totalPaidRaw: string;
  paymentCount: number;
};

// A vendor is one entity that may hold several payout addresses. We group the
// flat wallet list by the counterparty it belongs to (falling back to the
// label when no counterparty is linked) so the same vendor never renders as
// separate same-named rows. A new/changed address shows as an extra
// "Unreviewed" address under the vendor it belongs to, not a peer vendor.
type VendorGroup = {
  key: string;
  name: string;
  addresses: VendorRow[];
  lastPaidAt: string | null;
  totalPaidRaw: string;
  paymentCount: number;
  needsReviewCount: number;
};

export function CounterpartiesPage({ session: _session }: { session: AuthenticatedSession }) {
  const { organizationId } = useParams<{ organizationId: string }>();
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();

  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<CounterpartyWallet | null>(null);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<LocalTab>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const copyAddress = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      success('Address copied');
    } catch {
      toastError('Could not copy address');
    }
  };

  const walletsQuery = useQuery({
    queryKey: ['counterparty-wallets', organizationId] as const,
    queryFn: () => api.listCounterpartyWallets(organizationId!),
    enabled: Boolean(organizationId),
  });

  // Vendor records carry the payable gate (held/blocked) — wallet rows don't.
  const counterpartiesQuery = useQuery({
    queryKey: ['counterparties', organizationId] as const,
    queryFn: () => api.listCounterparties(organizationId!),
    enabled: Boolean(organizationId),
  });
  // Blocking is the primary admin's call — don't OFFER it to people the server
  // will refuse (testbench 003, cosmetic note 1).
  const myAccess = useQuery({
    queryKey: ['my-access', organizationId] as const,
    queryFn: () => accessApi.get(organizationId!),
    enabled: Boolean(organizationId),
    staleTime: 60_000,
  });
  const isPrimaryAdmin = myAccess.data?.membershipRole === 'owner';
  const isAdminTier = Boolean(myAccess.data?.isOwnerOrAdmin);
  const vendorById = useMemo(
    () => new Map((counterpartiesQuery.data?.items ?? []).map((c) => [c.counterpartyId, c])),
    [counterpartiesQuery.data],
  );

  // Vendor coding defaults — vendor memory made visible (GL synthesis D2).
  const codingRulesQuery = useQuery({
    queryKey: ['vendor-coding-rules', organizationId] as const,
    queryFn: () => api.listVendorCodingRules(organizationId!),
    enabled: Boolean(organizationId),
  });
  const codingRuleByVendor = useMemo(
    () => new Map((codingRulesQuery.data?.items ?? []).map((r) => [r.counterpartyId, r])),
    [codingRulesQuery.data],
  );
  const clearCodingRule = useMutation({
    mutationFn: (counterpartyId: string) => api.clearVendorCodingRule(organizationId!, counterpartyId),
    onSuccess: async () => {
      success('Coding default removed — it will re-learn from future bills.');
      await queryClient.invalidateQueries({ queryKey: ['vendor-coding-rules', organizationId] });
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Could not remove the default.'),
  });

  const payableMutation = useMutation({
    mutationFn: (input: { counterpartyId: string; status: 'payable' | 'held' | 'blocked'; reason?: string | null }) =>
      api.setVendorPayableStatus(organizationId!, input.counterpartyId, { status: input.status, reason: input.reason ?? null }),
    onSuccess: async (updated) => {
      success(
        updated.payableStatus === 'payable' ? 'Payments to this vendor can flow again.'
          : updated.payableStatus === 'held' ? 'Payments to this vendor are on hold.'
          : 'Vendor blocked — their bills can no longer proceed.',
      );
      await queryClient.invalidateQueries({ queryKey: ['counterparties', organizationId] });
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Could not change the payment status.'),
  });

  // Used to compute per-vendor aggregates. Limit=100 from the list
  // endpoint is enough for the "last payment / total paid" view; older
  // rows fall off naturally.
  const paymentsQuery = useQuery({
    queryKey: ['payment-orders', organizationId, 'address-book-aggregates'] as const,
    queryFn: () => api.listPaymentOrders(organizationId!),
    enabled: Boolean(organizationId),
  });

  async function invalidate() {
    await queryClient.invalidateQueries({ queryKey: ['counterparty-wallets', organizationId] });
  }

  const createMutation = useMutation({
    mutationFn: (input: {
      label: string;
      walletAddress: string;
      trustState: CounterpartyWalletTrustState;
      notes?: string;
    }) =>
      api.createCounterpartyWallet(organizationId!, {
        label: input.label,
        walletAddress: input.walletAddress,
        trustState: input.trustState,
        notes: input.notes,
      }),
    onSuccess: async () => {
      success('Vendor saved.');
      setAddOpen(false);
      await invalidate();
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Unable to save vendor.'),
  });

  const updateMutation = useMutation({
    mutationFn: (input: {
      counterpartyWalletId: string;
      label: string;
      trustState: CounterpartyWalletTrustState;
      notes: string | null;
      isPrimary?: boolean;
    }) =>
      api.updateCounterpartyWallet(organizationId!, input.counterpartyWalletId, {
        label: input.label,
        trustState: input.trustState,
        notes: input.notes,
        isPrimary: input.isPrimary,
      }),
    onSuccess: async () => {
      success('Vendor updated.');
      setEditing(null);
      await invalidate();
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Unable to update vendor.'),
  });

  const removeMutation = useMutation({
    mutationFn: (counterpartyWalletId: string) =>
      api.removeCounterpartyWallet(organizationId!, counterpartyWalletId),
    onSuccess: async (res) => {
      success(res.removed === 'deleted' ? 'Address removed.' : 'Address archived.');
      setEditing(null);
      await invalidate();
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Could not remove address.'),
  });

  if (!organizationId) {
    return (
      <div className="page page-wide">
        <div className="empty">
          <h4>Organization unavailable</h4>
          <p>Pick an organization from the sidebar.</p>
        </div>
      </div>
    );
  }

  const wallets = (walletsQuery.data?.items ?? []).filter((w) => w.isActive);

  // Aggregate payment history per counterparty wallet.
  const aggregatesByWalletId = useMemo(() => {
    const map = new Map<string, { totalRaw: bigint; count: number; lastPaidAt: string | null }>();
    for (const o of paymentsQuery.data?.items ?? []) {
      const key = o.counterpartyWalletId;
      if (!key) continue;
      const state = String(o.derivedState ?? o.state).toLowerCase();
      // Only count payments that actually moved money. Drafts and
      // cancelled rows would inflate the picture.
      const settled =
        state === 'settled' ||
        state === 'executed' ||
        state === 'closed' ||
        Boolean(o.spendingLimitExecution);
      if (!settled) continue;
      const prev = map.get(key) ?? { totalRaw: 0n, count: 0, lastPaidAt: null };
      try { prev.totalRaw += BigInt(o.amountRaw); } catch { /* ignore */ }
      prev.count += 1;
      const when = o.updatedAt ?? o.createdAt;
      if (!prev.lastPaidAt || (when && when > prev.lastPaidAt)) prev.lastPaidAt = when;
      map.set(key, prev);
    }
    return map;
  }, [paymentsQuery.data]);

  const rows = useMemo<VendorRow[]>(
    () =>
      wallets.map((w) => {
        const agg = aggregatesByWalletId.get(w.counterpartyWalletId);
        return {
          wallet: w,
          lastPaidAt: agg?.lastPaidAt ?? null,
          totalPaidRaw: (agg?.totalRaw ?? 0n).toString(),
          paymentCount: agg?.count ?? 0,
        };
      }),
    [wallets, aggregatesByWalletId],
  );

  const filtered = useMemo(() => {
    let out = rows;
    if (tab === 'trusted') out = out.filter((r) => r.wallet.trustState === 'trusted');
    else if (tab === 'unreviewed') out = out.filter((r) => r.wallet.trustState !== 'trusted');
    const q = search.trim().toLowerCase();
    if (q) {
      out = out.filter(
        (r) =>
          r.wallet.label.toLowerCase().includes(q) ||
          r.wallet.walletAddress.toLowerCase().includes(q),
      );
    }
    return out.slice().sort((a, b) => a.wallet.label.localeCompare(b.wallet.label));
  }, [rows, tab, search]);

  const totals = useMemo(() => {
    return {
      all: rows.length,
      trusted: rows.filter((r) => r.wallet.trustState === 'trusted').length,
      unreviewed: rows.filter((r) => r.wallet.trustState !== 'trusted').length,
    };
  }, [rows]);

  // Group the (filtered) addresses by vendor for display.
  const groups = useMemo<VendorGroup[]>(() => {
    const byKey = new Map<string, VendorRow[]>();
    for (const r of filtered) {
      const w = r.wallet;
      const key = w.counterpartyId ?? `label:${w.label.trim().toLowerCase()}`;
      const arr = byKey.get(key);
      if (arr) arr.push(r);
      else byKey.set(key, [r]);
    }

    const out: VendorGroup[] = [];
    for (const [key, addresses] of byKey) {
      const first = addresses[0]!.wallet;
      const name = first.counterparty?.displayName ?? first.label;
      let totalRaw = 0n;
      let paymentCount = 0;
      let lastPaidAt: string | null = null;
      let needsReviewCount = 0;
      for (const a of addresses) {
        try { totalRaw += BigInt(a.totalPaidRaw); } catch { /* ignore */ }
        paymentCount += a.paymentCount;
        if (a.lastPaidAt && (!lastPaidAt || a.lastPaidAt > lastPaidAt)) lastPaidAt = a.lastPaidAt;
        if (a.wallet.trustState !== 'trusted') needsReviewCount += 1;
      }
      // Trusted addresses first, then the ones awaiting review.
      addresses.sort(
        (a, b) =>
          (a.wallet.trustState === 'trusted' ? 0 : 1) - (b.wallet.trustState === 'trusted' ? 0 : 1),
      );
      out.push({
        key,
        name,
        addresses,
        lastPaidAt,
        totalPaidRaw: totalRaw.toString(),
        paymentCount,
        needsReviewCount,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [filtered]);

  const isLoading = walletsQuery.isLoading;

  return (
    <div className="page page-wide">
      <div className="stack stack-24">
        <PageHead
          eyebrow="Registry"
          title="Vendors"
          desc="Vendors and counterparties you pay. Review a new vendor once, then pay them again with confidence."
          actions={
            <button type="button" className="btn btn-primary" onClick={() => setAddOpen(true)}>
              <Ico.plus w={15} />Add vendor
            </button>
          }
        />

        <div className="filterbar">
          <div className="tabs">
            <button
              type="button"
              className={`tab${tab === 'all' ? ' on' : ''}`}
              onClick={() => setTab('all')}
            >
              All<span className="tab-count">{totals.all}</span>
            </button>
            <button
              type="button"
              className={`tab${tab === 'trusted' ? ' on' : ''}`}
              onClick={() => setTab('trusted')}
            >
              Verified<span className="tab-count">{totals.trusted}</span>
            </button>
            <button
              type="button"
              className={`tab${tab === 'unreviewed' ? ' on' : ''}`}
              onClick={() => setTab('unreviewed')}
            >
              Needs review<span className="tab-count">{totals.unreviewed}</span>
            </button>
          </div>
          <div className="filter-right">
            <div className="input-search">
              <Ico.search w={15} />
              <input
                className="input"
                placeholder="Search vendors"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
        </div>

        <div className="tbl-card">
          {isLoading ? (
            <div style={{ padding: 16 }}>
              <div className="skeleton" style={{ height: 56, marginBottom: 6 }} />
              <div className="skeleton" style={{ height: 56, marginBottom: 6 }} />
              <div className="skeleton" style={{ height: 56 }} />
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty">
              <div className="empty-icon"><Ico.address w={22} /></div>
              <h4>{rows.length === 0 ? 'No vendors yet' : 'Nothing matches'}</h4>
              <p>
                {rows.length === 0
                  ? "Save the vendors you pay. Once verified, they're available for one-click selection on every payment."
                  : 'Clear the search or change the tab.'}
              </p>
              {rows.length === 0 ? (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => setAddOpen(true)}
                  style={{ marginTop: 8 }}
                >
                  <Ico.plus w={13} />Add vendor
                </button>
              ) : null}
            </div>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: '36%' }}>Vendor</th>
                  <th>Status</th>
                  <th>Last payment</th>
                  <th className="num">Total paid</th>
                  <th className="num">Payments</th>
                  <th style={{ width: 28 }}></th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const isExpanded = expanded.has(g.key);
                  const only = g.addresses.length === 1 ? g.addresses[0]! : null;
                  return (
                    <Fragment key={g.key}>
                      <tr onClick={() => toggleExpanded(g.key)} style={{ cursor: 'pointer' }}>
                        <td>
                          <div className="member-cell">
                            <span className="m-avatar">{vendorInitials(g.name)}</span>
                            <div className="col">
                              <span className="m-name">{g.name}</span>
                              {g.addresses.length > 1 ? (
                                <span className="m-sub" style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--text-faint)' }}>
                                  {g.addresses.length} addresses
                                </span>
                              ) : null}
                            </div>
                          </div>
                        </td>
                        <td>
                          {(() => {
                            // The payable gate outranks trust display: a held or
                            // blocked vendor can't be paid regardless of wallets.
                            const cpId = g.addresses[0]?.wallet.counterpartyId;
                            const hold = cpId ? vendorById.get(cpId)?.payableHold : null;
                            if (hold) {
                              return (
                                <Pill tone="danger">{hold.status === 'blocked' ? 'Blocked' : 'Payments on hold'}</Pill>
                              );
                            }
                            return only ? (
                              <Pill tone={trustTone(only.wallet.trustState)}>{trustLabel(only.wallet.trustState)}</Pill>
                            ) : g.needsReviewCount > 0 ? (
                              <Pill tone="warning">{g.needsReviewCount} need review</Pill>
                            ) : (
                              <Pill tone="success">Verified</Pill>
                            );
                          })()}
                        </td>
                        <td><span className="joined">{fmtDate(g.lastPaidAt)}</span></td>
                        <td className="td-num" style={{ paddingRight: 28 }}>
                          {formatRawUsdcCompact(g.totalPaidRaw)}{' '}
                          <span style={{ color: 'var(--text-faint)' }}>USDC</span>
                        </td>
                        <td className="td-num" style={{ paddingRight: 28 }}>{g.paymentCount}</td>
                        <td>
                          <span
                            className="row-arrow"
                            style={{
                              display: 'inline-flex',
                              transform: isExpanded ? 'rotate(90deg)' : 'none',
                              transition: 'transform 120ms ease',
                            }}
                          >
                            <Ico.chevRight w={16} />
                          </span>
                        </td>
                      </tr>
                      {isExpanded ? (
                        <tr>
                          <td colSpan={6} style={{ padding: 0 }}>
                            <div
                              style={{
                                background: 'var(--bg-subtle)',
                                borderTop: '1px solid var(--border-strong)',
                                padding: '2px 24px 2px 64px',
                              }}
                            >
                              <VendorPayableControls
                                vendor={g.addresses[0]?.wallet.counterpartyId ? vendorById.get(g.addresses[0].wallet.counterpartyId!) ?? null : null}
                                pending={payableMutation.isPending}
                                isPrimaryAdmin={isPrimaryAdmin}
                                onSet={(counterpartyId, status, reason) => payableMutation.mutate({ counterpartyId, status, reason })}
                              />
                              {(() => {
                                const cpId = g.addresses[0]?.wallet.counterpartyId;
                                const rule = cpId ? codingRuleByVendor.get(cpId) : null;
                                if (!rule) return null;
                                return (
                                  <div onClick={(e) => e.stopPropagation()}
                                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 0', borderBottom: '1px solid var(--border-strong)' }}>
                                    <Ico.book w={14} />
                                    <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--text-muted)' }}>
                                      Bills from this vendor code to <b style={{ color: 'var(--text-primary)' }}>{rule.accountName ?? rule.accountId}</b>
                                      {' — '}
                                      {rule.source === 'manual' ? 'set by your team' : `learned from ${rule.learnedFromCount} agreeing bill${rule.learnedFromCount === 1 ? '' : 's'}`}.
                                    </span>
                                    {isAdminTier ? (
                                      <button type="button" className="btn btn-secondary btn-sm" disabled={clearCodingRule.isPending}
                                        onClick={() => clearCodingRule.mutate(cpId!)}>
                                        Remove default
                                      </button>
                                    ) : null}
                                  </div>
                                );
                              })()}
                              {g.addresses.map((r, i) => {
                                const w = r.wallet;
                                return (
                                  <div
                                    key={w.counterpartyWalletId}
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: 12,
                                      padding: '11px 0',
                                      borderTop: i === 0 ? 'none' : '1px solid var(--border-strong)',
                                    }}
                                  >
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
                                      <span
                                        style={{
                                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                                          fontSize: 12.5,
                                          color: 'var(--text)',
                                          wordBreak: 'break-all',
                                        }}
                                      >
                                        {w.walletAddress}
                                      </span>
                                      <button
                                        type="button"
                                        title="Copy address"
                                        aria-label="Copy address"
                                        onClick={() => copyAddress(w.walletAddress)}
                                        style={{
                                          display: 'inline-flex',
                                          alignItems: 'center',
                                          background: 'transparent',
                                          border: 'none',
                                          color: 'var(--text-muted)',
                                          cursor: 'pointer',
                                          padding: 4,
                                          flexShrink: 0,
                                        }}
                                      >
                                        <CopyIcon />
                                      </button>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                                      {w.isPrimary ? (
                                        <span
                                          style={{
                                            fontSize: 10,
                                            fontWeight: 600,
                                            textTransform: 'uppercase',
                                            letterSpacing: 0.4,
                                            color: 'var(--accent)',
                                            border: '1px solid var(--accent)',
                                            borderRadius: 4,
                                            padding: '1px 5px',
                                          }}
                                        >
                                          Default
                                        </span>
                                      ) : null}
                                      <Pill tone={trustTone(w.trustState)}>{trustLabel(w.trustState)}</Pill>
                                      <button
                                        type="button"
                                        className="btn btn-secondary btn-sm"
                                        onClick={() => setEditing(w)}
                                      >
                                        Edit
                                      </button>
                                      <button
                                        type="button"
                                        className="btn btn-danger-ghost btn-sm"
                                        disabled={removeMutation.isPending}
                                        onClick={() => {
                                          if (window.confirm(`Remove this address from "${g.name}"?`)) {
                                            removeMutation.mutate(w.counterpartyWalletId);
                                          }
                                        }}
                                      >
                                        Remove
                                      </button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {addOpen ? (
        <VendorDialog
          mode="create"
          pending={createMutation.isPending}
          onClose={() => setAddOpen(false)}
          onSubmit={(payload) => createMutation.mutate(payload)}
        />
      ) : null}

      {editing ? (
        <VendorDialog
          mode="edit"
          initial={editing}
          pending={updateMutation.isPending}
          onClose={() => setEditing(null)}
          onSubmit={(payload) =>
            updateMutation.mutate({
              counterpartyWalletId: editing.counterpartyWalletId,
              label: payload.label,
              trustState: payload.trustState,
              notes: payload.notes ?? null,
              isPrimary: payload.isPrimary,
            })
          }
        />
      ) : null}
    </div>
  );
}

// Payable gate controls (policy P0): hold (any admin) / block (primary admin,
// enforced server-side) with a mandatory on-the-record reason; release/unblock
// restores flow. Bills for a held/blocked vendor can't leave Review.
function VendorPayableControls(props: {
  vendor: Counterparty | null;
  pending: boolean;
  isPrimaryAdmin: boolean;
  onSet: (counterpartyId: string, status: 'payable' | 'held' | 'blocked', reason: string | null) => void;
}) {
  const [mode, setMode] = useState<'held' | 'blocked' | null>(null);
  const [reason, setReason] = useState('');
  if (!props.vendor) return null;
  const vendor = props.vendor;
  const hold = vendor.payableHold;
  const submit = () => {
    if (!mode || reason.trim().length < 3) return;
    props.onSet(vendor.counterpartyId, mode, reason.trim());
    setMode(null);
    setReason('');
  };
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 0', borderBottom: '1px solid var(--border-strong)' }}
    >
      <Ico.shield w={14} />
      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: hold ? 'var(--text-primary)' : 'var(--text-muted)' }}>
        {hold
          ? `${hold.status === 'blocked' ? 'Blocked' : 'Payments on hold'} — ${hold.byName}: “${hold.reason}”`
          : 'Payments to this vendor can flow.'}
      </span>
      {mode ? (
        <>
          <input
            className="input"
            value={reason}
            autoFocus
            placeholder={mode === 'blocked' ? 'Why block them? Goes on the record.' : 'Why hold payments? Goes on the record.'}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setMode(null); }}
            style={{ width: 280, height: 30 }}
          />
          <button type="button" className="btn btn-primary btn-sm" disabled={props.pending || reason.trim().length < 3} onClick={submit}>
            {mode === 'blocked' ? 'Block' : 'Hold'}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMode(null)}>Cancel</button>
        </>
      ) : hold ? (
        <button type="button" className="btn btn-secondary btn-sm"
          disabled={props.pending || (hold.status === 'blocked' && !props.isPrimaryAdmin)}
          title={hold.status === 'blocked' && !props.isPrimaryAdmin ? 'Only the primary admin can unblock a vendor.' : undefined}
          onClick={() => props.onSet(vendor.counterpartyId, 'payable', null)}>
          {hold.status === 'blocked' ? 'Unblock' : 'Release hold'}
        </button>
      ) : (
        <>
          <button type="button" className="btn btn-secondary btn-sm" disabled={props.pending} onClick={() => setMode('held')}>
            Hold payments
          </button>
          <button type="button" className="btn btn-secondary btn-sm"
            disabled={props.pending || !props.isPrimaryAdmin}
            title={props.isPrimaryAdmin ? undefined : 'Only the primary admin can block a vendor.'}
            onClick={() => setMode('blocked')}>
            Block
          </button>
        </>
      )}
    </div>
  );
}

function VendorDialog(
  props:
    | {
        mode: 'create';
        initial?: undefined;
        pending: boolean;
        onClose: () => void;
        onSubmit: (payload: {
          label: string;
          walletAddress: string;
          trustState: CounterpartyWalletTrustState;
          notes?: string;
          isPrimary?: boolean;
        }) => void;
      }
    | {
        mode: 'edit';
        initial: CounterpartyWallet;
        pending: boolean;
        onClose: () => void;
        onSubmit: (payload: {
          label: string;
          walletAddress: string;
          trustState: CounterpartyWalletTrustState;
          notes?: string;
          isPrimary?: boolean;
        }) => void;
      },
): ReactNode {
  const { mode, pending, onClose, onSubmit } = props;
  const initial = props.mode === 'edit' ? props.initial : null;

  const [label, setLabel] = useState(initial?.label ?? '');
  const [walletAddress, setWalletAddress] = useState(initial?.walletAddress ?? '');
  const [trustState, setTrustState] = useState<CounterpartyWalletTrustState>(
    initial?.trustState ?? 'unreviewed',
  );
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [isPrimary, setIsPrimary] = useState(initial?.isPrimary ?? false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const title = mode === 'create' ? 'Add vendor' : 'Edit vendor';
  const submitLabel = mode === 'create' ? 'Save vendor' : 'Save changes';

  return (
    <div
      className="overlay"
      style={{ position: 'fixed', inset: 0, zIndex: 60 }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !pending) onClose();
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dec-vendor-title"
        style={{ maxWidth: 540 }}
      >
        <div className="dialog-head">
          <div>
            <h2 id="dec-vendor-title">{title}</h2>
            <p>
              {mode === 'create'
                ? 'Solana wallet you pay. Mark verified now or review and approve later.'
                : "Update the label, status, or notes. The wallet address can't be changed."}
            </p>
          </div>
          <button
            type="button"
            className="drawer-x"
            onClick={onClose}
            disabled={pending}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit({
              label: label.trim(),
              walletAddress: mode === 'create' ? walletAddress.trim() : initial!.walletAddress,
              trustState,
              notes: notes.trim() || undefined,
              isPrimary: trustState === 'trusted' ? isPrimary : false,
            });
          }}
        >
          <div className="dialog-body">
            <div className="field">
              <label className="field-label" htmlFor="dec-vendor-label">Vendor name</label>
              <input
                id="dec-vendor-label"
                className="input"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Acme Corp"
                autoFocus
                required
              />
            </div>
            {mode === 'create' ? (
              <div className="field">
                <label className="field-label" htmlFor="dec-vendor-addr">Solana wallet address</label>
                <input
                  id="dec-vendor-addr"
                  className="input mono"
                  value={walletAddress}
                  onChange={(e) => setWalletAddress(e.target.value)}
                  placeholder="Solana address"
                  required
                  style={{ fontSize: 12 }}
                />
              </div>
            ) : (
              <div className="field">
                <label className="field-label">Wallet address</label>
                <div
                  className="mono"
                  style={{
                    border: '1px solid var(--border-strong)',
                    borderRadius: 8,
                    background: 'var(--bg-subtle)',
                    color: 'var(--text-soft)',
                    fontSize: 12,
                    lineHeight: 1.5,
                    padding: '10px 12px',
                    whiteSpace: 'normal',
                    wordBreak: 'break-all',
                    userSelect: 'all',
                  }}
                >
                  {initial!.walletAddress}
                </div>
              </div>
            )}
            <div className="field">
              <label className="field-label" htmlFor="dec-vendor-trust">Trust status</label>
              <div className="select">
                <select
                  id="dec-vendor-trust"
                  value={trustState}
                  onChange={(e) => setTrustState(e.target.value as CounterpartyWalletTrustState)}
                >
                  <option value="unreviewed">Unreviewed</option>
                  <option value="trusted">Verified</option>
                  <option value="restricted">Restricted</option>
                  <option value="blocked">Blocked</option>
                </select>
                <Ico.chevDown w={14} />
              </div>
            </div>
            {mode === 'edit' ? (
              <div className="field">
                <label
                  className="field-label"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    cursor: trustState === 'trusted' ? 'pointer' : 'not-allowed',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isPrimary}
                    disabled={trustState !== 'trusted'}
                    onChange={(e) => setIsPrimary(e.target.checked)}
                  />
                  Primary (default) payout address
                </label>
                <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                  {trustState === 'trusted'
                    ? 'Invoices for this vendor that don’t include an address pay here.'
                    : 'Only a verified address can be the default.'}
                </span>
              </div>
            ) : null}
            <div className="field">
              <label className="field-label" htmlFor="dec-vendor-notes">
                Notes{' '}
                <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>· optional</span>
              </label>
              <input
                id="dec-vendor-notes"
                className="input"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Verified via signed contract on 2026-04-22"
              />
            </div>
          </div>
          <div className="dialog-foot">
            <button
              type="submit"
              className="btn btn-primary"
              style={{ flex: 1 }}
              disabled={pending}
              aria-busy={pending}
            >
              {pending ? 'Saving…' : submitLabel}
            </button>
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={pending}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
