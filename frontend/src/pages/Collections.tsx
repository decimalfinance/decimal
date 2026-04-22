import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type {
  AuthenticatedSession,
  CollectionRequest,
  CollectionRunSummary,
  Counterparty,
  TreasuryWallet,
} from '../types';
import { formatRawUsdcCompact, formatRelativeTime, shortenAddress } from '../domain';
import { parseCsvPreview } from '../csv-parse';
import {
  collectionRunProgressLine,
  displayCollectionStatus,
  statusToneForCollection,
} from '../status-labels';
import { useToast } from '../ui/Toast';

type UnifiedRow =
  | {
      kind: 'single';
      id: string;
      name: string;
      receiver: string;
      payer: string;
      amountLabel: string;
      reference: string;
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
      receiver: string;
      payer: string;
      amountLabel: string;
      reference: string;
      state: string;
      tone: 'success' | 'warning' | 'danger' | 'neutral';
      origin: 'run';
      originLabel: string;
      createdAt: string;
      to: string;
    };

function assetSymbol(asset: string | undefined): string {
  return (asset ?? 'usdc').toUpperCase();
}

function walletLabel(wallet: TreasuryWallet): string {
  if (wallet.displayName && wallet.displayName.trim().length) {
    return `${wallet.displayName} · ${shortenAddress(wallet.address, 4, 4)}`;
  }
  return shortenAddress(wallet.address, 4, 4);
}

function receiverLabel(wallet: TreasuryWallet | null): string {
  if (!wallet) return '—';
  if (wallet.displayName && wallet.displayName.trim().length) return wallet.displayName;
  return shortenAddress(wallet.address, 4, 4);
}

function payerLabel(collection: CollectionRequest): string {
  if (collection.counterparty?.displayName) return collection.counterparty.displayName;
  if (collection.payerWalletAddress) return shortenAddress(collection.payerWalletAddress, 4, 4);
  return 'Any payer';
}

function toneToPill(
  tone: 'success' | 'warning' | 'danger' | 'neutral',
): 'success' | 'warning' | 'danger' | 'info' {
  return tone === 'success' ? 'success' : tone === 'danger' ? 'danger' : tone === 'warning' ? 'warning' : 'info';
}

function usdcToRaw(value: string): string {
  const [whole, frac = ''] = value.replace(/[^0-9.]/g, '').split('.');
  const fracPadded = (frac + '000000').slice(0, 6);
  return (BigInt(whole || '0') * 1_000_000n + BigInt(fracPadded || '0')).toString();
}

