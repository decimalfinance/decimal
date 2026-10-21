// A bill's page: the breadcrumb, then the bill as its stage shows it. It reads
// the bill as the viewer sees it, with Decimal's note on it, and reads again
// while Decimal is still working something out. Arriving from the file being
// read, the bill lands part by part (5r) before it settles into review.
import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { accessApi, api, billsApi, companionApi, type BillDetail } from '../../api';
import { READ_DONE, READ_TICK_MS, headerOf, fieldsFrom, landsAt, type Face } from './model';
import { Review } from './Review';
import type { Access } from './Findings';

/** Decimal is still investigating a finding: read again shortly. */
function stillWorking(detail: BillDetail | undefined) {
  return Boolean(detail?.draft.flags.some((f) => f.brief?.status === 'running' || f.finding?.status === 'running'));
}

/** The file the bill came from is still being worked on: its checks are still to come. */
function stillReading(detail: BillDetail | undefined) {
  return detail?.draft.document?.status === 'processing';
}

/**
 * The tick a bill's landing has reached. It counts up once the bill is there
 * to land, and sits at the end when the bill wasn't just read.
 */
function useLanding(landing: boolean, ready: boolean): number {
  const [k, setK] = useState(landing ? 0 : READ_DONE);
  useEffect(() => {
    if (!landing) {
      setK(READ_DONE);
      return;
    }
    if (!ready || k >= READ_DONE) return;
    const timer = window.setTimeout(() => setK(k + 1), READ_TICK_MS);
    return () => window.clearTimeout(timer);
  }, [landing, ready, k]);
  return k;
}

export function BillPage() {
  const { organizationId = '', paymentOrderId = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const landing = Boolean((location.state as { justRead?: boolean } | null)?.justRead);
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
    refetchInterval: (q) => (stillReading(q.state.data) ? 1200 : stillWorking(q.state.data) ? 2500 : false),
    refetchIntervalInBackground: true,
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

  const k = useLanding(landing, Boolean(data && access.data && session.data));
  // Read until the landing is over and the file's checks are in.
  const reading = data && data.draft.state === 'draft' && (k < READ_DONE || stillReading(data)) ? k : null;
  const isReading = reading !== null;
  // Once it has landed, a reload shouldn't land it again.
  useEffect(() => {
    if (landing && data && !isReading) navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [landing, data, isReading, navigate, location.pathname, location.search]);

  const number = data?.draft.fields.find((f) => f.key === 'invoiceNumber')?.value?.toString() || null;
  // A bill still being read, or one nothing could be read from, is a new bill until it has a number.
  const fresh = isReading || Boolean(data?.draft.unreadable);
  const stage = data && !fresh ? headerOf(data, fieldsFrom(data.draft)).stageText : null;
  const reference = !data ? null
    : fresh ? (number && (reading === null || reading >= landsAt('invoiceNumber')) ? number : 'New bill')
    : number || data.draft.vendor.name;

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
            <span className={reference === 'New bill' ? undefined : 'bp-crumb-inv'}>{reference}</span>
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
          reading={reading}
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
