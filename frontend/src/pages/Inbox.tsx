import { useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import type { AuthenticatedSession, DecimalProposal, PaymentOrder } from '../types';
import { formatRawUsdcCompact, formatRelativeTime } from '../domain';
import { EmptyPanel, RdPageHeader } from '../ui-primitives';

// Inbox dashboard — the new entry point for an organization.
// Three lanes mapped to user intent:
//   1. Needs review  — proposals the agent flagged that need a human decision
//   2. Ready to pay  — proposals already approved, just need final execution
//   3. Recent        — last 7 days of completed activity
//
export function InboxPage({ session }: { session: AuthenticatedSession }) {
  const { organizationId } = useParams<{ organizationId: string }>();
  const navigate = useNavigate();
  const organizationName = useMemo(
    () =>
      session.organizations.find((org) => org.organizationId === organizationId)
        ?.organizationName ?? 'Workspace',
    [session, organizationId],
  );

  // One fetch for proposals (we split into Needs Review + Ready to Pay
  // client-side because the backend status filter is too coarse).
  const proposalsQuery = useQuery({
    queryKey: ['organization-proposals', organizationId, 'pending'] as const,
    queryFn: () =>
      api.listOrganizationProposals(organizationId!, { status: 'pending' }),
    enabled: Boolean(organizationId),
    refetchInterval: 15_000,
  });

  // Recent: most-recently-touched payment orders. The list is already sorted
  // newest first by the backend, so we just take the head.
  const paymentOrdersQuery = useQuery({
    queryKey: ['payment-orders', organizationId, 'recent'] as const,
    queryFn: () => api.listPaymentOrders(organizationId!),
    enabled: Boolean(organizationId),
    refetchInterval: 30_000,
  });

  const proposals = proposalsQuery.data?.items ?? [];
  const needsReview = proposals.filter(
    (p) => p.status === 'active' || p.status === 'draft',
  );
  const readyToPay = proposals.filter((p) => p.status === 'approved');

  // Lane 3: take the 5 most recent payment orders that landed (executed or
  // settled). Excludes ones that are still in queue — those live in lanes 1/2.
  const recent = (paymentOrdersQuery.data?.items ?? [])
    .filter((o) =>
      ['settled', 'executed', 'completed', 'reconciled'].includes(o.state),
    )
    .slice(0, 5);

  const isLoading =
    proposalsQuery.isLoading || paymentOrdersQuery.isLoading;

  return (
    <div className="rd-page">
      <RdPageHeader
        eyebrow={organizationName}
        title="Inbox"
        meta="What needs your attention today."
        side={
          <Link
            to={`/organizations/${organizationId}/payments`}
            className="button button-secondary"
          >
            Upload invoice
          </Link>
        }
      />

      <p className="form-help" style={{ marginTop: 8 }}>
        Forward invoices to{' '}
        <code className="rd-inline-code">
          invoices@{organizationName.toLowerCase().replace(/\s+/g, '-')}.decimal.finance
        </code>{' '}
        to start.
      </p>

      {isLoading ? (
        <p className="muted-copy" style={{ marginTop: 24 }}>
          Loading your inbox…
        </p>
      ) : (
        <div className="inbox-lanes">
          <Lane
            title="Needs review"
            count={needsReview.length}
            tone="warning"
            emptyTitle="Nothing needs your attention"
            emptyDescription="When the agent flags an invoice, it shows up here."
          >
            {needsReview.map((proposal) => (
              <ProposalRow
                key={proposal.decimalProposalId}
                proposal={proposal}
                action="Review"
                onClick={() => navigate(proposalLinkUrl(organizationId!, proposal))}
              />
            ))}
          </Lane>

          <Lane
            title="Ready to pay"
            count={readyToPay.length}
            tone="success"
            emptyTitle="Nothing ready to send"
            emptyDescription="Approved payments will show up here, one click to send."
          >
            {readyToPay.map((proposal) => (
              <ProposalRow
                key={proposal.decimalProposalId}
                proposal={proposal}
                action="Pay"
                onClick={() => navigate(proposalLinkUrl(organizationId!, proposal))}
              />
            ))}
          </Lane>

          <Lane
            title="Recent"
            count={recent.length}
            tone="neutral"
            emptyTitle="No recent activity"
            emptyDescription="Completed payments will appear here."
          >
            {recent.map((order) => (
              <PaymentOrderRow
                key={order.paymentOrderId}
                order={order}
                onClick={() =>
                  navigate(
                    `/organizations/${organizationId}/payments/${order.paymentOrderId}`,
                  )
                }
              />
            ))}
          </Lane>
        </div>
      )}
    </div>
  );
}

function Lane({
  title,
  count,
  tone,
  emptyTitle,
  emptyDescription,
  children,
}: {
  title: string;
  count: number;
  tone: 'warning' | 'success' | 'neutral';
  emptyTitle: string;
  emptyDescription: string;
  children: React.ReactNode;
}) {
  return (
    <section className="inbox-lane">
      <header className="inbox-lane-header">
        <h2 className="inbox-lane-title">
          {title}
          <span className={`inbox-lane-count inbox-lane-count-${tone}`}>{count}</span>
        </h2>
      </header>
      {count === 0 ? (
        <EmptyPanel title={emptyTitle} description={emptyDescription} />
      ) : (
        <div className="inbox-lane-rows">{children}</div>
      )}
    </section>
  );
}

function ProposalRow({
  proposal,
  action,
  onClick,
}: {
  proposal: DecimalProposal;
  action: 'Review' | 'Pay';
  onClick: () => void;
}) {
  const vendorLabel =
    proposal.paymentOrder?.counterpartyWallet?.label ??
    proposal.semanticType ??
    'Payment proposal';
  const amount = proposal.paymentOrder?.amountRaw
    ? formatRawUsdcCompact(proposal.paymentOrder.amountRaw)
    : null;
  const asset = proposal.paymentOrder?.asset ?? 'USDC';
  // Surface the most informative human-friendly fact we have. v1 reads
  // straight from the proposal — the agent's per-rule explanations will land
  // here once Approval Helper is wired into the API.
  const subline =
    summarizeProposalReason(proposal) ??
    (proposal.paymentOrder?.invoiceNumber
      ? `Invoice ${proposal.paymentOrder.invoiceNumber}`
      : formatRelativeTime(proposal.createdAt));

  return (
    <button type="button" className="inbox-row" onClick={onClick}>
      <span className="inbox-row-vendor">{vendorLabel}</span>
      <span className="inbox-row-amount">
        {amount ? `${amount} ${asset}` : '—'}
      </span>
      <span className="inbox-row-subline muted-copy">{subline}</span>
      <span className="inbox-row-action">{action} →</span>
    </button>
  );
}

function PaymentOrderRow({
  order,
  onClick,
}: {
  order: PaymentOrder;
  onClick: () => void;
}) {
  const vendorLabel = order.counterpartyWallet?.label ?? 'Payment';
  const amount = order.amountRaw ? formatRawUsdcCompact(order.amountRaw) : null;
  const asset = order.asset ?? 'USDC';
  const when = order.updatedAt ? formatRelativeTime(order.updatedAt) : '';
  return (
    <button type="button" className="inbox-row" onClick={onClick}>
      <span className="inbox-row-vendor">{vendorLabel}</span>
      <span className="inbox-row-amount">{amount ? `${amount} ${asset}` : '—'}</span>
      <span className="inbox-row-subline muted-copy">Paid {when}</span>
      <span className="inbox-row-action">View →</span>
    </button>
  );
}

// Payment proposals route to their payment detail. Config-transaction
// proposals (add member, change threshold, etc) route to the proposal
// detail page since they have no payment to display.
function proposalLinkUrl(organizationId: string, proposal: DecimalProposal): string {
  if (proposal.paymentOrderId) {
    return `/organizations/${organizationId}/payments/${proposal.paymentOrderId}`;
  }
  return `/organizations/${organizationId}/proposals/${proposal.decimalProposalId}`;
}

// Crude v1 summarizer: pulls a one-liner from the proposal's intent JSON when
// the agent has populated triggered rules. Falls back to null. The richer
// per-rule explanations live on the Review Packet page.
function summarizeProposalReason(proposal: DecimalProposal): string | null {
  const intent = proposal.intentJson as
    | { triggeredRules?: Array<{ rule?: string; reason?: string }> }
    | undefined;
  const rules = intent?.triggeredRules;
  if (!rules || rules.length === 0) return null;
  if (rules.length === 1) return rules[0]?.reason ?? null;
  return `${rules.length} flags · ${rules[0]?.rule ?? ''} +${rules.length - 1}`;
}