export function CollectionsPage({ session: _session }: { session: AuthenticatedSession }) {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();

  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'open' | 'collected' | 'needs_review'>('all');

  const collectionsQuery = useQuery({
    queryKey: ['collections', workspaceId] as const,
    queryFn: () => api.listCollections(workspaceId!),
    enabled: Boolean(workspaceId),
    refetchInterval: 10_000,
  });
  const collectionRunsQuery = useQuery({
    queryKey: ['collection-runs', workspaceId] as const,
    queryFn: () => api.listCollectionRuns(workspaceId!),
    enabled: Boolean(workspaceId),
    refetchInterval: 10_000,
  });
  const walletsQuery = useQuery({
    queryKey: ['treasury-wallets', workspaceId] as const,
    queryFn: () => api.listTreasuryWallets(workspaceId!),
    enabled: Boolean(workspaceId),
  });
  const counterpartiesQuery = useQuery({
    queryKey: ['counterparties', workspaceId] as const,
    queryFn: () => api.listCounterparties(workspaceId!),
    enabled: Boolean(workspaceId),
  });

  if (!workspaceId) {
    return (
      <main className="page-frame">
        <div className="rd-state">
          <h2 className="rd-state-title">Workspace unavailable</h2>
          <p className="rd-state-body">Pick a workspace from the sidebar.</p>
        </div>
      </main>
    );
  }

  const collections = collectionsQuery.data?.items ?? [];
  const runs = collectionRunsQuery.data?.items ?? [];
  const wallets = walletsQuery.data?.items ?? [];
  const counterparties = counterpartiesQuery.data?.items ?? [];

  const standalone = collections.filter((c) => !c.collectionRunId);

  const rows = useMemo<UnifiedRow[]>(() => {
    const list: UnifiedRow[] = [
      ...standalone.map<UnifiedRow>((c) => ({
        kind: 'single',
        id: c.collectionRequestId,
        name: payerLabel(c),
        receiver: receiverLabel(c.receivingTreasuryWallet),
        payer: c.payerWalletAddress ?? '',
        amountLabel: `${formatRawUsdcCompact(c.amountRaw)} ${assetSymbol(c.asset)}`,
        reference: c.externalReference ?? '—',
        state: displayCollectionStatus(c.derivedState),
        tone: statusToneForCollection(c.derivedState),
        origin: 'single',
        createdAt: c.createdAt,
        to: `/workspaces/${workspaceId}/collections/${c.collectionRequestId}`,
      })),
      ...runs.map<UnifiedRow>((r) => ({
        kind: 'run',
        id: r.collectionRunId,
        name: r.runName,
        receiver: receiverLabel(r.receivingTreasuryWallet),
        payer: `${r.summary.total} payer${r.summary.total === 1 ? '' : 's'}`,
        amountLabel: `${formatRawUsdcCompact(r.summary.totalAmountRaw)} USDC`,
        reference: '—',
        state: displayCollectionStatus(r.derivedState),
        tone: statusToneForCollection(r.derivedState),
        origin: 'run',
        originLabel: `Batch · ${r.summary.total} rows`,
        createdAt: r.createdAt,
        to: `/workspaces/${workspaceId}/collection-runs/${r.collectionRunId}`,
      })),
    ];
    return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [standalone, runs, workspaceId]);

  const filteredRows = useMemo(() => {
    let out = rows;
    if (filter === 'open') {
      out = out.filter((r) => r.tone === 'warning' || r.tone === 'neutral');
    } else if (filter === 'collected') {
      out = out.filter((r) => r.tone === 'success');
    } else if (filter === 'needs_review') {
      out = out.filter((r) => r.tone === 'danger');
    }
    const q = search.trim().toLowerCase();
    if (q) {
      out = out.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.reference.toLowerCase().includes(q) ||
          r.payer.toLowerCase().includes(q),
      );
    }
    return out;
  }, [rows, filter, search]);

  // Metrics over actual collection requests (not runs — runs group)
  const awaiting = collections.filter((c) => c.derivedState === 'open').length;
  const partial = collections.filter((c) => c.derivedState === 'partially_collected').length;
  const collected = collections.filter((c) =>
    ['collected', 'closed'].includes(c.derivedState),
  ).length;
  const needsReview = collections.filter((c) => c.derivedState === 'exception').length;

  const isLoading = collectionsQuery.isLoading || collectionRunsQuery.isLoading;

  return (
    <main className="page-frame">
      <header className="page-header">
        <div>
          <p className="eyebrow">Collections</p>
          <h1>All collections</h1>
          <p>
            Expected inbound payments. Create one, import many, and watch each clear when the
            transfer lands on your treasury wallet.
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="button button-secondary" onClick={() => setImportOpen(true)}>
            Import CSV
          </button>
          <button type="button" className="button button-primary" onClick={() => setCreateOpen(true)}>
            New collection
            <span className="rd-btn-arrow" aria-hidden>→</span>
          </button>
        </div>
      </header>

      <div className="rd-metrics">
        <div className="rd-metric">
          <span className="rd-metric-label">Awaiting</span>
          <span className="rd-metric-value" data-tone={awaiting > 0 ? 'warning' : undefined}>
            {awaiting}
          </span>
        </div>
        <div className="rd-metric">
          <span className="rd-metric-label">Partial</span>
          <span className="rd-metric-value" data-tone={partial > 0 ? 'warning' : undefined}>
            {partial}
          </span>
        </div>
        <div className="rd-metric">
          <span className="rd-metric-label">Collected</span>
          <span className="rd-metric-value" data-tone="success">
            {collected}
          </span>
        </div>
        <div className="rd-metric">
          <span className="rd-metric-label">Needs review</span>
          <span className="rd-metric-value" data-tone={needsReview > 0 ? 'danger' : undefined}>
            {needsReview}
          </span>
        </div>
      </div>

      <div className="rd-filter-bar">
        <div className="rd-search">
          <svg className="rd-search-icon" viewBox="0 0 16 16" fill="none" aria-hidden>
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
            <path d="m14 14-3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            placeholder="Search payer or reference"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search collections"
          />
        </div>
        <div className="rd-tabs" role="tablist" aria-label="Filter">
          {(['all', 'open', 'collected', 'needs_review'] as const).map((key) => (
            <button
              key={key}
              role="tab"
              aria-selected={filter === key}
              className="rd-tab"
              onClick={() => setFilter(key)}
              type="button"
            >
              {key === 'needs_review' ? 'Needs review' : key.charAt(0).toUpperCase() + key.slice(1)}
            </button>
          ))}
        </div>
        <div className="rd-toolbar-right">
          <span className="rd-section-meta">
            {filteredRows.length} of {rows.length}
          </span>
        </div>
      </div>

      <div className="rd-table-shell">
        <table className="rd-table">
          <thead>
            <tr>
              <th style={{ width: '22%' }}>Payer / Run</th>
              <th style={{ width: '18%' }}>Receiver</th>
              <th style={{ width: '14%' }}>Reference</th>
              <th className="rd-num" style={{ width: '14%' }}>
                Amount
              </th>
              <th style={{ width: '12%' }}>Origin</th>
              <th style={{ width: '14%' }}>Status</th>
              <th aria-label="Actions" style={{ width: '6%' }} />
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={7} className="rd-empty-cell">
                  <div className="rd-skeleton rd-skeleton-block" style={{ height: 80 }} />
                </td>
              </tr>
            ) : filteredRows.length === 0 ? (
              <tr>
                <td colSpan={7} className="rd-empty-cell">
                  <strong>
                    {rows.length === 0 ? 'No collections yet' : 'Nothing matches that filter'}
                  </strong>
                  <p style={{ margin: 0 }}>
                    {rows.length === 0
                      ? 'Create a single expected payment or import a CSV batch to get started.'
                      : 'Clear the search or change the filter to see more.'}
                  </p>
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
                    <span style={{ fontSize: 13, color: 'var(--ax-text-secondary)' }}>{row.receiver}</span>
                  </td>
                  <td>
                    <span className="rd-mono" style={{ fontSize: 12 }}>
                      {row.reference}
                    </span>
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

      {runs.length > 0 ? (
        <section style={{ marginTop: 28 }}>
          <header style={{ marginBottom: 12 }}>
            <h2 style={{ fontSize: 14, fontWeight: 500, margin: 0, color: 'var(--ax-text-secondary)' }}>
              Batches
            </h2>
          </header>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 8 }}>
            {runs.map((r) => (
              <li
                key={r.collectionRunId}
                onClick={() =>
                  navigate(`/workspaces/${workspaceId}/collection-runs/${r.collectionRunId}`)
                }
                style={{
                  cursor: 'pointer',
                  border: '1px solid var(--ax-border)',
                  borderRadius: 8,
                  padding: '12px 14px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  background: 'var(--ax-surface-0)',
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, color: 'var(--ax-text)', fontWeight: 500 }}>
                    {r.runName}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--ax-text-muted)' }}>
                    {collectionRunProgressLine(r)}
                  </div>
                </div>
                <span className="rd-pill" data-tone={toneToPill(statusToneForCollection(r.derivedState))}>
                  <span className="rd-pill-dot" aria-hidden />
                  {displayCollectionStatus(r.derivedState)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {createOpen ? (
        <CreateCollectionDialog
          workspaceId={workspaceId}
          wallets={wallets}
          counterparties={counterparties}
          onClose={() => setCreateOpen(false)}
          onSuccess={async () => {
            setCreateOpen(false);
            success('Collection created. Waiting for payer.');
            await queryClient.invalidateQueries({ queryKey: ['collections', workspaceId] });
          }}
          onError={(message) => toastError(message)}
        />
      ) : null}

      {importOpen ? (
        <ImportCollectionCsvDialog
          workspaceId={workspaceId}
          wallets={wallets}
          onClose={() => setImportOpen(false)}
          onSuccess={async (runName, rowCount) => {
            setImportOpen(false);
            success(`Imported "${runName}" with ${rowCount} rows.`);
            await queryClient.invalidateQueries({ queryKey: ['collection-runs', workspaceId] });
            await queryClient.invalidateQueries({ queryKey: ['collections', workspaceId] });
          }}
          onError={(message) => toastError(message)}
        />
      ) : null}
    </main>
  );
}

function CreateCollectionDialog(props: {
  workspaceId: string;
  wallets: TreasuryWallet[];
  counterparties: Counterparty[];
  onClose: () => void;
  onSuccess: () => void;
  onError: (message: string) => void;
}) {
  const { workspaceId, wallets, counterparties, onClose, onSuccess, onError } = props;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const mutation = useMutation({
    mutationFn: async (form: FormData) => {
      const receivingTreasuryWalletId = String(form.get('receivingTreasuryWalletId') ?? '');
      const amount = String(form.get('amount') ?? '').trim();
      const reason = String(form.get('reason') ?? '').trim();
      if (!receivingTreasuryWalletId || !amount || !reason) {
        throw new Error('Receiver, amount, and reason are required.');
      }
      return api.createCollection(workspaceId, {
        receivingTreasuryWalletId,
        counterpartyId: String(form.get('counterpartyId') ?? '') || undefined,
        payerWalletAddress: String(form.get('payerWalletAddress') ?? '').trim() || undefined,
        amountRaw: usdcToRaw(amount),
        reason,
        externalReference: String(form.get('externalReference') ?? '').trim() || undefined,
      });
    },
    onSuccess: () => onSuccess(),
    onError: (err) => onError(err instanceof Error ? err.message : 'Could not create collection.'),
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
          New collection
        </h2>
        <p className="rd-dialog-body">
          Record an expected inbound payment. Matches automatically when the transfer lands on the
          selected receiver wallet.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate(new FormData(e.currentTarget));
          }}
        >
          <div className="rd-form-grid">
            <label className="rd-field" style={{ gridColumn: '1 / -1' }}>
              <span className="rd-field-label">Receiver wallet</span>
              <select
                name="receivingTreasuryWalletId"
                required
                className="rd-select"
                defaultValue=""
              >
                <option value="" disabled>
                  Select receiver
                </option>
                {wallets
                  .filter((w) => w.isActive)
                  .map((w) => (
                    <option key={w.treasuryWalletId} value={w.treasuryWalletId}>
                      {walletLabel(w)}
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
            <label className="rd-field">
              <span className="rd-field-label">Counterparty (optional)</span>
              <select name="counterpartyId" className="rd-select" defaultValue="">
                <option value="">Any payer</option>
                {counterparties.map((c) => (
                  <option key={c.counterpartyId} value={c.counterpartyId}>
                    {c.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="rd-field">
              <span className="rd-field-label">Payer wallet (optional)</span>
              <input
                name="payerWalletAddress"
                placeholder="Solana address"
                className="rd-input"
                autoComplete="off"
              />
            </label>
            <label className="rd-field" style={{ gridColumn: '1 / -1' }}>
              <span className="rd-field-label">Reason</span>
              <input
                name="reason"
                required
                placeholder="April invoice from Acme"
                className="rd-input"
                autoComplete="off"
              />
            </label>
          </div>
          <div className="rd-dialog-actions" style={{ marginTop: 24 }}>
            <button type="button" className="rd-btn rd-btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="rd-btn rd-btn-primary"
              disabled={mutation.isPending || wallets.length === 0}
              aria-busy={mutation.isPending}
            >
              {mutation.isPending ? 'Creating…' : 'Create collection'}
            </button>
          </div>
          {wallets.length === 0 ? (
            <p className="rd-field-err" style={{ marginTop: 12 }}>
              Add a treasury wallet before creating a collection.
            </p>
          ) : null}
        </form>
      </div>
    </div>
  );
}

function ImportCollectionCsvDialog(props: {
  workspaceId: string;
  wallets: TreasuryWallet[];
  onClose: () => void;
  onSuccess: (runName: string, rowCount: number) => void;
  onError: (message: string) => void;
}) {
  const { workspaceId, wallets, onClose, onSuccess, onError } = props;
  const [step, setStep] = useState<'edit' | 'preview'>('edit');
  const [csvText, setCsvText] = useState('');
  const [runName, setRunName] = useState('');
  const [receivingWalletId, setReceivingWalletId] = useState('');

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
      const result = await api.importCollectionRunCsv(workspaceId, {
        csv,
        runName: runName.trim() || undefined,
        receivingTreasuryWalletId: receivingWalletId || undefined,
      });
      if (result.importResult.imported === 0) {
        const existingName = result.collectionRun?.runName;
        if (existingName && result.importResult.idempotentReplay) {
          throw new Error(
            `This CSV was already imported as "${existingName}". Open that batch instead of re-importing.`,
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
            : 'No rows imported. Check that each row has a receiver, amount, and payer or counterparty.',
        );
      }
      return result;
    },
    onSuccess: (result) => {
      onSuccess(result.collectionRun.runName, result.importResult.imported);
    },
    onError: (err) => onError(err instanceof Error ? err.message : 'CSV import failed.'),
  });

  return (
    <div
      className="rd-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rd-import-title"
    >
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
          Columns:{' '}
          <span className="rd-mono">
            counterparty, receiving_wallet, payer_wallet, amount, reference, due_date
          </span>
          .
        </p>

        {step === 'edit' ? (
          <>
            <div className="rd-form-grid" style={{ marginBottom: 16 }}>
              <label className="rd-field">
                <span className="rd-field-label">Batch name</span>
                <input
                  value={runName}
                  onChange={(e) => setRunName(e.target.value)}
                  placeholder="April invoices"
                  className="rd-input"
                />
              </label>
              <label className="rd-field">
                <span className="rd-field-label">Default receiver (optional)</span>
                <select
                  value={receivingWalletId}
                  onChange={(e) => setReceivingWalletId(e.target.value)}
                  className="rd-select"
                >
                  <option value="">Use row value</option>
                  {wallets
                    .filter((w) => w.isActive)
                    .map((w) => (
                      <option key={w.treasuryWalletId} value={w.treasuryWalletId}>
                        {walletLabel(w)}
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
                placeholder={`counterparty,receiving_wallet,payer_wallet,amount,reference,due_date\nAcme Corp,<wallet-id-or-address>,,10.00,INV-1001,2026-05-01`}
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
              <button
                type="button"
                className="rd-btn rd-btn-secondary"
                onClick={() => setStep('edit')}
              >
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
