import { useEffect } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

// One payment, one page. When someone lands on a proposal URL (from an email
// link, a bookmark, the proposals list), we resolve the proposal to its
// underlying payment and redirect. PaymentDetail surfaces proposal voting /
// execute actions inline based on state.
//
// Config-transaction proposals (multisig member changes, threshold changes,
// spending-limit add/remove) have no payment to link to, so they fall through
// to the dedicated proposal detail page.
export function ProposalRedirectPage() {
  const { organizationId, decimalProposalId } = useParams<{
    organizationId: string;
    decimalProposalId: string;
  }>();
  const navigate = useNavigate();

  const proposalQuery = useQuery({
    queryKey: ['organization-proposal', organizationId, decimalProposalId] as const,
    queryFn: () => api.getOrganizationProposal(organizationId!, decimalProposalId!),
    enabled: Boolean(organizationId && decimalProposalId),
  });

  useEffect(() => {
    if (!proposalQuery.data || !organizationId) return;
    const paymentOrderId = proposalQuery.data.paymentOrderId;
    if (paymentOrderId) {
      navigate(`/organizations/${organizationId}/payments/${paymentOrderId}`, {
        replace: true,
      });
    }
  }, [proposalQuery.data, organizationId, navigate]);

  if (!organizationId || !decimalProposalId) {
    return <Navigate to="/" replace />;
  }

  if (proposalQuery.isLoading) {
    return (
      <main className="page-frame">
        <p className="muted-copy">Loading payment…</p>
      </main>
    );
  }

  if (!proposalQuery.data) {
    return (
      <main className="page-frame">
        <p>Proposal not found.</p>
        <Link to={`/organizations/${organizationId}/payments`}>← Payments</Link>
      </main>
    );
  }

  // Config-transaction proposal (admin op like multisig member change) →
  // route to the legacy proposal detail page since it has no payment to show.
  if (!proposalQuery.data.paymentOrderId) {
    return (
      <Navigate
        to={`/organizations/${organizationId}/proposals/${decimalProposalId}/legacy`}
        replace
      />
    );
  }

  return (
    <main className="page-frame">
      <p className="muted-copy">Redirecting…</p>
    </main>
  );
}
