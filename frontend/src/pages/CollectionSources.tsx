import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type {
  AuthenticatedSession,
  CollectionSource,
  CollectionSourceTrustState,
  Counterparty,
} from '../types';
import { shortenAddress, orbAccountUrl } from '../domain';
import {
  collectionSourceTrustTone,
  displayCollectionSourceName,
  displayCollectionSourceTrust,
  toneToPill,
} from '../status-labels';
import { useToast } from '../ui/Toast';

type TrustFilter = 'all' | CollectionSourceTrustState;

export function CollectionSourcesPage({ session: _session }: { session: AuthenticatedSession }) {
  const { organizationId } = useParams<{ organizationId: string }>();
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();

  const [addOpen, setAddOpen] = useState(false);
  const [editSource, setEditSource] = useState<CollectionSource | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<TrustFilter>('all');

  const sourcesQuery = useQuery({
    queryKey: ['collection-sources', organizationId] as const,
    queryFn: () => api.listCollectionSources(organizationId!),
    enabled: Boolean(organizationId),
    refetchInterval: () => (typeof document !== 'undefined' && document.hidden ? false : 15_000),
  });
  const counterpartiesQuery = useQuery({
    queryKey: ['counterparties', organizationId] as const,
    queryFn: () => api.listCounterparties(organizationId!),
    enabled: Boolean(organizationId),
  });

  async function invalidate() {
    await queryClient.invalidateQueries({ queryKey: ['collection-sources', organizationId] });
  }

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

  const sources = sourcesQuery.data?.items ?? [];
  const counterparties = counterpartiesQuery.data?.items ?? [];

  const filtered = useMemo(() => {
    let out = sources;
    if (filter !== 'all') {
      out = out.filter((s) => s.trustState === filter);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      out = out.filter(
        (s) =>
          s.label.toLowerCase().includes(q) ||
          s.walletAddress.toLowerCase().includes(q) ||
          (s.counterparty?.displayName ?? '').toLowerCase().includes(q),
      );
    }
    return out.slice().sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [sources, search, filter]);

  const unreviewed = sources.filter((s) => s.trustState === 'unreviewed').length;
  const trusted = sources.filter((s) => s.trustState === 'trusted').length;
  const restrictedOrBlocked = sources.filter(
    (s) => s.trustState === 'restricted' || s.trustState === 'blocked',
  ).length;

  const isLoading = sourcesQuery.isLoading;

  return (
    <main className="page-frame">
      <header className="page-header">
        <div>
          <p className="eyebrow">Payers</p>
          <h1>Collection sources</h1>
          <p>
            Wallets you receive USDC from. Unreviewed sources are created automatically when a
            collection matches a new address — promote them to trusted once you&apos;ve verified the
            payer.
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="button button-primary" onClick={() => setAddOpen(true)}>
            + Add payer
          </button>
        </div>
      </header>

      <div className="rd-metrics">
        <div className="rd-metric">
          <span className="rd-metric-label">Unreviewed</span>
          <span className="rd-metric-value" data-tone={unreviewed > 0 ? 'warning' : undefined}>
            {unreviewed}
          </span>
        </div>
        <div className="rd-metric">
          <span className="rd-metric-label">Trusted</span>
          <span className="rd-metric-value" data-tone="success">
            {trusted}
          </span>
        </div>
        <div className="rd-metric">
          <span className="rd-metric-label">Restricted / blocked</span>
          <span
            className="rd-metric-value"
            data-tone={restrictedOrBlocked > 0 ? 'danger' : undefined}
          >
            {restrictedOrBlocked}
          </span>
        </div>
        <div className="rd-metric">
          <span className="rd-metric-label">Total</span>
          <span className="rd-metric-value">{sources.length}</span>
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
            placeholder="Search label, wallet, counterparty"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search payers"
          />
        </div>
        <div className="rd-tabs" role="tablist" aria-label="Trust filter">
          {(['all', 'unreviewed', 'trusted', 'restricted', 'blocked'] as const).map((key) => (
            <button
              key={key}
              role="tab"
              aria-selected={filter === key}
              className="rd-tab"
              onClick={() => setFilter(key)}
              type="button"
            >
              {key === 'all' ? 'All' : displayCollectionSourceTrust(key)}
            </button>
          ))}
        </div>
        <div className="rd-toolbar-right">
          <span className="rd-section-meta">
            {filtered.length} of {sources.length}
          </span>
        </div>
      </div>

      <section className="rd-section" style={{ marginTop: 0 }}>
        <div className="rd-table-shell">
          {isLoading ? (
            <div style={{ padding: 16 }}>
              <div className="rd-skeleton rd-skeleton-block" style={{ height: 56, marginBottom: 8 }} />
              <div className="rd-skeleton rd-skeleton-block" style={{ height: 56, marginBottom: 8 }} />
              <div className="rd-skeleton rd-skeleton-block" style={{ height: 56 }} />
            </div>
          ) : filtered.length === 0 ? (
            <div className="rd-empty-cell" style={{ padding: '64px 24px' }}>
              <strong>{sources.length === 0 ? 'No payers yet' : 'Nothing matches'}</strong>
              <p style={{ margin: '0 0 16px' }}>
                {sources.length === 0
                  ? 'Add a payer to track who sends you USDC.'
                  : 'Clear the search or change the filter to see more.'}
              </p>
              {sources.length === 0 ? (
                <button type="button" className="button button-primary" onClick={() => setAddOpen(true)}>
                  + Add payer
                </button>
              ) : null}
            </div>
          ) : (
            <table className="rd-table">
              <thead>
                <tr>
                  <th style={{ width: '32%' }}>Label</th>
                  <th style={{ width: '22%' }}>Counterparty</th>
                  <th style={{ width: '26%' }}>Wallet</th>
                  <th style={{ width: '14%' }}>Trust</th>
                  <th aria-label="Actions" style={{ width: '6%' }} />
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => {
                  const displayName = displayCollectionSourceName(s.label, s.walletAddress);
                  return (
                    <tr key={s.collectionSourceId}>
                      <td>
                        <div className="rd-recipient-main">
                          <span className="rd-recipient-name">{displayName}</span>
                          {s.notes && !s.metadataJson?.autoCreated ? (
                            <span className="rd-recipient-ref">{s.notes}</span>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        {s.counterparty?.displayName ? (
                          <span className="rd-origin" data-kind="run">
                            {s.counterparty.displayName}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--ax-text-faint)', fontSize: 12 }}>
                            Unassigned
                          </span>
                        )}
                      </td>
                      <td>
                        <a
                          href={orbAccountUrl(s.walletAddress)}
                          target="_blank"
                          rel="noreferrer"
                          className="rd-mono"
                          style={{ fontSize: 12, color: 'var(--ax-accent)' }}
                          title={s.walletAddress}
                        >
                          {shortenAddress(s.walletAddress, 4, 4)}
                        </a>
                      </td>
                      <td>
                        <span
                          className="rd-pill"
                          data-tone={toneToPill(collectionSourceTrustTone(s.trustState))}
                        >
                          <span className="rd-pill-dot" aria-hidden />
                          {displayCollectionSourceTrust(s.trustState)}
                        </span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="rd-btn rd-btn-ghost"
                          style={{
                            minHeight: 32,
                            width: 32,
                            padding: 0,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                          onClick={() => setEditSource(s)}
                          aria-label={`Edit ${displayName}`}
                          title="Edit"
                        >
                          <EditIcon />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {addOpen ? (
        <AddCollectionSourceDialog
          organizationId={organizationId}
          counterparties={counterparties}
          onClose={() => setAddOpen(false)}
          onSuccess={async () => {
            setAddOpen(false);
            success('Payer source saved.');
            await invalidate();
          }}
          onError={(message) => toastError(message)}
        />
      ) : null}

      {editSource ? (
        <EditCollectionSourceDialog
          organizationId={organizationId}
          source={editSource}
          counterparties={counterparties}
          onClose={() => setEditSource(null)}
          onSuccess={async () => {
            setEditSource(null);
            success('Payer source updated.');
            await invalidate();
          }}
          onError={(message) => toastError(message)}
        />
      ) : null}
    </main>
  );
}

export function AddCollectionSourceDialog(props: {
  organizationId: string;
  counterparties: Counterparty[];
  onClose: () => void;
  onSuccess: () => void;
  onError: (message: string) => void;
}) {
  const { organizationId, counterparties, onClose, onSuccess, onError } = props;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const mutation = useMutation({
    mutationFn: (form: FormData) =>
      api.createCollectionSource(organizationId, {
        label: String(form.get('label') ?? '').trim(),
        walletAddress: String(form.get('walletAddress') ?? '').trim(),
        trustState: String(form.get('trustState') ?? 'unreviewed') as CollectionSourceTrustState,
        counterpartyId: String(form.get('counterpartyId') ?? '').trim() || undefined,
        notes: String(form.get('notes') ?? '').trim() || undefined,
      }),
    onSuccess: () => onSuccess(),
    onError: (err) => onError(err instanceof Error ? err.message : 'Unable to save payer source.'),
  });

  return (
    <div
      className="rd-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rd-add-source-title"
    >
      <div className="rd-dialog" style={{ maxWidth: 520 }}>
        <h2 id="rd-add-source-title" className="rd-dialog-title">
          New payer source
        </h2>
        <p className="rd-dialog-body">A wallet address you receive USDC from.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate(new FormData(e.currentTarget));
          }}
        >
          <div className="rd-form-grid">
            <label className="rd-field" style={{ gridColumn: '1 / -1' }}>
              <span className="rd-field-label">Label</span>
              <input
                name="label"
                required
                placeholder="Acme Corp — ops wallet"
                className="rd-input"
                autoComplete="off"
              />
            </label>
            <label className="rd-field" style={{ gridColumn: '1 / -1' }}>
              <span className="rd-field-label">Wallet address</span>
              <input
                name="walletAddress"
                required
                placeholder="Solana address"
                className="rd-input"
                autoComplete="off"
              />
            </label>
            <label className="rd-field">
              <span className="rd-field-label">Trust state</span>
              <select name="trustState" className="rd-select" defaultValue="unreviewed">
                <option value="unreviewed">Unreviewed</option>
                <option value="trusted">Trusted</option>
                <option value="restricted">Restricted</option>
                <option value="blocked">Blocked</option>
              </select>
            </label>
            <label className="rd-field">
              <span className="rd-field-label">Counterparty (optional)</span>
              <select name="counterpartyId" className="rd-select" defaultValue="">
                <option value="">—</option>
                {counterparties.map((c) => (
                  <option key={c.counterpartyId} value={c.counterpartyId}>
                    {c.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="rd-field" style={{ gridColumn: '1 / -1' }}>
              <span className="rd-field-label">Notes (optional)</span>
              <input
                name="notes"
                placeholder="Verified via signed email on 2026-04-22"
                className="rd-input"
                autoComplete="off"
              />
            </label>
          </div>
          <div className="rd-dialog-actions" style={{ marginTop: 24 }}>
            <button type="button" className="button button-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="button button-primary"
              disabled={mutation.isPending}
              aria-busy={mutation.isPending}
            >
              {mutation.isPending ? 'Saving…' : 'Save payer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function EditCollectionSourceDialog(props: {
  organizationId: string;
  source: CollectionSource;
  counterparties: Counterparty[];
  onClose: () => void;
  onSuccess: () => void;
  onError: (message: string) => void;
}) {
  const { organizationId, source, counterparties, onClose, onSuccess, onError } = props;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const mutation = useMutation({
    mutationFn: (form: FormData) =>
      api.updateCollectionSource(organizationId, source.collectionSourceId, {
        label: String(form.get('label') ?? '').trim(),
        trustState: String(form.get('trustState') ?? source.trustState) as CollectionSourceTrustState,
        counterpartyId:
          String(form.get('counterpartyId') ?? '').trim() || null,
        notes: String(form.get('notes') ?? '').trim() || null,
      }),
    onSuccess: () => onSuccess(),
    onError: (err) => onError(err instanceof Error ? err.message : 'Unable to update payer source.'),
  });

  return (
    <div
      className="rd-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rd-edit-source-title"
    >
      <div className="rd-dialog" style={{ maxWidth: 520 }}>
        <h2 id="rd-edit-source-title" className="rd-dialog-title">
          Edit payer source
        </h2>
        <p className="rd-dialog-body rd-mono" style={{ fontSize: 12 }}>
          {shortenAddress(source.walletAddress, 6, 6)}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate(new FormData(e.currentTarget));
          }}
        >
          <div className="rd-form-grid">
            <label className="rd-field" style={{ gridColumn: '1 / -1' }}>
              <span className="rd-field-label">Label</span>
              <input
                name="label"
                required
                defaultValue={source.label}
                className="rd-input"
                autoComplete="off"
              />
            </label>
            <label className="rd-field">
              <span className="rd-field-label">Trust state</span>
              <select name="trustState" className="rd-select" defaultValue={source.trustState}>
                <option value="unreviewed">Unreviewed</option>
                <option value="trusted">Trusted</option>
                <option value="restricted">Restricted</option>
                <option value="blocked">Blocked</option>
              </select>
            </label>
            <label className="rd-field">
              <span className="rd-field-label">Counterparty</span>
              <select
                name="counterpartyId"
                className="rd-select"
                defaultValue={source.counterpartyId ?? ''}
              >
                <option value="">—</option>
                {counterparties.map((c) => (
                  <option key={c.counterpartyId} value={c.counterpartyId}>
                    {c.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="rd-field" style={{ gridColumn: '1 / -1' }}>
              <span className="rd-field-label">Notes</span>
              <input
                name="notes"
                defaultValue={source.notes ?? ''}
                placeholder="Why this is trusted / restricted / etc."
                className="rd-input"
                autoComplete="off"
              />
            </label>
          </div>
          <div className="rd-dialog-actions" style={{ marginTop: 24 }}>
            <button type="button" className="button button-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="button button-primary"
              disabled={mutation.isPending}
              aria-busy={mutation.isPending}
            >
              {mutation.isPending ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function EditIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M11.5 2.5 13.5 4.5 6 12H4v-2l7.5-7.5z" />
      <path d="M10.5 3.5 12.5 5.5" />
    </svg>
  );
}
