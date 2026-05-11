import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type {
  AuthenticatedSession,
  CounterpartyWallet,
  DocumentImportProgressEvent,
  PaymentOrder,
  PaymentRun,
  TreasuryWallet,
} from '../types';
import {
  assetSymbol,
  formatRawUsdcCompact,
  formatRelativeTime,
  shortenAddress,
  walletLabel,
} from '../domain';
import { parseCsvPreview } from '../csv-parse';
import {
  displayPaymentStatus,
  displayRunStatus,
  hasRealWalletLabel,
  statusToneForPayment,
  toneToPill,
} from '../status-labels';
import { useToast } from '../ui/Toast';
import { EmptyIcon, RdEmptyState, RdFilterBar } from '../ui-primitives';

type UnifiedRow =
  | {
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
      origin: 'single';
      createdAt: string;
      to: string;
    }
  | {
      kind: 'run';
      id: string;
      name: string;
      counterpartyName: string | null;
      destination: string;
      destinationLabel: string | null;
      source: string;
      amountLabel: string;
      state: string;
      tone: 'success' | 'warning' | 'danger' | 'neutral';
      origin: 'run';
      originLabel: string;
      createdAt: string;
      to: string;
    };

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

export function PaymentsPage({ session }: { session: AuthenticatedSession }) {
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
  const paymentRunsQuery = useQuery({
    queryKey: ['payment-runs', organizationId] as const,
    queryFn: () => api.listPaymentRuns(organizationId!),
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
  const runs = paymentRunsQuery.data?.items ?? [];
  const addresses = addressesQuery.data?.items ?? [];
  const destinations = destinationsQuery.data?.items ?? [];

  const standaloneOrders = orders.filter((o) => !o.paymentRunId);

  const rows = useMemo<UnifiedRow[]>(() => {
    const list: UnifiedRow[] = [
      ...standaloneOrders.map<UnifiedRow>((o) => ({
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
        origin: 'single',
        createdAt: o.createdAt,
        to: `/organizations/${organizationId}/payments/${o.paymentOrderId}`,
      })),
      ...runs.map<UnifiedRow>((r) => ({
        kind: 'run',
        id: r.paymentRunId,
        name: r.runName,
        counterpartyName: null,
        destination: `${r.totals.orderCount} destination${r.totals.orderCount === 1 ? '' : 's'}`,
        destinationLabel: null,
        source: sourceLabel(r.sourceTreasuryWallet),
        amountLabel: `${formatRawUsdcCompact(r.totals.totalAmountRaw)} USDC`,
        state: displayRunStatus(r.derivedState),
        tone: statusToneForPayment(r.derivedState),
        origin: 'run',
        originLabel: `Batch · ${r.totals.orderCount} rows`,
        createdAt: r.createdAt,
        to: `/organizations/${organizationId}/runs/${r.paymentRunId}`,
      })),
    ];
    return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [standaloneOrders, runs, organizationId]);

  const filteredRows = useMemo(() => {
    let out = rows;
    if (filter === 'active') {
      out = out.filter((r) => r.tone === 'warning' || r.tone === 'neutral');
    } else if (filter === 'settled') {
      out = out.filter((r) => r.tone === 'success');
    } else if (filter === 'needs_review') {
      out = out.filter((r) => r.tone === 'danger');
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
  const awaiting = orders.filter((o) => ['draft', 'pending_approval'].includes(o.derivedState)).length;
  const readyToSign = orders.filter((o) =>
    ['approved', 'ready_for_execution'].includes(o.derivedState),
  ).length;
  const settled = orders.filter((o) => ['settled', 'closed'].includes(o.derivedState)).length;
  const needsReview = orders.filter((o) => ['exception', 'partially_settled'].includes(o.derivedState)).length;

  const isLoading = paymentOrdersQuery.isLoading || paymentRunsQuery.isLoading;

  return (
    <main className="page-frame">
      <header className="page-header">
        <div>
          <p className="eyebrow">Payments</p>
          <h1>All payments</h1>
          <p>
            Every single payment and batch payout in this organization. Create one, import many, and follow
            each from intent to proof.
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="button button-secondary" onClick={() => setUploadDocOpen(true)}>
            Upload invoice
          </button>
          <button type="button" className="button button-secondary" onClick={() => setImportOpen(true)}>
            Import CSV
          </button>
          <button type="button" className="button button-primary" onClick={() => setCreateOpen(true)}>
            New payment
            <span className="rd-btn-arrow" aria-hidden>→</span>
          </button>
        </div>
      </header>

        <div className="rd-metrics">
          <div className="rd-metric">
            <span className="rd-metric-label">Awaiting approval</span>
            <span className="rd-metric-value" data-tone={awaiting > 0 ? 'warning' : undefined}>
              {awaiting}
            </span>
          </div>
          <div className="rd-metric">
            <span className="rd-metric-label">Ready to sign</span>
            <span className="rd-metric-value" data-tone={readyToSign > 0 ? 'warning' : undefined}>
              {readyToSign}
            </span>
          </div>
          <div className="rd-metric">
            <span className="rd-metric-label">Settled</span>
            <span className="rd-metric-value" data-tone="success">
              {settled}
            </span>
          </div>
          <div className="rd-metric">
            <span className="rd-metric-label">Needs review</span>
            <span className="rd-metric-value" data-tone={needsReview > 0 ? 'danger' : undefined}>
              {needsReview}
            </span>
          </div>
        </div>

        <RdFilterBar
          search={{
            value: search,
            onChange: setSearch,
            placeholder: 'Search destinations',
            ariaLabel: 'Search payments',
          }}
          tabs={(['all', 'active', 'settled', 'needs_review'] as const).map((key) => ({
            id: key,
            label: key === 'needs_review' ? 'Needs review' : key.charAt(0).toUpperCase() + key.slice(1),
            active: filter === key,
            onClick: () => setFilter(key),
          }))}
          rightMeta={`${filteredRows.length} of ${rows.length}`}
        />

        <div className="rd-table-shell">
          <table className="rd-table">
            <thead>
              <tr>
                <th style={{ width: '20%' }}>Recipient / Run</th>
                <th style={{ width: '14%' }}>Counterparty</th>
                <th style={{ width: '14%' }}>Destination</th>
                <th style={{ width: '12%' }}>Source</th>
                <th className="rd-num" style={{ width: '12%' }}>
                  Amount
                </th>
                <th style={{ width: '10%' }}>Origin</th>
                <th style={{ width: '12%' }}>Status</th>
                <th aria-label="Actions" style={{ width: '6%' }} />
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={8} className="rd-empty-cell">
                    <div className="rd-skeleton rd-skeleton-block" style={{ height: 80 }} />
                  </td>
                </tr>
              ) : filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ padding: 0 }}>
                    {rows.length === 0 ? (
                      <RdEmptyState
                        icon={<EmptyIcon kind="receipt" />}
                        title="No payments yet"
                        description="Drop a vendor invoice and we'll extract every payment in it, or upload a CSV batch."
                        primary={{ label: 'Upload invoice', onClick: () => setUploadDocOpen(true) }}
                        secondary={{ label: 'New payment', onClick: () => setCreateOpen(true) }}
                      />
                    ) : (
                      <RdEmptyState
                        title="Nothing matches that filter"
                        description="Clear the search or change the filter to see more."
                      />
                    )}
                  </td>
                </tr>
              ) : (
                filteredRows.map((row) => (
                  <tr
                    key={`${row.kind}:${row.id}`}
                    onClick={() => navigate(row.to)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td>
                      <div className="rd-recipient-main">
                        <span className="rd-recipient-name">{row.name}</span>
                        <span className="rd-recipient-ref">{formatRelativeTime(row.createdAt)}</span>
                      </div>
                    </td>
                    <td>
                      {row.counterpartyName ? (
                        <span className="rd-origin" data-kind="run">
                          {row.counterpartyName}
                        </span>
                      ) : (
                        <span className="rd-empty-mark" data-mono="true">—</span>
                      )}
                    </td>
                    <td>
                      {row.kind === 'single' ? (
                        row.destinationLabel ? (
                          <span style={{ color: 'var(--ax-text)', fontWeight: 500 }}>
                            {row.destinationLabel}
                          </span>
                        ) : (
                          <span className="rd-addr">{shortenAddress(row.destination, 4, 4)}</span>
                        )
                      ) : (
                        <span style={{ color: 'var(--ax-text-muted)', fontSize: 12 }}>{row.destination}</span>
                      )}
                    </td>
                    <td>
                      {row.source === '—' ? (
                        <span className="rd-empty-mark">—</span>
                      ) : (
                        <span className="rd-source-label">{row.source}</span>
                      )}
                    </td>
                    <td className="rd-num">{row.amountLabel}</td>
                    <td>
                      <span className="rd-origin" data-kind={row.kind === 'run' ? 'run' : undefined}>
                        {row.kind === 'run' ? row.originLabel : 'Single'}
                      </span>
                    </td>
                    <td>
                      <span className="rd-pill" data-tone={toneToPill(row.tone)}>
                        <span className="rd-pill-dot" aria-hidden />
                        {row.state}
                      </span>
                    </td>
                    <td>
                      <span className="rd-btn-arrow" style={{ color: 'var(--ax-text-muted)' }} aria-hidden>
                        →
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

      {createOpen ? (
        <CreatePaymentDialog
          organizationId={organizationId}
          destinations={destinations}
          addresses={addresses}
          onClose={() => setCreateOpen(false)}
          onSuccess={async () => {
            setCreateOpen(false);
            success('Payment created and submitted for approval.');
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
            success(`Imported "${name}" with ${rows} rows. Open the batch to review destinations and submit.`);
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
          onSuccess={async (name, rows, skipped) => {
            setUploadDocOpen(false);
            const skippedNote = skipped.length
              ? ` ${skipped.length} row(s) skipped — no destination match for ${skipped
                  .slice(0, 2)
                  .map((s) => `"${s.counterparty}"`)
                  .join(', ')}${skipped.length > 2 ? ` and ${skipped.length - 2} more` : ''}.`
              : '';
            success(`Imported "${name}" with ${rows} row(s).${skippedNote}`);
            await queryClient.invalidateQueries({ queryKey: ['payment-runs', organizationId] });
            await queryClient.invalidateQueries({ queryKey: ['payment-orders', organizationId] });
          }}
          onError={(message) => toastError(message)}
        />
      ) : null}
    </main>
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
      return api.createPaymentRequest(organizationId, {
        counterpartyWalletId,
        amountRaw: usdcToRaw(amount),
        reason,
        externalReference: String(form.get('externalReference') ?? '') || undefined,
        sourceTreasuryWalletId: String(form.get('sourceTreasuryWalletId') ?? '') || undefined,
        createOrderNow: true,
        submitOrderNow: true,
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
          One payment, one destination. Gets submitted for approval automatically.
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
    mutationFn: async () => {
      const csv = csvText.trim();
      if (!csv) throw new Error('Paste at least one CSV row.');
      const result = await api.importPaymentRunCsv(organizationId, {
        csv,
        runName: runName.trim() || undefined,
        sourceTreasuryWalletId: sourceAddressId || undefined,
      });
      if (result.importResult.imported === 0) {
        const existingName = result.paymentRun?.runName;
        if (existingName) {
          throw new Error(
            `This CSV was already imported as "${existingName}". Nothing to do — open that batch instead of re-importing.`,
          );
        }
        const failedDetail = result.importResult.items
          .filter((item) => item.status === 'failed')
          .slice(0, 3)
          .map((item) => `row ${item.rowNumber}: ${item.error ?? 'invalid row'}`)
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
      onSuccess(result.paymentRun.runName, result.importResult.imported);
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

// The five user-visible steps. The backend emits six stages (the 6th is
// `done`, which just finalizes the last step). We collapse `received`
// and `rendering` into a single "Reading file" step because they
// usually fire back-to-back and the distinction isn't meaningful.
const UPLOAD_STEPS: { key: UploadStepKey; label: string }[] = [
  { key: 'reading', label: 'Reading file' },
  { key: 'extracting', label: 'Extracting invoices with AI' },
  { key: 'matching', label: 'Matching to your address book' },
  { key: 'creating', label: 'Creating draft batch' },
];
type UploadStepKey = 'reading' | 'extracting' | 'matching' | 'creating';
type StepStatus = 'pending' | 'active' | 'done';

function stageToStepIndex(stage: DocumentImportProgressEvent['stage']): number {
  switch (stage) {
    case 'received':
    case 'rendering':
      return 0;
    case 'extracting':
      return 1;
    case 'matching':
      return 2;
    case 'creating':
      return 3;
    case 'done':
      return UPLOAD_STEPS.length;
  }
}

function UploadDocumentDialog(props: {
  organizationId: string;
  onClose: () => void;
  onSuccess: (
    runName: string,
    importedRows: number,
    skippedRows: { counterparty: string; reason: string }[],
  ) => void;
  onError: (message: string) => void;
}) {
  const { organizationId, onClose, onSuccess, onError } = props;
  const [file, setFile] = useState<File | null>(null);
  const [runName, setRunName] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [progressEvents, setProgressEvents] = useState<DocumentImportProgressEvent[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // Latest event per stage — used to render sub-text on each step row.
  const latestByStage = useMemo(() => {
    const map = new Map<DocumentImportProgressEvent['stage'], DocumentImportProgressEvent>();
    for (const e of progressEvents) map.set(e.stage, e);
    return map;
  }, [progressEvents]);

  const currentStepIndex = useMemo(() => {
    if (progressEvents.length === 0) return -1;
    const last = progressEvents[progressEvents.length - 1]!;
    return stageToStepIndex(last.stage);
  }, [progressEvents]);

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
    setStreamError(null);
    setProgressEvents([]);
    try {
      const dataBase64 = await fileToBase64(file);
      const result = await api.importPaymentRunFromDocumentStream(
        organizationId,
        {
          filename: file.name,
          mimeType: file.type || guessMimeFromFilename(file.name),
          dataBase64,
          runName: runName.trim() || undefined,
        },
        {
          onStage: (event) => setProgressEvents((prev) => [...prev, event]),
        },
      );
      onSuccess(
        result.paymentRun.runName,
        result.importResult.imported,
        result.skippedRows.map((s) => ({ counterparty: s.counterparty, reason: s.reason })),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Document import failed.';
      setStreamError(message);
      onError(message);
    } finally {
      setRunning(false);
    }
  };

  const reset = () => {
    setStreamError(null);
    setProgressEvents([]);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const dropped = e.dataTransfer?.files?.[0];
    if (dropped) setFile(dropped);
  };

  return (
    <div className="rd-dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="rd-upload-doc-title">
      <div className="rd-dialog" style={{ maxWidth: 560 }}>
        <h2 id="rd-upload-doc-title" className="rd-dialog-title">
          Upload invoice
        </h2>
        <p className="rd-dialog-body">
          Drop a PDF or image. We'll extract every payment in it. Vendors already in your address book use
          their stored wallet. New vendors with a Solana wallet printed on the invoice land in your address
          book as <strong>unreviewed</strong> — approve them on the batch page before submitting.
        </p>

        {!running && progressEvents.length === 0 && !streamError ? (
          <>
            <label className="rd-field" style={{ marginBottom: 16 }}>
              <span className="rd-field-label">Batch name</span>
              <input
                value={runName}
                onChange={(e) => setRunName(e.target.value)}
                placeholder="April vendor invoices"
                className="rd-input"
              />
            </label>

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={onDrop}
              style={{
                border: `1px dashed ${isDragging ? 'var(--ax-accent)' : 'var(--ax-border-strong)'}`,
                background: isDragging ? 'var(--ax-surface-2)' : 'var(--ax-surface-2)',
                borderRadius: 8,
                padding: 24,
                textAlign: 'center',
                cursor: 'pointer',
                transition: 'border-color 120ms ease',
              }}
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
                <div>
                  <div style={{ fontSize: 14, color: 'var(--ax-text)' }}>
                    <span className="rd-mono">{file.name}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--ax-text-muted)', marginTop: 4 }}>
                    {(file.size / 1024).toFixed(0)} KB · click to choose a different file
                  </div>
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 14, color: 'var(--ax-text)' }}>
                    Drop a file here or click to browse
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--ax-text-muted)', marginTop: 4 }}>
                    PDF, PNG, JPG, WebP — up to 10 pages
                  </div>
                </div>
              )}
            </div>

            <div className="rd-dialog-actions" style={{ marginTop: 24 }}>
              <button type="button" className="rd-btn rd-btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="rd-btn rd-btn-primary"
                disabled={!file}
                onClick={start}
              >
                Extract & create batch
              </button>
            </div>
          </>
        ) : null}

        {running || progressEvents.length > 0 || streamError ? (
          <div style={{ marginTop: 8 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {UPLOAD_STEPS.map((step, idx) => {
                const status: StepStatus =
                  streamError && currentStepIndex === idx
                    ? 'active'
                    : currentStepIndex > idx
                      ? 'done'
                      : currentStepIndex === idx
                        ? 'active'
                        : 'pending';
                return (
                  <UploadStepRow
                    key={step.key}
                    label={step.label}
                    status={status}
                    detail={describeStep(step.key, latestByStage)}
                    error={streamError && currentStepIndex === idx ? streamError : null}
                  />
                );
              })}
            </div>

            {streamError ? (
              <div className="rd-dialog-actions" style={{ marginTop: 24 }}>
                <button type="button" className="rd-btn rd-btn-secondary" onClick={onClose}>
                  Close
                </button>
                <button type="button" className="rd-btn rd-btn-primary" onClick={() => { reset(); start(); }}>
                  Retry
                </button>
              </div>
            ) : !running && currentStepIndex >= UPLOAD_STEPS.length ? (
              <p className="rd-hint" style={{ margin: '16px 0 0' }}>
                Done — opening batch…
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function UploadStepRow(props: {
  label: string;
  status: StepStatus;
  detail: string | null;
  error: string | null;
}) {
  const { label, status, detail, error } = props;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
      <StepIndicator status={status} hasError={Boolean(error)} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            color: status === 'pending' ? 'var(--ax-text-muted)' : 'var(--ax-text)',
            fontWeight: status === 'active' ? 500 : 400,
          }}
        >
          {label}
        </div>
        {error ? (
          <div style={{ fontSize: 12, color: 'var(--ax-danger)', marginTop: 2 }}>{error}</div>
        ) : detail ? (
          <div style={{ fontSize: 12, color: 'var(--ax-text-muted)', marginTop: 2 }}>{detail}</div>
        ) : null}
      </div>
    </div>
  );
}

function StepIndicator(props: { status: StepStatus; hasError: boolean }) {
  const { status, hasError } = props;
  const size = 18;
  const baseStyle: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 11,
    flexShrink: 0,
    marginTop: 1,
  };
  if (hasError) {
    return (
      <span style={{ ...baseStyle, background: 'var(--ax-danger)', color: '#fff' }} aria-label="failed">
        !
      </span>
    );
  }
  if (status === 'done') {
    return (
      <span style={{ ...baseStyle, background: 'var(--ax-accent)', color: '#fff' }} aria-label="done">
        ✓
      </span>
    );
  }
  if (status === 'active') {
    return (
      <span
        style={{
          ...baseStyle,
          border: '2px solid var(--ax-accent)',
          borderTopColor: 'transparent',
          animation: 'rd-spin 0.8s linear infinite',
        }}
        aria-label="in progress"
      />
    );
  }
  return (
    <span
      style={{ ...baseStyle, border: '1px solid var(--ax-border-strong)', background: 'transparent' }}
      aria-label="pending"
    />
  );
}

function describeStep(
  key: UploadStepKey,
  latest: Map<DocumentImportProgressEvent['stage'], DocumentImportProgressEvent>,
): string | null {
  if (key === 'reading') {
    const received = latest.get('received');
    if (received && received.stage === 'received') {
      return `${(received.bytes / 1024).toFixed(0)} KB`;
    }
    return null;
  }
  if (key === 'extracting') {
    const ev = latest.get('extracting');
    if (ev && ev.stage === 'extracting') {
      return `${ev.pageCount} page${ev.pageCount === 1 ? '' : 's'} — usually 10–30s`;
    }
    return null;
  }
  if (key === 'matching') {
    const ev = latest.get('matching');
    if (ev && ev.stage === 'matching') {
      return `${ev.extractedCount} row${ev.extractedCount === 1 ? '' : 's'} extracted in ${(ev.modelLatencyMs / 1000).toFixed(1)}s`;
    }
    return null;
  }
  if (key === 'creating') {
    const ev = latest.get('creating');
    if (ev && ev.stage === 'creating') {
      const skip = ev.skippedCount > 0 ? `, ${ev.skippedCount} skipped` : '';
      return `${ev.matchedCount} matched${skip}`;
    }
    return null;
  }
  return null;
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
