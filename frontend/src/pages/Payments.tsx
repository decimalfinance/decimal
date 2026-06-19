import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type {
  BatchCsvUploadResult,
  CounterpartyWallet,
  InvoiceIntakeSkippedRow,
  InvoiceUploadResult,
  PaymentOrder,
  PaymentOrderAgentAdvanceResult,
  TreasuryWallet,
} from '../types';
import {
  assetSymbol,
  formatRawUsdcCompact,
  shortenAddress,
  walletLabel,
} from '../domain';
import { parseCsvPreview } from '../csv-parse';
import {
  displayPaymentStatus,
  hasRealWalletLabel,
  statusToneForPayment,
} from '../status-labels';
import { useToast } from '../ui/Toast';
import { Ico } from '../dec/icons';
import { PageHead, Pill, SLPill, OriginPill } from '../dec/primitives';

// Every row is a PaymentOrder now. Batched orders carry an inputBatchLabel
// rendered as a small chip, but they live in the same list as standalone
// payments — no separate "run" entity to model in the UI.
type UnifiedRow = {
  kind: 'single';
  id: string;
  name: string;
  counterpartyName: string | null;
  destination: string;
  destinationLabel: string | null;
  source: string;
  amountLabel: string;
  state: string;
  tone: 'success' | 'warning' | 'danger' | 'neutral';
  // True when the row needs a human's eyes: agent flagged the invoice,
  // or the destination wallet isn't trusted. Drives both the "Needs
  // review" filter and the metric.
  needsReview: boolean;
  // Tx landed on-chain but moved the wrong USDC amount — surfaced loudly.
  settlementMismatch: boolean;
  // Settled payment posted to the connected accounting system (QuickBooks).
  synced: boolean;
  // 'batch' iff the order entered via a CSV batch (carries originLabel).
  // 'single' otherwise (invoice upload or manual entry).
  origin: 'single' | 'batch';
  originLabel?: string;
  // True if the agent auto-paid this order under a spending-limit policy
  // instead of going through the Squads voting path. Drives the small "SL"
  // chip next to the status pill so the user can scan SL vs proposal routes.
  routedViaSpendingLimit: boolean;
  createdAt: string;
  to: string;
};

// "Needs review" is true if the agent flagged the payment OR the destination
// wallet isn't yet trusted (the orange UNREVIEWED chip in the table). We
// surface both under one filter so the user has a single "what needs my eyes"
// view.
function orderNeedsReview(order: PaymentOrder): boolean {
  if (order.derivedState === 'needs_review') return true;
  if (order.counterpartyWallet?.trustState && order.counterpartyWallet.trustState !== 'trusted') return true;
  return false;
}

function sourceLabel(wallet: TreasuryWallet | null): string {
  if (!wallet) return '—';
  if (wallet.displayName && wallet.displayName.trim().length) return wallet.displayName;
  return shortenAddress(wallet.address, 4, 4);
}

function usdcToRaw(value: string): string {
  const [whole, frac = ''] = value.replace(/[^0-9.]/g, '').split('.');
  const fracPadded = (frac + '000000').slice(0, 6);
  return (BigInt(whole || '0') * 1_000_000n + BigInt(fracPadded || '0')).toString();
}

