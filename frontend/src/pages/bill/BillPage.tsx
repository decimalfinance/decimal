// A bill's page: the breadcrumb, then the bill as its stage shows it. It reads
// the bill as the viewer sees it, with Decimal's note on it, and reads again
// while Decimal is still working something out.
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { accessApi, api, billsApi, companionApi, type BillDetail } from '../../api';
import { headerOf, fieldsFrom, type Face } from './model';
import { Review } from './Review';
import type { Access } from './Findings';

/** Decimal is still investigating a finding: read again shortly. */
function stillWorking(detail: BillDetail | undefined) {
  return Boolean(detail?.draft.flags.some((f) => f.brief?.status === 'running' || f.finding?.status === 'running'));
}

export function BillPage() {
  const { organizationId = '', paymentOrderId = '' } = useParams();
  const session = useQuery({ queryKey: ['session'], queryFn: () => api.getSession(), staleTime: Infinity });
  const access = useQuery({
    queryKey: ['my-access', organizationId],
    queryFn: () => accessApi.get(organizationId),
    enabled: Boolean(organizationId),
  });
  const detail = useQuery({
    queryKey: ['bill', organizationId, paymentOrderId],
    queryFn: () => billsApi.detail(organizationId, paymentOrderId),
    enabled: Boolean(organizationId && paymentOrderId),
    refetchInterval: (q) => (stillWorking(q.state.data) ? 2500 : false),
  });
  const note = useQuery({
    queryKey: ['bill-note', organizationId, paymentOrderId],
    queryFn: () => companionApi.billNote(organizationId, paymentOrderId),
    enabled: Boolean(organizationId && paymentOrderId),
    staleTime: 30_000,
  });

  const data = detail.data;
  const user = session.data?.user;
  const viewer: Face = { name: user?.displayName ?? user?.email ?? 'You', avatarUrl: user?.avatarUrl ?? null };
  const my: Access = {
    isAdmin: Boolean(access.data?.isPrimaryOrAdmin),
    isPrimary: access.data?.membershipRole === 'primary_admin',
    canEdit: Boolean(access.data?.capabilities.includes('bills.edit')),
    worksOnBills: Boolean(access.data?.capabilities.includes('bills.edit')),
  };

  const stage = data ? headerOf(data, fieldsFrom(data.draft)).stageText : null;
  const reference = data
    ? data.draft.fields.find((f) => f.key === 'invoiceNumber')?.value?.toString() || data.draft.vendor.name
    : null;

  return (
    <div className="ui bp">
      <div className="bp-crumb">
        <Link to={`/organizations/${organizationId}/bills`}>Bills</Link>
        {stage ? (
          <>
            <span className="bp-crumb-sep">/</span>
            <span>{stage}</span>
          </>
        ) : null}
        {reference ? (
          <>
            <span className="bp-crumb-sep">/</span>
            <span className="bp-crumb-inv">{reference}</span>
          </>
        ) : null}
      </div>
      {detail.isError ? (
        <div className="bp-body">
          <div className="bp-panel">
            <h1 className="bp-title">This bill couldn’t be opened</h1>
            <div className="bp-status">{detail.error instanceof Error ? detail.error.message : 'Try again in a moment.'}</div>
          </div>
        </div>
      ) : !data || !access.data || !session.data ? (
        <div className="bp-body">
          <div className="bp-panel">
            <div className="bp-loading" />
          </div>
        </div>
      ) : (
        <Review
          key={paymentOrderId}
          organizationId={organizationId}
          detail={data}
          note={note.data}
          viewer={viewer}
          access={my}
          onRefetch={() => detail.refetch()}
        />
      )}
    </div>
  );
}

/**
 * A bill's own address. A bill in review opens on this page; one in approval
 * or done still opens on the old one until those stages are built here.
 */
export function BillRoute({ legacy }: { legacy: ReactNode }) {
  const { organizationId = '', paymentOrderId = '' } = useParams();
  const detail = useQuery({
    queryKey: ['bill', organizationId, paymentOrderId],
    queryFn: () => billsApi.detail(organizationId, paymentOrderId),
    enabled: Boolean(organizationId && paymentOrderId),
  });
  if (detail.data && detail.data.draft.state !== 'draft') return <>{legacy}</>;
  return <BillPage />;
}
