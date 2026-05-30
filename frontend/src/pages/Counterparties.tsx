// Address book — implements PageAddressBook from the design.
// Vendors and counterparties the org pays. Per-row aggregates (last
// payment, total paid, payment count) are computed client-side from
// paymentOrders so we don't need a new endpoint.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type {
  AuthenticatedSession,
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

type VendorRow = {
  wallet: CounterpartyWallet;
  lastPaidAt: string | null;
  totalPaidRaw: string;
  paymentCount: number;
};

export function CounterpartiesPage({ session: _session }: { session: AuthenticatedSession }) {
  const { organizationId } = useParams<{ organizationId: string }>();
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();

  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<CounterpartyWallet | null>(null);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<LocalTab>('all');

  const walletsQuery = useQuery({
    queryKey: ['counterparty-wallets', organizationId] as const,
    queryFn: () => api.listCounterpartyWallets(organizationId!),
    enabled: Boolean(organizationId),
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
    }) =>
      api.updateCounterpartyWallet(organizationId!, input.counterpartyWalletId, {
        label: input.label,
        trustState: input.trustState,
        notes: input.notes,
      }),
    onSuccess: async () => {
      success('Vendor updated.');
      setEditing(null);
      await invalidate();
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Unable to update vendor.'),
  });

  if (!organizationId) {
    return (
      <div className="page">
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

  const isLoading = walletsQuery.isLoading;

  return (
    <div className="page">
      <div className="stack stack-24">
        <PageHead
          eyebrow="REGISTRY"
          title="Address book"
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
                {filtered.map((r) => {
                  const w = r.wallet;
                  const lastDate = r.lastPaidAt
                    ? new Date(r.lastPaidAt).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })
                    : '—';
                  return (
                    <tr
                      key={w.counterpartyWalletId}
                      onClick={() => setEditing(w)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>
                        <div className="member-cell">
                          <span className="m-avatar">{vendorInitials(w.label)}</span>
                          <div className="col">
                            <span className="m-name">{w.label}</span>
                            {w.counterparty?.displayName && w.counterparty.displayName !== w.label ? (
                              <span className="m-sub" style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--text-faint)' }}>
                                {w.counterparty.displayName}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </td>
                      <td>
                        <Pill tone={trustTone(w.trustState)}>{trustLabel(w.trustState)}</Pill>
                      </td>
                      <td>
                        <span className="joined">{lastDate}</span>
                      </td>
                      <td className="td-num" style={{ paddingRight: 28 }}>
                        {formatRawUsdcCompact(r.totalPaidRaw)}{' '}
                        <span style={{ color: 'var(--text-faint)' }}>USDC</span>
                      </td>
                      <td className="td-num" style={{ paddingRight: 28 }}>{r.paymentCount}</td>
                      <td><span className="row-arrow"><Ico.chevRight w={16} /></span></td>
                    </tr>
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
            })
          }
        />
      ) : null}
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
                  className="input mono"
                  style={{
                    background: 'var(--bg-surface-2)',
                    color: 'var(--text-muted)',
                    fontSize: 12,
                    wordBreak: 'break-all',
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
