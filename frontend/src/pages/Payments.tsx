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
    const list: UnifiedRow[] = orders.map<UnifiedRow>((o) => ({
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
            <div className="m-sub">via spending limits</div>
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
              <Ico.search w={15} />
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
                <th className="num" style={{ width: '18%' }}>Amount</th>
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
                    <td className="td-num">{row.amountLabel}</td>
                    <td>
                      <OriginPill>
                        {row.origin === 'batch' ? (row.originLabel ?? 'Batch') : 'Single'}
                      </OriginPill>
                    </td>
                    <td>
                      <span className="status-cell">
                        <Pill>{row.state}</Pill>
                        {row.routedViaSpendingLimit ? <SLPill /> : null}
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
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const mutation = useMutation({
    mutationFn: async (form: FormData) => {
      const counterpartyWalletId = String(form.get('counterpartyWalletId') ?? '');
      const amount = String(form.get('amount') ?? '').trim();
      const reason = String(form.get('reason') ?? '').trim();
      if (!counterpartyWalletId || !amount || !reason) {
        throw new Error('Destination, amount, and reason are required.');
      }
      // Create the PaymentOrder directly and ask the agent to route it
      // through a spending limit or Squads proposal server-side.
      return api.createPaymentOrder(organizationId, {
        counterpartyWalletId,
        amountRaw: usdcToRaw(amount),
        memo: reason,
        externalReference: String(form.get('externalReference') ?? '') || undefined,
        sourceTreasuryWalletId: String(form.get('sourceTreasuryWalletId') ?? '') || undefined,
        autoAdvance: true,
      });
    },
    onSuccess: () => onSuccess(),
    onError: (err) => onError(err instanceof Error ? err.message : 'Could not create payment.'),
  });

  return (
    <div
      className="rd-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rd-create-title"
    >
      <div className="rd-dialog" style={{ maxWidth: 520 }}>
        <h2 id="rd-create-title" className="rd-dialog-title">
          New payment
        </h2>
        <p className="rd-dialog-body">
          One payment, one destination. Decimal routes it through a spending limit or Squads proposal automatically.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate(new FormData(e.currentTarget));
          }}
        >
          <div className="rd-form-grid">
            <label className="rd-field" style={{ gridColumn: '1 / -1' }}>
              <span className="rd-field-label">Destination</span>
              <select name="counterpartyWalletId" required className="rd-select" defaultValue="">
                <option value="" disabled>
                  Select destination
                </option>
                {destinations
                  .filter((d) => d.isActive)
                  .map((d) => (
                    <option key={d.counterpartyWalletId} value={d.counterpartyWalletId}>
                      {d.label} · {d.trustState}
                    </option>
                  ))}
              </select>
            </label>
            <label className="rd-field">
              <span className="rd-field-label">Amount (USDC)</span>
              <input
                name="amount"
                required
                placeholder="10.00"
                className="rd-input"
                inputMode="decimal"
                autoComplete="off"
              />
            </label>
            <label className="rd-field">
              <span className="rd-field-label">Reference</span>
              <input
                name="externalReference"
                placeholder="INV-1001"
                className="rd-input"
                autoComplete="off"
              />
            </label>
            <label className="rd-field" style={{ gridColumn: '1 / -1' }}>
              <span className="rd-field-label">Reason</span>
              <input
                name="reason"
                required
                placeholder="Pay vendor for April services"
                className="rd-input"
                autoComplete="off"
              />
            </label>
            <label className="rd-field">
              <span className="rd-field-label">Source wallet (optional)</span>
              <select name="sourceTreasuryWalletId" className="rd-select" defaultValue="">
                <option value="">Set later</option>
                {addresses
                  .filter((a) => a.isActive)
                  .map((a) => (
                    <option key={a.treasuryWalletId} value={a.treasuryWalletId}>
                      {walletLabel(a)}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <div className="rd-dialog-actions" style={{ marginTop: 24 }}>
            <button type="button" className="rd-btn rd-btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="rd-btn rd-btn-primary"
              disabled={mutation.isPending || destinations.length === 0}
              aria-busy={mutation.isPending}
            >
              {mutation.isPending ? 'Creating…' : 'Create payment'}
            </button>
          </div>
          {destinations.length === 0 ? (
            <p className="rd-field-err" style={{ marginTop: 12 }}>
              Add a destination in the Address book before creating a payment.
            </p>
          ) : null}
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
    <div className="rd-dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="rd-import-title">
      <div
        className="rd-dialog"
        style={{
          maxWidth: step === 'preview' ? 'min(1040px, 96vw)' : 720,
          width: step === 'preview' ? 'min(1040px, 96vw)' : undefined,
        }}
      >
        <h2 id="rd-import-title" className="rd-dialog-title">
          Import CSV batch
        </h2>
        <p className="rd-dialog-body">
          Columns: <span className="rd-mono">counterparty, destination, amount, reference, due_date</span>.
        </p>

        {step === 'edit' ? (
          <>
            <div className="rd-form-grid" style={{ marginBottom: 16 }}>
              <label className="rd-field">
                <span className="rd-field-label">Batch name</span>
                <input
                  value={runName}
                  onChange={(e) => setRunName(e.target.value)}
                  placeholder="April contributor payouts"
                  className="rd-input"
                />
              </label>
              <label className="rd-field">
                <span className="rd-field-label">Source wallet (optional)</span>
                <select
                  value={sourceAddressId}
                  onChange={(e) => setSourceAddressId(e.target.value)}
                  className="rd-select"
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
              </label>
            </div>
            <label className="rd-field">
              <span className="rd-field-label">CSV</span>
              <textarea
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                rows={10}
                placeholder={`counterparty,destination,amount,reference,due_date\nAcme Corp,8cZ65A8ERdVsXq3YnEdMNimwG7DhGe1tPszysJwh43Zx,10.00,INV-1001,2026-05-01`}
                className="rd-textarea"
              />
            </label>
            <div className="rd-dialog-actions" style={{ marginTop: 20 }}>
              <button type="button" className="rd-btn rd-btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="rd-btn rd-btn-primary"
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
                Review
              </button>
            </div>
          </>
        ) : (
          <>
            <p style={{ fontSize: 13, color: 'var(--ax-text-secondary)', marginBottom: 12 }}>
              <strong style={{ color: 'var(--ax-text)' }}>{preview.rowCount}</strong> row
              {preview.rowCount === 1 ? '' : 's'} · showing first {preview.rows.length} ·{' '}
              {runName.trim() || '(unnamed batch)'}
            </p>
            <div
              className="rd-table-shell"
              style={{ maxHeight: 320, overflowY: 'auto', overflowX: 'auto' }}
            >
              <table className="rd-table" style={{ minWidth: 760 }}>
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
                          <span className="rd-mono" style={{ fontSize: 12 }}>
                            {row[ci] ?? ''}
                          </span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="rd-dialog-actions" style={{ marginTop: 20 }}>
              <button type="button" className="rd-btn rd-btn-secondary" onClick={() => setStep('edit')}>
                Back
              </button>
              <button
                type="button"
                className="rd-btn rd-btn-primary"
                disabled={importMutation.isPending}
                onClick={() => importMutation.mutate()}
                aria-busy={importMutation.isPending}
              >
                {importMutation.isPending ? 'Importing…' : 'Confirm import'}
              </button>
            </div>
          </>
        )}
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

  return (
    <div className="rd-dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="rd-upload-doc-title">
      <div className="rd-dialog upload-dialog" style={{ maxWidth: result ? 640 : 480 }}>
        <h2 id="rd-upload-doc-title" className="rd-dialog-title" style={{ marginBottom: 4 }}>
          Upload invoice
        </h2>

        {/* Pre-run: dropzone + Process button */}
        {!running && !result && !error ? (
          <>
            <p className="rd-dialog-body" style={{ margin: '0 0 20px' }}>
              Drop a PDF or image. The agent extracts, drafts, and routes proposal-ready rows.
            </p>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={onDrop}
              className="upload-dropzone"
              data-dragging={isDragging || undefined}
              data-has-file={file ? true : undefined}
              onClick={() => document.getElementById('rd-upload-doc-input')?.click()}
              role="button"
              tabIndex={0}
            >
              <input
                id="rd-upload-doc-input"
                type="file"
                accept=".pdf,application/pdf,image/*"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                style={{ display: 'none' }}
              />
              {file ? (
                <div className="upload-dropzone-file">
                  <span className="upload-dropzone-filename">{file.name}</span>
                  <span className="upload-dropzone-meta">{(file.size / 1024).toFixed(0)} KB</span>
                </div>
              ) : (
                <div className="upload-dropzone-empty">
                  <div className="upload-dropzone-primary">Drop a file or click to browse</div>
                  <div className="upload-dropzone-meta">PDF, PNG, JPG · up to 10 pages</div>
                </div>
              )}
            </div>

            <div className="rd-dialog-actions" style={{ marginTop: 20 }}>
              <button type="button" className="rd-btn rd-btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="rd-btn rd-btn-primary"
                disabled={!file}
                onClick={start}
              >
                Process invoice
              </button>
            </div>
          </>
        ) : null}

        {/* During run: simple spinner. The /invoices/upload endpoint is
            synchronous, no SSE — usually 5-15s with gpt-4.1-mini. */}
        {running ? (
          <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '32px 0' }}>
            <span
              aria-label="processing"
              style={{
                width: 28,
                height: 28,
                borderRadius: '50%',
                border: '3px solid var(--ax-accent)',
                borderTopColor: 'transparent',
                animation: 'rd-spin 0.8s linear infinite',
              }}
            />
            <div style={{ fontSize: 14, color: 'var(--ax-text-secondary)' }}>
              Reading the invoice, drafting payments, and asking the agent to route them…
            </div>
            {file ? (
              <div style={{ fontSize: 12, color: 'var(--ax-text-muted)' }}>
                {file.name} · {(file.size / 1024).toFixed(0)} KB
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Hard error during the call */}
        {error && !result ? (
          <div style={{ marginTop: 20 }}>
            <div className="rd-callout" data-tone="danger" style={{ marginBottom: 14 }}>
              <strong>Couldn't process the invoice.</strong>
              <div style={{ marginTop: 4, fontSize: 13 }}>{error}</div>
            </div>
            <div className="rd-dialog-actions">
              <button type="button" className="rd-btn rd-btn-secondary" onClick={onClose}>Close</button>
              <button type="button" className="rd-btn rd-btn-primary" onClick={() => { setError(null); start(); }}>Retry</button>
            </div>
          </div>
        ) : null}

        {/* Results: per-row outcomes from the automation array */}
        {result ? (
          <UploadResultPanel
            organizationId={organizationId}
            result={result}
            onClose={onClose}
            onUploadAnother={reset}
          />
        ) : null}
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
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 13, color: 'var(--ax-text-secondary)', marginBottom: 12 }}>
        {result.createdCount} payment order{result.createdCount === 1 ? '' : 's'} created
        {submittedCount > 0 ? ` · ${submittedCount} auto-submitted` : null}
        {executedCount > 0 ? ` · ${executedCount} auto-executed` : null}
        {reviewCount > 0 ? ` · ${reviewCount} needs review` : null}
        {result.skippedCount > 0 ? ` · ${result.skippedCount} skipped` : null}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
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

      <div className="rd-dialog-actions">
        <button type="button" className="rd-btn rd-btn-secondary" onClick={onUploadAnother}>
          Upload another
        </button>
        <button type="button" className="rd-btn rd-btn-primary" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
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

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: 12,
        alignItems: 'center',
        padding: '12px 14px',
        background: 'var(--ax-bg-elevated, #f6f6f6)',
        borderRadius: 10,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--ax-text)' }}>
          {counterpartyLabel} <span style={{ color: 'var(--ax-text-muted)', fontWeight: 400 }}>· {amountLabel}{reference ? ` · ${reference}` : ''}</span>
        </div>
        <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="rd-pill" data-tone={tone}>
            <span className="rd-pill-dot" aria-hidden />
            {statusLabel}
          </span>
          {automation?.reason && status !== 'proposal_submitted' ? (
            <span style={{ fontSize: 12, color: 'var(--ax-text-muted)' }}>{automation.reason}</span>
          ) : null}
          {retryError ? (
            <span style={{ fontSize: 12, color: 'var(--ax-danger)' }}>{retryError}</span>
          ) : null}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {showRetry ? (
          <button
            type="button"
            className="rd-btn rd-btn-secondary"
            onClick={retry}
            disabled={retrying}
            style={{ padding: '6px 12px', fontSize: 13 }}
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        ) : null}
        <Link
          to={`/organizations/${organizationId}/payments/${order.paymentOrderId}`}
          className="rd-btn rd-btn-secondary"
          style={{ padding: '6px 12px', fontSize: 13, textDecoration: 'none' }}
        >
          {status === 'needs_review' ? 'Review' : 'Open'}
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
        background: 'var(--ax-bg-elevated, #f6f6f6)',
        borderRadius: 10,
        opacity: 0.85,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--ax-text)' }}>
        {row.counterparty} <span style={{ color: 'var(--ax-text-muted)', fontWeight: 400 }}>· {row.amount} {row.currency}{row.reference ? ` · ${row.reference}` : ''}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="rd-pill" data-tone="danger">
          <span className="rd-pill-dot" aria-hidden />
          Skipped
        </span>
        <span style={{ fontSize: 12, color: 'var(--ax-text-muted)' }}>{row.message}</span>
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
