// Organisation's Exceptions: bills that went through with a policy set aside,
// approved by whoever sent them or allowed over the ceiling. A record to read;
// the rows lead nowhere.
import { useQuery } from '@tanstack/react-query';
import { policiesApi, type PolicyException } from '../../api';
import { Avatar } from '../../kit/Avatar';
import { Cells } from '../../kit/Cells';
import { firstName, fullDay, usd } from '../../kit/format';
import { Failed, Heading } from './parts';

function whyOf(x: PolicyException) {
  return x.kind === 'self_approval'
    ? `${firstName(x.approvedBy.name)} sent it; No self-approval was off for them`
    : `Over the ceiling; ${x.allowedByName ?? 'the primary admin'} allowed it`;
}

export function Exceptions({ organizationId }: { organizationId: string }) {
  const query = useQuery({
    queryKey: ['policy-exceptions', organizationId],
    queryFn: () => policiesApi.exceptions(organizationId),
    enabled: Boolean(organizationId),
  });
  const items = query.data?.items ?? [];

  return (
    <section>
      <Heading title="Exceptions" count={query.isSuccess ? items.length : undefined} tight />
      <p className="st-sub">Bills approved while No self-approval was off for whoever sent them, or allowed over the ceiling.</p>
      {!query.isSuccess ? (
        query.isError ? (
          <div className="st-rows">
            <Failed what="Exceptions" retry={() => void query.refetch()} />
          </div>
        ) : null
      ) : items.length === 0 ? (
        <div className="st-rows">
          <div className="st-empty">No exceptions.</div>
        </div>
      ) : (
        <div className="st-ex">
          <div className="bl-head">
            <Cells>
              <span className="bl-th">VENDOR</span>
              <span className="bl-th">INVOICE</span>
              <span className="bl-th is-end">AMOUNT</span>
              <span className="bl-th">APPROVED BY</span>
              <span className="bl-th">WHY</span>
              <span className="bl-th">APPROVED</span>
            </Cells>
          </div>
          {items.map((x) => {
            const why = whyOf(x);
            return (
              <div key={`${x.kind}-${x.paymentOrderId}`} className="bl-row">
                <Cells>
                  <span className="bl-td bl-vendor">{x.vendorName}</span>
                  <span className="bl-td bl-inv num">{x.invoiceNumber ?? '—'}</span>
                  <span className="bl-td is-end bl-amt num">{usd(Number(x.amountRaw) / 1_000_000)}</span>
                  <span className="bl-td st-who">
                    <Avatar name={x.approvedBy.name} src={x.approvedBy.avatarUrl} size={16} />
                    {x.approvedBy.name}
                  </span>
                  <span className="bl-td st-why" title={why}>
                    <span>{why}</span>
                  </span>
                  <span className="bl-td bl-due num">{fullDay(x.approvedAt)}</span>
                </Cells>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
