import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import type {
  AuthenticatedSession,
  DecimalProposal,
  ProposalSemanticType,
  SquadsProposalListStatusFilter,
} from '../types';
import { signAndSubmitIntent } from '../lib/squads-pipeline';
import { useToast } from '../ui/Toast';
import { ProposalsTable, type ProposalsTableBusy } from '../ui/ProposalsTable';
import { RdFilterBar } from '../ui-primitives';

const SEMANTIC_FILTER_OPTIONS: Array<{
  value: '' | ProposalSemanticType;
  label: string;
}> = [
  { value: '', label: 'All types' },
  { value: 'send_payment', label: 'Payment' },
  { value: 'add_member', label: 'Add member' },
  { value: 'change_threshold', label: 'Change threshold' },
];

export function OrganizationProposalsPage({ session }: { session: AuthenticatedSession }) {
  const { organizationId } = useParams<{ organizationId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();

  const [statusFilter, setStatusFilter] = useState<SquadsProposalListStatusFilter>('pending');
  const [semanticFilter, setSemanticFilter] = useState<'' | ProposalSemanticType>('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<ProposalsTableBusy | null>(null);

  const treasuryWalletFilter = searchParams.get('treasuryWalletId') ?? '';

  const ownPersonalWalletsQuery = useQuery({
    queryKey: ['personal-wallets'] as const,
    queryFn: () => api.listPersonalWallets(),
    enabled: Boolean(organizationId),
  });
  const ownPersonalWallets = useMemo(
    () =>
      (ownPersonalWalletsQuery.data?.items ?? []).filter(
        (w) => w.status === 'active' && w.chain === 'solana',
      ),
    [ownPersonalWalletsQuery.data],
  );

  const treasuriesQuery = useQuery({
    queryKey: ['treasury-wallets', organizationId] as const,
    queryFn: () => api.listTreasuryWallets(organizationId!),
    enabled: Boolean(organizationId),
  });
  const treasuries = treasuriesQuery.data?.items ?? [];

  const proposalsQuery = useQuery({
    queryKey: [
      'organization-proposals',
      organizationId,
      statusFilter,
      treasuryWalletFilter,
    ] as const,
    queryFn: () =>
      api.listOrganizationProposals(organizationId!, {
        status: statusFilter,
        treasuryWalletId: treasuryWalletFilter || undefined,
      }),
    enabled: Boolean(organizationId),
    refetchInterval: 20_000,
  });

  const allItems = proposalsQuery.data?.items ?? [];
  const items = useMemo(() => {
    let out = allItems;
    if (semanticFilter) out = out.filter((p) => p.semanticType === semanticFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      const treasuryNameById = new Map(
        treasuries.map((t) => [t.treasuryWalletId, (t.displayName ?? '').toLowerCase()]),
      );
      out = out.filter((p) =>
        [
          p.decimalProposalId,
          p.semanticType ?? '',
          p.paymentOrderId ?? '',
          p.paymentRunId ?? '',
          p.creatorWalletAddress ?? '',
          p.treasuryWalletId ? (treasuryNameById.get(p.treasuryWalletId) ?? '') : '',
        ]
          .join(' ')
          .toLowerCase()
          .includes(q),
      );
    }
    return out;
  }, [allItems, semanticFilter, search, treasuries]);

  async function refreshProposals(decimalProposalId?: string) {
    await queryClient.invalidateQueries({ queryKey: ['organization-proposals', organizationId] });
    await queryClient.invalidateQueries({ queryKey: ['payment-orders', organizationId] });
    if (decimalProposalId) {
      await queryClient.invalidateQueries({
        queryKey: ['organization-proposal', organizationId, decimalProposalId],
      });
    }
  }

  const approveMutation = useMutation({
    mutationFn: async (input: { proposal: DecimalProposal; signerWalletId: string }) => {
      const intent = await api.createProposalApprovalIntent(
        organizationId!,
        input.proposal.decimalProposalId,
        { memberPersonalWalletId: input.signerWalletId },
      );
      const sig = await signAndSubmitIntent({
        intent,
        signerPersonalWalletId: input.signerWalletId,
      });
      return { decimalProposalId: input.proposal.decimalProposalId, signature: sig };
    },
    onSuccess: async (result) => {
      success('Approval submitted.');
      await refreshProposals(result.decimalProposalId);
    },
    onError: (err) => {
      toastError(err instanceof ApiError || err instanceof Error ? err.message : 'Approve failed.');
    },
    onSettled: () => setBusy(null),
  });

  const executeMutation = useMutation({
    mutationFn: async (input: { proposal: DecimalProposal; signerWalletId: string }) => {
      const decimalProposalId = input.proposal.decimalProposalId;
      const intent = await api.createProposalExecuteIntent(
        organizationId!,
        decimalProposalId,
        { memberPersonalWalletId: input.signerWalletId },
      );
      const sig = await signAndSubmitIntent({
        intent,
        signerPersonalWalletId: input.signerWalletId,
      });
      try {
        await api.confirmProposalExecution(organizationId!, decimalProposalId, { signature: sig });
      } catch {
        // ignore — refetch will catch up
      }
      if (input.proposal.proposalType === 'config_transaction' && input.proposal.treasuryWalletId) {
        try {
          await api.syncSquadsTreasuryMembers(organizationId!, input.proposal.treasuryWalletId);
        } catch {
          // ignore
        }
      }
      return { decimalProposalId, signature: sig };
    },
    onSuccess: async (result) => {
      success('Proposal executed.');
      await refreshProposals(result.decimalProposalId);
      await queryClient.invalidateQueries({
        queryKey: ['treasury-wallet-detail', organizationId],
      });
    },
    onError: (err) => {
      toastError(err instanceof ApiError || err instanceof Error ? err.message : 'Execute failed.');
    },
    onSettled: () => setBusy(null),
  });

  function setTreasuryFilter(treasuryWalletId: string) {
    const next = new URLSearchParams(searchParams);
    if (treasuryWalletId) {
      next.set('treasuryWalletId', treasuryWalletId);
    } else {
      next.delete('treasuryWalletId');
    }
    setSearchParams(next, { replace: true });
  }

  if (!organizationId) {
    return (
      <main className="page-frame">
        <div className="rd-state">
          <h2 className="rd-state-title">Organization unavailable</h2>
          <p className="rd-state-body">Pick an organization from the sidebar.</p>
        </div>
      </main>
    );
  }

  const showTreasuryColumn = !treasuryWalletFilter;
  const squadsTreasuries = treasuries.filter((t) => t.source === 'squads_v4' && t.isActive);

  return (
    <main className="page-frame">
      <header className="page-header">
        <div>
          <p className="eyebrow">Operations</p>
          <h1>Proposals</h1>
          <p>
            Squads config and payment proposals across every treasury you sign for in this organization. Each proposal is its own on-chain transaction; sign approvals independently.
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={() => proposalsQuery.refetch()}
            disabled={proposalsQuery.isFetching}
            aria-busy={proposalsQuery.isFetching}
          >
            {proposalsQuery.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
          <NewProposalButton organizationId={organizationId} navigate={navigate} />
        </div>
      </header>

      <FilterRow
        search={search}
        onSearchChange={setSearch}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        semanticFilter={semanticFilter}
        onSemanticFilterChange={setSemanticFilter}
        treasuries={squadsTreasuries.map((t) => ({
          treasuryWalletId: t.treasuryWalletId,
          displayName: t.displayName,
        }))}
        treasuryFilter={treasuryWalletFilter}
        onTreasuryFilterChange={setTreasuryFilter}
        rightMeta={`${items.length} of ${allItems.length}`}
      />

      {proposalsQuery.isLoading ? (
        <section className="rd-section">
          <div className="rd-skeleton rd-skeleton-block" style={{ height: 140, marginBottom: 8 }} />
          <div className="rd-skeleton rd-skeleton-block" style={{ height: 140 }} />
        </section>
      ) : proposalsQuery.error ? (
        <section className="rd-section">
          <div className="rd-empty-cell" style={{ padding: '48px 24px' }}>
            <strong>Couldn't load proposals</strong>
            <p style={{ margin: 0 }}>
              {proposalsQuery.error instanceof Error
                ? proposalsQuery.error.message
                : 'Unknown error.'}
            </p>
          </div>
        </section>
      ) : (
        <ProposalsTable
          proposals={items}
          ownPersonalWallets={ownPersonalWallets}
          currentUserId={session.user.userId}
          organizationId={organizationId}
          busy={busy}
          showTreasuryColumn={showTreasuryColumn}
          emptyHint={
            statusFilter === 'pending'
              ? 'No pending proposals — try the All or Closed filter to see history.'
              : 'No proposals match these filters.'
          }
          onApprove={(proposal, signerWalletId) => {
            setBusy({ decimalProposalId: proposal.decimalProposalId, action: 'approve' });
            approveMutation.mutate({ proposal, signerWalletId });
          }}
          onExecute={(proposal, signerWalletId) => {
            setBusy({ decimalProposalId: proposal.decimalProposalId, action: 'execute' });
            executeMutation.mutate({ proposal, signerWalletId });
          }}
        />
      )}
    </main>
  );
}

function FilterRow({
  search,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  semanticFilter,
  onSemanticFilterChange,
  treasuries,
  treasuryFilter,
  onTreasuryFilterChange,
  rightMeta,
}: {
  search: string;
  onSearchChange: (next: string) => void;
  statusFilter: SquadsProposalListStatusFilter;
  onStatusFilterChange: (next: SquadsProposalListStatusFilter) => void;
  semanticFilter: '' | ProposalSemanticType;
  onSemanticFilterChange: (next: '' | ProposalSemanticType) => void;
  treasuries: Array<{ treasuryWalletId: string; displayName: string | null }>;
  treasuryFilter: string;
  onTreasuryFilterChange: (treasuryWalletId: string) => void;
  rightMeta: string;
}) {
  const tabs = (['pending', 'all', 'closed'] as SquadsProposalListStatusFilter[]).map((id) => ({
    id,
    label: id.charAt(0).toUpperCase() + id.slice(1),
    active: statusFilter === id,
    onClick: () => onStatusFilterChange(id),
  }));
  const selects = [
    {
      label: 'Type',
      value: semanticFilter,
      onChange: (next: string) => onSemanticFilterChange(next as '' | ProposalSemanticType),
      options: SEMANTIC_FILTER_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
    },
    {
      label: 'Treasury',
      value: treasuryFilter,
      onChange: onTreasuryFilterChange,
      options: [
        { value: '', label: 'All treasuries' },
        ...treasuries.map((t) => ({
          value: t.treasuryWalletId,
          label: t.displayName ?? 'Untitled treasury',
        })),
      ],
    },
  ];
  return (
    <RdFilterBar
      search={{
        value: search,
        onChange: onSearchChange,
        placeholder: 'Search proposal id, treasury, payment run',
        ariaLabel: 'Search proposals',
      }}
      tabs={tabs}
      selects={selects}
      rightMeta={rightMeta}
    />
  );
}

function NewProposalButton({
  organizationId,
  navigate,
}: {
  organizationId: string;
  navigate: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!ref.current) return;
      if (e.target instanceof Node && ref.current.contains(e.target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className="button button-primary"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        + New proposal
      </button>
      {open ? (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            minWidth: 280,
            padding: 6,
            borderRadius: 10,
            border: '1px solid var(--ax-border)',
            background: 'var(--ax-surface-1)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            zIndex: 20,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <MenuItem
            title="Send payment"
            description="From an approved payment order whose source is a Squads treasury."
            onClick={() => {
              setOpen(false);
              navigate(`/organizations/${organizationId}/payments`);
            }}
          />
          <MenuItem
            title="Add member"
            description="Initiate from a Squads treasury detail page."
            onClick={() => {
              setOpen(false);
              navigate(`/organizations/${organizationId}/wallets`);
            }}
          />
          <MenuItem
            title="Change threshold"
            description="Initiate from a Squads treasury detail page."
            onClick={() => {
              setOpen(false);
              navigate(`/organizations/${organizationId}/wallets`);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function MenuItem({
  title,
  description,
  onClick,
}: {
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        textAlign: 'left',
        padding: '10px 12px',
        background: 'transparent',
        border: 'none',
        borderRadius: 8,
        cursor: 'pointer',
        color: 'inherit',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--ax-surface-2)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <strong style={{ fontSize: 13 }}>{title}</strong>
      <span style={{ fontSize: 12, color: 'var(--ax-text-muted)', lineHeight: 1.4 }}>
        {description}
      </span>
    </button>
  );
}