export function PaymentsPage() {
  const { organizationId } = useParams<{ organizationId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();

  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [uploadDocOpen, setUploadDocOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'settled' | 'needs_review'>('all');

  const paymentOrdersQuery = useQuery({
    queryKey: ['payment-orders', organizationId] as const,
    queryFn: () => api.listPaymentOrders(organizationId!),
    enabled: Boolean(organizationId),
    refetchInterval: 10_000,
  });
  const addressesQuery = useQuery({
    queryKey: ['addresses', organizationId] as const,
    queryFn: () => api.listTreasuryWallets(organizationId!),
    enabled: Boolean(organizationId),
  });
  const destinationsQuery = useQuery({
    queryKey: ['counterparty-wallets', organizationId] as const,
    queryFn: () => api.listCounterpartyWallets(organizationId!),
    enabled: Boolean(organizationId),
  });

  if (!organizationId) {
    return (
      <main className="page-frame">
        <div className="rd-state">
          <h2 className="rd-state-title">Organization unavailable</h2>
          <p className="rd-state-body">Pick a organization from the sidebar.</p>
        </div>
      </main>
    );
  }

  const orders = paymentOrdersQuery.data?.items ?? [];
  const addresses = addressesQuery.data?.items ?? [];
  const destinations = destinationsQuery.data?.items ?? [];

  const rows = useMemo<UnifiedRow[]>(() => {
    // Discarded (cancelled) payments are hidden from the list — they stay in
    // the DB for audit but shouldn't clutter the operator's view.
    const list: UnifiedRow[] = orders
      .filter((o) => o.derivedState !== 'cancelled')
      .map<UnifiedRow>((o) => ({
      kind: 'single',
      id: o.paymentOrderId,
      name: o.counterpartyWallet.label,
      counterpartyName: o.counterparty?.displayName ?? null,
      destination: o.counterpartyWallet.walletAddress,
      destinationLabel: hasRealWalletLabel(o.counterpartyWallet.label, o.counterpartyWallet.walletAddress)
        ? o.counterpartyWallet.label
        : null,
      source: sourceLabel(o.sourceTreasuryWallet),
      amountLabel: `${formatRawUsdcCompact(o.amountRaw)} ${assetSymbol(o.asset)}`,
      state: displayPaymentStatus(o.derivedState),
      tone: statusToneForPayment(o.derivedState),
      needsReview: orderNeedsReview(o),
      settlementMismatch:
        typeof o.metadataJson?.settlementMismatch === 'object' && o.metadataJson.settlementMismatch !== null,
      synced: o.accountingSync?.status === 'synced',
      origin: o.inputBatchLabel ? 'batch' : 'single',
      originLabel: o.inputBatchLabel ?? undefined,
      routedViaSpendingLimit: Boolean(o.spendingLimitExecution),
      createdAt: o.createdAt,
      to: `/organizations/${organizationId}/payments/${o.paymentOrderId}`,
    }));
    return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [orders, organizationId]);

  const filteredRows = useMemo(() => {
    let out = rows;
    if (filter === 'active') {
      out = out.filter((r) => r.tone === 'warning' || r.tone === 'neutral');
    } else if (filter === 'settled') {
      out = out.filter((r) => r.tone === 'success');
    } else if (filter === 'needs_review') {
      out = out.filter((r) => r.needsReview);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      out = out.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.destination.toLowerCase().includes(q) ||
          (r.counterpartyName ?? '').toLowerCase().includes(q),
      );
    }
    return out;
  }, [rows, filter, search]);

  // Metrics: count actual payments (orders), not batches. A run is a grouping,
  // not a payment — counting both double-counts the same transfer.
  const awaiting = orders.filter((o) => o.derivedState === 'draft').length;
  const needsReview = orders.filter(orderNeedsReview).length;

  const isLoading = paymentOrdersQuery.isLoading;

  // Auto-paid this month: rows with an SL execution.
  const autoPaidThisMonth = rows.filter((r) => r.routedViaSpendingLimit).length;
  const settledThisMonth = rows.filter((r) => r.tone === 'success').length;

  return (
    <div className="page">
      <div className="stack stack-24">
        <PageHead
          eyebrow="PAYMENTS"
          title="All payments"
          desc="Every payment and batch payout in this organization."
          actions={
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setUploadDocOpen(true)}>
                <Ico.upload w={15} />Upload invoice
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setImportOpen(true)}>
                <Ico.csv w={15} />Import CSV
              </button>
              <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
                <Ico.plus w={15} />New payment
              </button>
            </>
          }
        />

        <div className="metrics">
          <div className="metric">
            <div className="m-label">Awaiting your approval</div>
            <div className="m-value">{awaiting}</div>
            <div className="m-sub">{awaiting === 1 ? 'payment' : 'payments'}</div>
          </div>
          <div className="metric">
            <div className="m-label">Auto-paid this month</div>
            <div className="m-value">{autoPaidThisMonth}</div>
            <div className="m-sub">via auto-pay</div>
          </div>
          <div className={`metric${needsReview > 0 ? ' is-alert' : ''}`}>
            <div className="m-label">Needs review</div>
            <div className="m-value">{needsReview}</div>
            <div className="m-sub">{needsReview === 1 ? 'vendor unreviewed' : 'vendors unreviewed'}</div>
          </div>
          <div className="metric">
            <div className="m-label">Settled this month</div>
            <div className="m-value">{settledThisMonth}</div>
            <div className="m-sub">{settledThisMonth === 1 ? 'payment' : 'payments'}</div>
          </div>
        </div>

        <div className="filterbar">
          <div className="tabs">
            {([
              ['all', 'All', rows.length] as const,
              ['active', 'Active', rows.filter((r) => r.tone === 'warning' || r.tone === 'neutral').length] as const,
              ['settled', 'Settled', rows.filter((r) => r.tone === 'success').length] as const,
              ['needs_review', 'Needs review', needsReview] as const,
            ]).map(([key, label, count]) => (
              <button
                key={key}
                className={`tab${filter === key ? ' on' : ''}`}
                onClick={() => setFilter(key)}
                type="button"
              >
                {label}<span className="tab-count">{count}</span>
              </button>
            ))}
          </div>
          <div className="filter-right">
            <div className="input-search">
              <Ico.search w={14} />
              <input
                className="input"
                placeholder="Vendor or invoice #"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="select">
              <select defaultValue="all" disabled>
                <option value="all">All treasuries</option>
              </select>
              <Ico.chevDown w={14} />
            </div>
          </div>
        </div>

        <div className="tbl-card">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: '28%' }}>Vendor</th>
                <th style={{ width: '18%' }}>Source</th>
                <th className="num" style={{ width: '18%', paddingRight: 48 }}>Amount</th>
                <th style={{ width: '16%' }}>Origin</th>
                <th style={{ width: '20%' }}>Status</th>
                <th style={{ width: 28 }}></th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={6} style={{ padding: 16 }}>
                    <div className="skeleton" style={{ height: 48 }} />
                  </td>
                </tr>
              ) : filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    {rows.length === 0 ? (
                      <div className="empty">
                        <div className="empty-icon"><Ico.inbox w={22} /></div>
                        <h4>No payments yet</h4>
                        <p>Upload an invoice and the agent will extract the payable for you.</p>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={() => setUploadDocOpen(true)}
                          style={{ marginTop: 8 }}
                        >
                          <Ico.upload w={13} />Upload invoice
                        </button>
                      </div>
                    ) : (
                      <div className="no-match">
                        <div className="nm-title">No payments match that filter</div>
                        <div className="nm-sub">Clear the search or change the tab to see more.</div>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            setSearch('');
                            setFilter('all');
                          }}
                        >
                          Clear filters
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ) : (
                filteredRows.map((row) => (
                  <tr key={`${row.kind}:${row.id}`} onClick={() => navigate(row.to)}>
                    <td>
                      <div className="cell-vendor">
                        <span className="v-name">
                          {row.counterpartyName ?? row.name}
                        </span>
                      </div>
                    </td>
                    <td>
                      <span className="cell-source">
                        <Ico.treasury w={15} />
                        {row.source === '—' ? '—' : row.source}
                      </span>
                    </td>
                    <td className="td-num" style={{ paddingRight: 48 }}>{row.amountLabel}</td>
                    <td>
                      <OriginPill>
                        {row.origin === 'batch' ? (row.originLabel ?? 'Batch') : 'Single'}
                      </OriginPill>
                    </td>
                    <td>
                      <span className="status-cell">
                        <Pill tone={row.tone === 'neutral' ? 'info' : row.tone}>{row.state}</Pill>
                        {row.routedViaSpendingLimit ? <SLPill /> : null}
                        {row.settlementMismatch ? <Pill tone="danger">Mismatch</Pill> : null}
                        {row.synced ? <Pill tone="success">Synced</Pill> : null}
                      </span>
                    </td>
                    <td>
                      <span className="row-arrow"><Ico.chevRight w={16} /></span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {filteredRows.length > 0 ? (
            <div className="tbl-foot">
              <span className="tf-count">Showing {filteredRows.length} of {rows.length} payments</span>
            </div>
          ) : null}
        </div>

      {createOpen ? (
        <CreatePaymentDialog
          organizationId={organizationId}
          destinations={destinations}
          addresses={addresses}
          onClose={() => setCreateOpen(false)}
          onSuccess={async () => {
            setCreateOpen(false);
            success('Payment created and routed.');
            await queryClient.invalidateQueries({ queryKey: ['payment-orders', organizationId] });
          }}
          onError={(message) => toastError(message)}
        />
      ) : null}

      {importOpen ? (
        <ImportCsvDialog
          organizationId={organizationId}
          addresses={addresses}
          onClose={() => setImportOpen(false)}
          onSuccess={async (name, rows) => {
            setImportOpen(false);
            success(`Imported "${name}" with ${rows} rows. Open the batch to review destinations and route.`);
            await queryClient.invalidateQueries({ queryKey: ['payment-runs', organizationId] });
            await queryClient.invalidateQueries({ queryKey: ['payment-orders', organizationId] });
          }}
          onError={(message) => toastError(message)}
        />
      ) : null}

      {uploadDocOpen ? (
        <UploadDocumentDialog
          organizationId={organizationId}
          onClose={() => setUploadDocOpen(false)}
          onSuccess={async (result) => {
            // We leave the dialog open so the user can see the per-row
            // outcomes (proposal-created, auto-executed, needs review, failed, etc.) and act
            // on each. Just refresh background data here.
            await queryClient.invalidateQueries({ queryKey: ['payment-runs', organizationId] });
            await queryClient.invalidateQueries({ queryKey: ['payment-orders', organizationId] });
            const submitted = result.automation.filter((a) => a.status === 'proposal_submitted').length;
            const executed = result.automation.filter((a) => a.status === 'spending_limit_executed').length;
            const review = result.paymentOrders.filter((p) => p.decision === 'needs_review').length;
            const parts: string[] = [];
            if (submitted > 0) parts.push(`${submitted} proposals created`);
            if (executed > 0) parts.push(`${executed} auto-executed`);
            if (review > 0) parts.push(`${review} needs review`);
            if (result.skippedCount > 0) parts.push(`${result.skippedCount} skipped`);
            success(parts.length ? `Invoice processed — ${parts.join(', ')}.` : 'Invoice processed.');
          }}
          onError={(message) => toastError(message)}
        />
      ) : null}
      </div>
    </div>
  );
}

function CreatePaymentDialog(props: {
  organizationId: string;
  destinations: CounterpartyWallet[];
  addresses: TreasuryWallet[];
  onClose: () => void;
  onSuccess: () => void;
  onError: (message: string) => void;
}) {
  const { organizationId, destinations, addresses, onClose, onSuccess, onError } = props;
  const [counterpartyWalletId, setCounterpartyWalletId] = useState('');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [externalReference, setExternalReference] = useState('');
  const [sourceTreasuryWalletId, setSourceTreasuryWalletId] = useState('');
  const [dueAt, setDueAt] = useState('');

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Group active treasuries by multisig (sourceRef) — that's the "Treasury
  // account", and each row under it is a vault. Lets the user pick at
  // either level (the design has separate Treasury + Vault selects).
  const treasuryAccounts = useMemo(() => {
    const map = new Map<string, { name: string; vaults: TreasuryWallet[] }>();
    for (const a of addresses) {
      if (!a.isActive) continue;
      const key = a.source === 'squads_v4' && a.sourceRef ? a.sourceRef : a.treasuryWalletId;
      const existing = map.get(key);
      const name = a.displayName ?? 'Untitled';
      if (existing) {
        existing.vaults.push(a);
      } else {
        map.set(key, { name, vaults: [a] });
      }
    }
    // Sort vaults inside each account by vault index.
    for (const acc of map.values()) {
      acc.vaults.sort((a, b) => (a.sourceVaultIndex ?? 999) - (b.sourceVaultIndex ?? 999));
      // Use the primary vault's displayName as the account label.
      acc.name = acc.vaults[0]?.displayName ?? acc.name;
    }
    return Array.from(map.entries()).map(([key, v]) => ({ key, ...v }));
  }, [addresses]);

  const selectedAccountKey = useMemo(() => {
    const selected = addresses.find((a) => a.treasuryWalletId === sourceTreasuryWalletId);
    if (!selected) return '';
    return selected.source === 'squads_v4' && selected.sourceRef
      ? selected.sourceRef
      : selected.treasuryWalletId;
  }, [sourceTreasuryWalletId, addresses]);

  const selectedAccount = treasuryAccounts.find((a) => a.key === selectedAccountKey);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!counterpartyWalletId || !amount.trim()) {
        throw new Error('Destination and amount are required.');
      }
      return api.createPaymentOrder(organizationId, {
        counterpartyWalletId,
        amountRaw: usdcToRaw(amount),
        memo: memo.trim() || undefined,
        externalReference: externalReference.trim() || undefined,
        sourceTreasuryWalletId: sourceTreasuryWalletId || undefined,
        dueAt: dueAt.trim() ? new Date(dueAt).toISOString() : undefined,
        autoAdvance: true,
      });
    },
    onSuccess: () => onSuccess(),
    onError: (err) => onError(err instanceof Error ? err.message : 'Could not create payment.'),
  });

  return (
    <div
      className="overlay"
      style={{ position: 'fixed', inset: 0, zIndex: 60 }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !mutation.isPending) onClose();
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dec-new-payment-title"
        style={{ maxWidth: 560 }}
      >
        <div className="dialog-head">
          <div>
            <h2 id="dec-new-payment-title">New payment</h2>
            <p>Pay a verified vendor from one of your treasury vaults.</p>
          </div>
          <button
            type="button"
            className="drawer-x"
            onClick={onClose}
            disabled={mutation.isPending}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
        >
          <div className="dialog-body">
            <div className="field">
              <label className="field-label" htmlFor="dec-np-vendor">Vendor</label>
              <div className="select">
                <select
                  id="dec-np-vendor"
                  value={counterpartyWalletId}
                  onChange={(e) => setCounterpartyWalletId(e.target.value)}
                  required
                >
                  <option value="" disabled>
                    Select a vendor
                  </option>
                  {destinations
                    .filter((d) => d.isActive)
                    .map((d) => (
                      <option key={d.counterpartyWalletId} value={d.counterpartyWalletId}>
                        {d.label} · {d.trustState === 'trusted' ? 'Verified' : d.trustState}
                      </option>
                    ))}
                </select>
                <Ico.chevDown w={14} />
              </div>
              <span className="input-help">Only verified vendors can be paid without review.</span>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="dec-np-amt">Amount</label>
              <div className="amount-input">
                <input
                  id="dec-np-amt"
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                  placeholder="2,176.67"
                  required
                />
                <span className="ai-cur">USDC</span>
              </div>
            </div>
            <div className="row" style={{ display: 'flex', gap: 12 }}>
              <div className="field" style={{ flex: 1 }}>
                <label className="field-label" htmlFor="dec-np-treasury">Treasury</label>
                <div className="select">
                  <select
                    id="dec-np-treasury"
                    value={selectedAccountKey}
                    onChange={(e) => {
                      const acc = treasuryAccounts.find((t) => t.key === e.target.value);
                      const first = acc?.vaults[0];
                      setSourceTreasuryWalletId(first?.treasuryWalletId ?? '');
                    }}
                  >
                    <option value="">Set later</option>
                    {treasuryAccounts.map((acc) => (
                      <option key={acc.key} value={acc.key}>
                        {acc.name}
                      </option>
                    ))}
                  </select>
                  <Ico.chevDown w={14} />
                </div>
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label className="field-label" htmlFor="dec-np-vault">Vault</label>
                <div className="select">
                  <select
                    id="dec-np-vault"
                    value={sourceTreasuryWalletId}
                    onChange={(e) => setSourceTreasuryWalletId(e.target.value)}
                    disabled={!selectedAccount}
                  >
                    {!selectedAccount ? (
                      <option value="">Pick a treasury first</option>
                    ) : (
                      selectedAccount.vaults.map((v) => (
                        <option key={v.treasuryWalletId} value={v.treasuryWalletId}>
                          {v.displayName ?? 'Untitled vault'}
                        </option>
                      ))
                    )}
                  </select>
                  <Ico.chevDown w={14} />
                </div>
              </div>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="dec-np-memo">Memo</label>
              <input
                id="dec-np-memo"
                className="input"
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                placeholder="Invoice INV-1001 · April retainer"
              />
            </div>
            <div className="row" style={{ display: 'flex', gap: 12 }}>
              <div className="field" style={{ flex: 1 }}>
                <label className="field-label" htmlFor="dec-np-ref">Reference</label>
                <input
                  id="dec-np-ref"
                  className="input mono"
                  value={externalReference}
                  onChange={(e) => setExternalReference(e.target.value)}
                  placeholder="INV-1001"
                />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label className="field-label" htmlFor="dec-np-due">
                  Due date{' '}
                  <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>· optional</span>
                </label>
                <input
                  id="dec-np-due"
                  type="date"
                  className="input mono"
                  value={dueAt}
                  onChange={(e) => setDueAt(e.target.value)}
                />
              </div>
            </div>
            {destinations.filter((d) => d.isActive).length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--warning)' }}>
                Add a vendor in Counterparties before creating a payment.
              </div>
            ) : null}
          </div>
          <div className="dialog-foot">
            <button
              type="submit"
              className="btn btn-primary"
              style={{ flex: 1 }}
              disabled={
                mutation.isPending ||
                !counterpartyWalletId ||
                !amount.trim()
              }
              aria-busy={mutation.isPending}
            >
              {mutation.isPending ? 'Creating…' : (
                <>Create &amp; send for approval<Ico.arrowRight w={14} /></>
              )}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={mutation.isPending}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ImportCsvDialog(props: {
  organizationId: string;
  addresses: TreasuryWallet[];
  onClose: () => void;
  onSuccess: (runName: string, rowCount: number) => void;
  onError: (message: string) => void;
}) {
  const { organizationId, addresses, onClose, onSuccess, onError } = props;
  const [step, setStep] = useState<'edit' | 'preview'>('edit');
  const [csvText, setCsvText] = useState('');
  const [runName, setRunName] = useState('');
  const [sourceAddressId, setSourceAddressId] = useState('');

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const preview = useMemo(() => parseCsvPreview(csvText, 10), [csvText]);

  const importMutation = useMutation({
    mutationFn: async (): Promise<BatchCsvUploadResult> => {
      const csv = csvText.trim();
      if (!csv) throw new Error('Paste at least one CSV row.');
      const result = await api.uploadBatchCsv(organizationId, {
        csv,
        batchLabel: runName.trim() || undefined,
        sourceTreasuryWalletId: sourceAddressId || undefined,
        autoAdvance: true,
      });
      if (result.imported === 0) {
        const failedDetail = result.items
          .filter((item): item is Extract<typeof item, { status: 'failed' }> => item.status === 'failed')
          .slice(0, 3)
          .map((item) => `row ${item.rowNumber}: ${item.error}`)
          .join(' · ');
        throw new Error(
          failedDetail
            ? `No rows imported. ${failedDetail}`
            : 'No rows imported. Check that each row has a counterparty, destination, and amount.',
        );
      }
      return result;
    },
    onSuccess: (result) => {
      onSuccess(result.inputBatchLabel, result.imported);
    },
    onError: (err) => onError(err instanceof Error ? err.message : 'CSV import failed.'),
  });

  return (
    <div
      className="overlay"
      style={{ position: 'fixed', inset: 0, zIndex: 60 }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !importMutation.isPending) onClose();
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dec-import-title"
        style={{
          maxWidth: step === 'preview' ? 'min(1040px, 96vw)' : 720,
          width: step === 'preview' ? 'min(1040px, 96vw)' : undefined,
        }}
      >
        <div className="dialog-head">
          <div>
            <h2 id="dec-import-title">Import CSV batch</h2>
            <p>
              Columns:{' '}
              <span className="mono" style={{ color: 'var(--text-primary)' }}>
                counterparty, destination, amount, reference, due_date
              </span>
            </p>
          </div>
          <button
            type="button"
            className="drawer-x"
            onClick={onClose}
            disabled={importMutation.isPending}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="dialog-body">
          {step === 'edit' ? (
            <>
              <div className="row" style={{ display: 'flex', gap: 12 }}>
                <div className="field" style={{ flex: 1 }}>
                  <label className="field-label" htmlFor="dec-csv-name">Batch name</label>
                  <input
                    id="dec-csv-name"
                    className="input"
                    value={runName}
                    onChange={(e) => setRunName(e.target.value)}
                    placeholder="April contributor payouts"
                  />
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label className="field-label" htmlFor="dec-csv-source">
                    Source wallet{' '}
                    <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>· optional</span>
                  </label>
                  <div className="select">
                    <select
                      id="dec-csv-source"
                      value={sourceAddressId}
                      onChange={(e) => setSourceAddressId(e.target.value)}
                    >
                      <option value="">Set later</option>
                      {addresses
                        .filter((a) => a.isActive)
                        .map((a) => (
                          <option key={a.treasuryWalletId} value={a.treasuryWalletId}>
                            {walletLabel(a)}
                          </option>
                        ))}
                    </select>
                    <Ico.chevDown w={14} />
                  </div>
                </div>
              </div>
              <div className="field">
                <label className="field-label" htmlFor="dec-csv-body">CSV</label>
                <textarea
                  id="dec-csv-body"
                  className="input mono"
                  value={csvText}
                  onChange={(e) => setCsvText(e.target.value)}
                  rows={10}
                  placeholder={
                    'counterparty,destination,amount,reference,due_date\nAcme Corp,8cZ65A8ERdVsXq3YnEdMNimwG7DhGe1tPszysJwh43Zx,10.00,INV-1001,2026-05-01'
                  }
                  style={{ resize: 'vertical', fontSize: 12 }}
                />
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                <strong style={{ color: 'var(--text-primary)' }}>{preview.rowCount}</strong> row
                {preview.rowCount === 1 ? '' : 's'} · showing first {preview.rows.length} ·{' '}
                {runName.trim() || '(unnamed batch)'}
              </div>
              <div
                className="tbl-card"
                style={{ maxHeight: 320, overflowY: 'auto', overflowX: 'auto' }}
              >
                <table className="tbl" style={{ minWidth: 760 }}>
                  <thead>
                    <tr>
                      {preview.headers.map((h) => (
                        <th key={h} style={{ whiteSpace: 'nowrap' }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row, ri) => (
                      <tr key={ri}>
                        {preview.headers.map((_, ci) => (
                          <td key={ci} style={{ whiteSpace: 'nowrap' }}>
                            <span className="mono" style={{ fontSize: 12 }}>
                              {row[ci] ?? ''}
                            </span>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
        <div className="dialog-foot">
          {step === 'edit' ? (
            <>
              <button
                type="button"
                className="btn btn-primary"
                style={{ flex: 1 }}
                disabled={!csvText.trim()}
                onClick={() => {
                  const p = parseCsvPreview(csvText);
                  if (p.parseError) {
                    onError(p.parseError);
                    return;
                  }
                  if (!p.headers.length) {
                    onError('Add a header row and at least one data row.');
                    return;
                  }
                  setStep('preview');
                }}
              >
                Review<Ico.arrowRight w={14} />
              </button>
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-primary"
                style={{ flex: 1 }}
                disabled={importMutation.isPending}
                onClick={() => importMutation.mutate()}
                aria-busy={importMutation.isPending}
              >
                {importMutation.isPending ? 'Importing…' : (
                  <>Confirm import<Ico.arrowRight w={14} /></>
                )}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setStep('edit')}
                disabled={importMutation.isPending}
              >
                Back
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function UploadDocumentDialog(props: {
  organizationId: string;
  onClose: () => void;
  onSuccess: (result: InvoiceUploadResult) => void;
  onError: (message: string) => void;
}) {
  const { organizationId, onClose, onSuccess, onError } = props;
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InvoiceUploadResult | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !running) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, running]);

  const start = async () => {
    if (!file) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const dataBase64 = await fileToBase64(file);
      const out = await api.uploadInvoice(organizationId, {
        filename: file.name,
        mimeType: file.type || guessMimeFromFilename(file.name),
        dataBase64,
        autoAdvance: true,
      });
      setResult(out);
      onSuccess(out);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invoice upload failed.';
      setError(message);
      onError(message);
    } finally {
      setRunning(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const dropped = e.dataTransfer?.files?.[0];
    if (dropped) setFile(dropped);
  };

  const reset = () => {
    setError(null);
    setResult(null);
    setFile(null);
  };

  // Three-step layout matching design's UploadDrawer: picker (file
  // pick) → processing (extracting…) → result (per-row outcomes). The
  // header copy + footer button change per step.
  const step: 'picker' | 'processing' | 'error' | 'result' = result
    ? 'result'
    : error
      ? 'error'
      : running
        ? 'processing'
        : 'picker';

  const headTitle = {
    picker: 'Upload an invoice',
    processing: 'Extracting…',
    error: 'Couldn\'t process',
    result: 'Created',
  }[step];
  const headSub = {
    picker: 'PDF or image. The agent extracts vendor, amount and due date.',
    processing: 'Reading vendor, amount, due date, and invoice number.',
    error: 'Something went wrong.',
    result: 'The agent drafted payables from your file.',
  }[step];

  return (
    <div
      className="overlay"
      style={{ position: 'fixed', inset: 0, zIndex: 60 }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !running) onClose();
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dec-upload-title"
        style={{ maxWidth: step === 'result' ? 640 : 520 }}
      >
        <div className="dialog-head">
          <div>
            <h2 id="dec-upload-title">{headTitle}</h2>
            <p>{headSub}</p>
          </div>
          <button
            type="button"
            className="drawer-x"
            onClick={onClose}
            disabled={running}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="dialog-body">
          {step === 'picker' ? (
            <div
              className="dropzone"
              data-dragging={isDragging || undefined}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={onDrop}
              onClick={() => document.getElementById('dec-upload-input')?.click()}
              role="button"
              tabIndex={0}
              style={{ cursor: 'pointer' }}
            >
              <input
                id="dec-upload-input"
                type="file"
                accept=".pdf,application/pdf,image/*"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                style={{ display: 'none' }}
              />
              <Ico.upload w={34} />
              {file ? (
                <>
                  <span className="dz-main">{file.name}</span>
                  <span className="dz-sub">{(file.size / 1024).toFixed(0)} KB · click to swap</span>
                </>
              ) : (
                <>
                  <span className="dz-main">Drag a PDF here, or click to browse</span>
                  <span className="dz-sub">Up to 10 MB · PDF or image</span>
                </>
              )}
            </div>
          ) : null}

          {step === 'processing' ? (
            <>
              <div
                className="dropzone"
                style={{ height: 96, cursor: 'default', borderStyle: 'solid' }}
              >
                <span className="dz-main" style={{ color: 'var(--text-muted)' }}>
                  {file?.name ?? 'Invoice'}
                </span>
                <span className="dz-sub">
                  {file ? `${(file.size / 1024).toFixed(0)} KB · reading…` : 'reading…'}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div className="field">
                  <span className="field-label">Vendor</span>
                  <div className="skeleton" style={{ width: '78%', height: 14 }} />
                </div>
                <div className="field">
                  <span className="field-label">Amount</span>
                  <div className="skeleton" style={{ width: '46%', height: 14 }} />
                </div>
                <div className="field">
                  <span className="field-label">Due date</span>
                  <div className="skeleton" style={{ width: '58%', height: 14 }} />
                </div>
              </div>
            </>
          ) : null}

          {step === 'error' ? (
            <div
              className="sl-banner"
              style={{
                background: 'color-mix(in srgb, var(--danger) 8%, transparent)',
                borderColor: 'color-mix(in srgb, var(--danger) 30%, transparent)',
              }}
            >
              <span
                className="slb-icon"
                style={{
                  color: 'var(--danger)',
                  borderColor: 'color-mix(in srgb, var(--danger) 35%, var(--border))',
                }}
              >
                !
              </span>
              <span className="slb-text">
                <b>Couldn't process the invoice.</b>
                <div style={{ marginTop: 4, color: 'var(--text-muted)' }}>{error}</div>
              </span>
            </div>
          ) : null}

          {step === 'result' && result ? (
            <UploadResultPanel
              organizationId={organizationId}
              result={result}
              onClose={onClose}
              onUploadAnother={reset}
            />
          ) : null}
        </div>
        <div className="dialog-foot">
          {step === 'picker' ? (
            <>
              <button
                type="button"
                className="btn btn-primary"
                style={{ flex: 1 }}
                disabled={!file}
                onClick={start}
              >
                Process invoice<Ico.arrowRight w={14} />
              </button>
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Cancel
              </button>
            </>
          ) : null}
          {step === 'processing' ? (
            <button type="button" className="btn btn-secondary" style={{ flex: 1 }} disabled>
              Extracting…
            </button>
          ) : null}
          {step === 'error' ? (
            <>
              <button
                type="button"
                className="btn btn-primary"
                style={{ flex: 1 }}
                onClick={() => {
                  setError(null);
                  void start();
                }}
              >
                Retry<Ico.arrowRight w={14} />
              </button>
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Close
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// Renders the per-row outcomes from an /invoices/upload response.
// One row per created payment order, plus a section for rows that
// couldn't even become payment orders (skipped). Each row carries an
// action — open the payment detail, retry the agent advance, etc.
function UploadResultPanel(props: {
  organizationId: string;
  result: InvoiceUploadResult;
  onClose: () => void;
  onUploadAnother: () => void;
}) {
  const { organizationId, result, onClose, onUploadAnother } = props;
  const automationByOrderId = useMemo(() => {
    const map = new Map<string, PaymentOrderAgentAdvanceResult>();
    for (const a of result.automation) map.set(a.paymentOrderId, a);
    return map;
  }, [result.automation]);

  const submittedCount = result.automation.filter((a) => a.status === 'proposal_submitted').length;
  const executedCount = result.automation.filter((a) => a.status === 'spending_limit_executed').length;
  const reviewCount = result.paymentOrders.filter((p) => p.decision === 'needs_review').length;

  return (
    <>
      <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
        {result.createdCount} payment order{result.createdCount === 1 ? '' : 's'} created
        {submittedCount > 0 ? ` · ${submittedCount} auto-submitted` : null}
        {executedCount > 0 ? ` · ${executedCount} auto-executed` : null}
        {reviewCount > 0 ? ` · ${reviewCount} needs review` : null}
        {result.skippedCount > 0 ? ` · ${result.skippedCount} skipped` : null}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {result.paymentOrders.map(({ paymentOrder }) => (
          <UploadResultRow
            key={paymentOrder.paymentOrderId}
            organizationId={organizationId}
            order={paymentOrder}
            initialAutomation={automationByOrderId.get(paymentOrder.paymentOrderId) ?? null}
          />
        ))}
        {result.skippedRows.map((row, i) => (
          <SkippedRowDisplay key={`skipped-${i}`} row={row} />
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn-primary" style={{ flex: 1 }} onClick={onClose}>
          Done
        </button>
        <button type="button" className="btn btn-secondary" onClick={onUploadAnother}>
          Upload another
        </button>
      </div>
    </>
  );
}

function UploadResultRow(props: {
  organizationId: string;
  order: PaymentOrder;
  initialAutomation: PaymentOrderAgentAdvanceResult | null;
}) {
  const { organizationId, order, initialAutomation } = props;
  const [automation, setAutomation] = useState<PaymentOrderAgentAdvanceResult | null>(initialAutomation);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const retry = async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      const next = await api.advancePaymentOrder(organizationId, order.paymentOrderId);
      setAutomation(next);
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : 'Retry failed.');
    } finally {
      setRetrying(false);
    }
  };

  const counterpartyLabel = order.counterpartyWallet?.label
    ?? order.counterpartyWallet?.counterparty?.displayName
    ?? '—';
  const amountLabel = formatRawUsdcCompact(order.amountRaw);
  const reference = order.externalReference || order.invoiceNumber || null;

  const status = automation?.status ?? 'not_applicable';
  const tone = statusToneForAutomation(status);
  const statusLabel = labelForAutomationStatus(status);
  const showRetry = status === 'failed' || status === 'blocked' || status === 'needs_source_treasury' || status === 'unsupported_source_treasury';

  const pillTone =
    tone === 'success' ? 'success' : tone === 'warning' ? 'warning' : tone === 'danger' ? 'danger' : 'neutral';
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: 12,
        alignItems: 'center',
        padding: '12px 14px',
        background: 'var(--bg-surface-2)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-sm)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>
          {counterpartyLabel}{' '}
          <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
            · {amountLabel}{reference ? ` · ${reference}` : ''}
          </span>
        </div>
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Pill tone={pillTone}>{statusLabel}</Pill>
          {automation?.reason && status !== 'proposal_submitted' ? (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{automation.reason}</span>
          ) : null}
          {retryError ? (
            <span style={{ fontSize: 12, color: 'var(--danger)' }}>{retryError}</span>
          ) : null}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {showRetry ? (
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={retry}
            disabled={retrying}
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        ) : null}
        <Link
          to={`/organizations/${organizationId}/payments/${order.paymentOrderId}`}
          className="btn btn-sm btn-secondary"
          style={{ textDecoration: 'none' }}
        >
          {status === 'needs_review' ? 'Review' : 'Open'}<Ico.arrowRight w={13} />
        </Link>
      </div>
    </div>
  );
}

function SkippedRowDisplay(props: { row: InvoiceIntakeSkippedRow }) {
  const { row } = props;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr',
        gap: 4,
        padding: '12px 14px',
        background: 'var(--bg-surface-2)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-sm)',
        opacity: 0.85,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>
        {row.counterparty}{' '}
        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
          · {row.amount} {row.currency}{row.reference ? ` · ${row.reference}` : ''}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
        <Pill tone="danger">Skipped</Pill>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{row.message}</span>
      </div>
    </div>
  );
}

function statusToneForAutomation(status: PaymentOrderAgentAdvanceResult['status']): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (status) {
    case 'proposal_submitted':
    case 'spending_limit_executed':
    case 'already_has_proposal':
    case 'already_has_spending_limit_execution':
      return 'success';
    case 'needs_review':
    case 'needs_source_treasury':
    case 'unsupported_source_treasury':
      return 'warning';
    case 'failed':
    case 'blocked':
      return 'danger';
    case 'not_applicable':
    default:
      return 'neutral';
  }
}

function labelForAutomationStatus(status: PaymentOrderAgentAdvanceResult['status']): string {
  switch (status) {
    case 'proposal_submitted': return 'Auto-submitted for voting';
    case 'spending_limit_executed': return 'Auto-executed';
    case 'already_has_proposal': return 'Has proposal';
    case 'already_has_spending_limit_execution': return 'Already executed';
    case 'needs_review': return 'Needs review';
    case 'needs_source_treasury': return 'Needs treasury';
    case 'unsupported_source_treasury': return 'Treasury unsupported';
    case 'failed': return 'Failed';
    case 'blocked': return 'Blocked';
    case 'not_applicable': return 'Pending';
    default: return status;
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('FileReader returned non-string result'));
        return;
      }
      // result is a data URL like "data:application/pdf;base64,JVBERi0..."
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

function guessMimeFromFilename(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'application/octet-stream';
}
