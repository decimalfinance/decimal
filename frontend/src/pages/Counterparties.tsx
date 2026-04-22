import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type { AuthenticatedSession, CollectionSource, Counterparty, Destination } from '../types';
import { shortenAddress, orbAccountUrl } from '../domain';
import { useToast } from '../ui/Toast';

type CategoryFilter = 'all' | 'categorized' | 'uncategorized';

type CounterpartyRollup = {
  counterparty: Counterparty;
  destinations: Destination[];
  payers: CollectionSource[];
};

function groupByCounterparty(
  counterparties: Counterparty[],
  destinations: Destination[],
  payers: CollectionSource[],
): CounterpartyRollup[] {
  return counterparties
    .map((c) => ({
      counterparty: c,
      destinations: destinations.filter((d) => d.counterpartyId === c.counterpartyId && d.isActive),
      payers: payers.filter((p) => p.counterpartyId === c.counterpartyId),
    }))
    .sort((a, b) => a.counterparty.displayName.localeCompare(b.counterparty.displayName));
}

export function CounterpartiesPage({ session: _session }: { session: AuthenticatedSession }) {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();

  const [addOpen, setAddOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<CategoryFilter>('all');

  const counterpartiesQuery = useQuery({
    queryKey: ['counterparties', workspaceId] as const,
    queryFn: () => api.listCounterparties(workspaceId!),
    enabled: Boolean(workspaceId),
  });
  const destinationsQuery = useQuery({
    queryKey: ['destinations', workspaceId] as const,
    queryFn: () => api.listDestinations(workspaceId!),
    enabled: Boolean(workspaceId),
  });
  const payersQuery = useQuery({
    queryKey: ['collection-sources', workspaceId] as const,
    queryFn: () => api.listCollectionSources(workspaceId!),
    enabled: Boolean(workspaceId),
  });

  async function invalidate() {
    await queryClient.invalidateQueries({ queryKey: ['counterparties', workspaceId] });
  }

  const createCounterpartyMutation = useMutation({
    mutationFn: (form: FormData) =>
      api.createCounterparty(workspaceId!, {
        displayName: String(form.get('displayName') ?? '').trim(),
        category: String(form.get('category') ?? '').trim() || undefined,
      }),
    onSuccess: async () => {
      success('Counterparty saved.');
      setAddOpen(false);
      await invalidate();
    },
    onError: (err) =>
      toastError(err instanceof Error ? err.message : 'Unable to save counterparty.'),
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

  const counterparties = counterpartiesQuery.data?.items ?? [];
  const destinations = destinationsQuery.data?.items ?? [];
  const payers = payersQuery.data?.items ?? [];

  const rollups = useMemo(
    () => groupByCounterparty(counterparties, destinations, payers),
    [counterparties, destinations, payers],
  );

  const filteredRollups = useMemo(() => {
    let out = rollups;
    if (filter === 'categorized') out = out.filter((r) => r.counterparty.category);
    else if (filter === 'uncategorized') out = out.filter((r) => !r.counterparty.category);

    const q = search.trim().toLowerCase();
    if (q) {
      out = out.filter((r) => {
        if (r.counterparty.displayName.toLowerCase().includes(q)) return true;
        if ((r.counterparty.category ?? '').toLowerCase().includes(q)) return true;
        if (r.destinations.some((d) => d.label.toLowerCase().includes(q))) return true;
        if (r.payers.some((p) => p.label.toLowerCase().includes(q))) return true;
        return false;
      });
    }
    return out;
  }, [rollups, filter, search]);

  const withDestinations = rollups.filter((r) => r.destinations.length > 0).length;
  const withPayers = rollups.filter((r) => r.payers.length > 0).length;
  const uncategorized = rollups.filter((r) => !r.counterparty.category).length;
  const orphanDestinations = destinations.filter((d) => !d.counterpartyId && d.isActive).length;
  const orphanPayers = payers.filter((p) => !p.counterpartyId).length;

  const isLoading =
    counterpartiesQuery.isLoading || destinationsQuery.isLoading || payersQuery.isLoading;

  return (
    <main className="page-frame">
      <header className="page-header">
        <div>
          <p className="eyebrow">Counterparties</p>
          <h1>Your business relationships</h1>
          <p>
            A counterparty is the business entity behind a wallet — a vendor, contractor, or
            customer. Group destinations (who you pay) and payers (who pays you) under one name to
            track activity end-to-end.
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="button button-primary" onClick={() => setAddOpen(true)}>
            + Add counterparty
          </button>
        </div>
      </header>

      <div className="rd-metrics">
        <div className="rd-metric">
          <span className="rd-metric-label">Counterparties</span>
          <span className="rd-metric-value">{counterparties.length}</span>
        </div>
        <div className="rd-metric">
          <span className="rd-metric-label">With destinations</span>
          <span className="rd-metric-value">{withDestinations}</span>
        </div>
        <div className="rd-metric">
          <span className="rd-metric-label">With payers</span>
          <span className="rd-metric-value">{withPayers}</span>
        </div>
        <div className="rd-metric">
          <span className="rd-metric-label">Uncategorized</span>
          <span className="rd-metric-value" data-tone={uncategorized > 0 ? 'warning' : undefined}>
            {uncategorized}
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
            placeholder="Search counterparty, category, wallet label"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search counterparties"
          />
        </div>
        <div className="rd-tabs" role="tablist" aria-label="Category filter">
          {(
            [
              ['all', 'All'],
              ['categorized', 'Categorized'],
              ['uncategorized', 'Uncategorized'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={filter === key}
              className="rd-tab"
              onClick={() => setFilter(key)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
        <div className="rd-toolbar-right">
          <span className="rd-section-meta">
            {filteredRollups.length} of {rollups.length}
          </span>
        </div>
      </div>

      {orphanDestinations + orphanPayers > 0 ? (
        <div
          className="rd-card"
          style={{
            padding: '12px 16px',
            marginBottom: 16,
            borderColor: 'var(--ax-border)',
            background: 'var(--ax-surface-2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ fontSize: 13, color: 'var(--ax-text-secondary)' }}>
            <strong style={{ color: 'var(--ax-text)' }}>Unassigned wallets: </strong>
            {orphanDestinations} destination{orphanDestinations === 1 ? '' : 's'} and{' '}
            {orphanPayers} payer{orphanPayers === 1 ? '' : 's'} are not linked to any counterparty.
            Edit them from the Destinations or Payers pages to group them here.
          </div>
        </div>
      ) : null}

      <section className="rd-section" style={{ marginTop: 0 }}>
        {isLoading ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
            <div className="rd-skeleton rd-skeleton-block" style={{ height: 160 }} />
            <div className="rd-skeleton rd-skeleton-block" style={{ height: 160 }} />
            <div className="rd-skeleton rd-skeleton-block" style={{ height: 160 }} />
          </div>
        ) : filteredRollups.length === 0 ? (
          <div className="rd-table-shell">
            <div className="rd-empty-cell" style={{ padding: '64px 24px' }}>
              <strong>{rollups.length === 0 ? 'No counterparties yet' : 'Nothing matches'}</strong>
              <p style={{ margin: '0 0 16px' }}>
                {rollups.length === 0
                  ? 'Add a counterparty to group destinations and payers by business relationship.'
                  : 'Clear the search or change the filter to see more.'}
              </p>
              {rollups.length === 0 ? (
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => setAddOpen(true)}
                >
                  + Add counterparty
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
              gap: 12,
            }}
          >
            {filteredRollups.map((rollup) => (
              <CounterpartyCard key={rollup.counterparty.counterpartyId} rollup={rollup} />
            ))}
          </div>
        )}
      </section>

      {addOpen ? (
        <Dialog
          title="Add counterparty"
          body="A counterparty is a business entity you can link destinations and payers to."
          pending={createCounterpartyMutation.isPending}
          onClose={() => setAddOpen(false)}
          onSubmit={(form) => createCounterpartyMutation.mutate(form)}
          submitLabel="Save counterparty"
        >
          <label className="field">
            Name
            <input
              name="displayName"
              required
              placeholder="Acme Corp"
              autoComplete="organization"
            />
          </label>
          <label className="field">
            Category
            <input
              name="category"
              placeholder="vendor, contractor, customer, internal"
              autoComplete="off"
            />
          </label>
        </Dialog>
      ) : null}
    </main>
  );
}

function CounterpartyCard({ rollup }: { rollup: CounterpartyRollup }) {
  const { counterparty, destinations, payers } = rollup;
  const [expanded, setExpanded] = useState(false);
  const total = destinations.length + payers.length;
  const canExpand = total > 0;

  return (
    <div className="rd-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: 'var(--ax-text)', fontWeight: 600, fontSize: 15, wordBreak: 'break-word' }}>
            {counterparty.displayName}
          </div>
          <div style={{ fontSize: 12, color: 'var(--ax-text-muted)', marginTop: 2 }}>
            {counterparty.category || 'Uncategorized'}
          </div>
        </div>
        <span
          className="rd-pill"
          data-tone={counterparty.status === 'active' ? 'success' : 'warning'}
          style={{ flexShrink: 0 }}
        >
          <span className="rd-pill-dot" aria-hidden />
          {counterparty.status || 'active'}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 16 }}>
        <CountTile label="Destinations" value={destinations.length} />
        <CountTile label="Payers" value={payers.length} />
      </div>

      {canExpand ? (
        <>
          <button
            type="button"
            className="rd-btn rd-btn-ghost"
            style={{ minHeight: 32, padding: '6px 10px', fontSize: 12, alignSelf: 'flex-start' }}
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? 'Hide wallets' : `Show ${total} wallet${total === 1 ? '' : 's'}`}
          </button>
          {expanded ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                borderTop: '1px solid var(--ax-border)',
                paddingTop: 12,
              }}
            >
              {destinations.length ? (
                <WalletGroup
                  label="Destinations"
                  items={destinations.map((d) => ({
                    id: d.destinationId,
                    label: d.label,
                    walletAddress: d.walletAddress,
                    trust: d.trustState,
                  }))}
                />
              ) : null}
              {payers.length ? (
                <WalletGroup
                  label="Payers"
                  items={payers.map((p) => ({
                    id: p.collectionSourceId,
                    label: p.label,
                    walletAddress: p.walletAddress,
                    trust: p.trustState,
                  }))}
                />
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <div style={{ fontSize: 12, color: 'var(--ax-text-faint)' }}>
          No wallets linked yet. Tag a destination or payer with this counterparty to populate it.
        </div>
      )}
    </div>
  );
}

function CountTile({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        flex: 1,
        padding: '8px 10px',
        background: 'var(--ax-surface-2)',
        border: '1px solid var(--ax-border)',
        borderRadius: 8,
      }}
    >
      <div
        style={{
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--ax-text-muted)',
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 600, color: 'var(--ax-text)', marginTop: 2 }}>
        {value}
      </div>
    </div>
  );
}

function WalletGroup({
  label,
  items,
}: {
  label: string;
  items: { id: string; label: string; walletAddress: string; trust: string }[];
}) {
  function trustToneFor(trust: string): 'success' | 'warning' | 'danger' | 'info' {
    if (trust === 'trusted') return 'success';
    if (trust === 'blocked' || trust === 'restricted') return 'danger';
    if (trust === 'unreviewed') return 'warning';
    return 'info';
  }
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--ax-text-muted)',
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map((item) => (
          <div
            key={item.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              fontSize: 13,
            }}
          >
            <span style={{ color: 'var(--ax-text)', flexShrink: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.label}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <a
                href={orbAccountUrl(item.walletAddress)}
                target="_blank"
                rel="noreferrer"
                className="rd-mono"
                style={{ fontSize: 11, color: 'var(--ax-accent)' }}
              >
                {shortenAddress(item.walletAddress, 4, 4)}
              </a>
              <span className="rd-pill" data-tone={trustToneFor(item.trust)} style={{ fontSize: 10 }}>
                <span className="rd-pill-dot" aria-hidden />
                {item.trust}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Dialog(props: {
  title: string;
  body: string;
  submitLabel: string;
  pending: boolean;
  onClose: () => void;
  onSubmit: (form: FormData) => void;
  children: ReactNode;
}) {
  const { title, body, submitLabel, pending, onClose, onSubmit, children } = props;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="rd-dialog-backdrop" role="dialog" aria-modal="true">
      <div className="rd-dialog" style={{ maxWidth: 520 }}>
        <h2 className="rd-dialog-title">{title}</h2>
        <p className="rd-dialog-body">{body}</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(new FormData(e.currentTarget));
          }}
        >
          {children}
          <div className="rd-dialog-actions" style={{ marginTop: 20 }}>
            <button type="button" className="button button-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="button button-primary"
              disabled={pending}
              aria-busy={pending}
            >
              {pending ? 'Saving…' : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
