// Vendors (Vendors.dc.html 1a): every company the organisation gets bills from,
// in one table. A vendor arrives with its first bill, so there is no way to add
// one here; its page (Vendor.tsx) holds everything else about it.
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, billsApi } from '../api';
import { Cells } from '../kit/Cells';
import { fullDay } from '../kit/format';
import { Icon } from '../kit/icons';
import { holdTitle, locationOf, vendorMatches, vendorRows, type VendorRow } from './vendorRows';

type Tab = 'all' | 'held' | 'new';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'held', label: 'On hold' },
  { key: 'new', label: 'New' },
];

const EMPTY: Record<Tab, string> = {
  all: 'No vendors yet. A vendor appears when its first bill arrives.',
  held: 'No vendors are on hold.',
  new: 'No new vendors.',
};

function inTab(row: VendorRow, tab: Tab) {
  if (tab === 'held') return Boolean(row.hold);
  if (tab === 'new') return row.isNew;
  return true;
}

export function VendorsPage() {
  const { organizationId = '' } = useParams();
  const session = useQuery({ queryKey: ['session'], queryFn: () => api.getSession(), staleTime: Infinity });
  const vendors = useQuery({
    queryKey: ['counterparties', organizationId],
    queryFn: () => api.listCounterparties(organizationId),
    enabled: Boolean(organizationId),
  });
  const workbench = useQuery({
    queryKey: ['bills-workbench', organizationId],
    queryFn: () => billsApi.workbench(organizationId),
    enabled: Boolean(organizationId),
  });

  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');

  const orgName =
    session.data?.organizations.find((o) => o.organizationId === organizationId)?.organizationName ?? 'your organisation';
  const rows = useMemo(
    () => vendorRows(vendors.data?.items ?? [], workbench.data?.bills ?? []),
    [vendors.data, workbench.data],
  );
  const counts: Record<Tab, number> = {
    all: rows.length,
    held: rows.filter((r) => r.hold).length,
    new: rows.filter((r) => r.isNew).length,
  };
  const query = search.trim();
  const shown = rows.filter((r) => inTab(r, tab) && vendorMatches(r, query));
  const loaded = vendors.isSuccess && workbench.isSuccess;
  const failed = vendors.isError || workbench.isError;

  return (
    <div className="ui list-page">
      <div className="list-head">
        <div style={{ minWidth: 0 }}>
          <h1 className="list-title">Vendors</h1>
          <div className="list-sub">Every company {orgName} gets bills from, and which are on hold.</div>
        </div>
      </div>

      {failed ? (
        <div className="bl-table">
          <div className="bl-empty vd-failed">
            Your vendors couldn’t be loaded.
            <button
              type="button"
              className="bl-showall"
              onClick={() => {
                void vendors.refetch();
                void workbench.refetch();
              }}
            >
              Try again
            </button>
          </div>
        </div>
      ) : !loaded ? null : (
        <>
          <div className="bl-bar">
            <div className="bl-stages" role="tablist" aria-label="Vendors">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  className={`bl-stage${tab === t.key ? ' is-on' : ''}`}
                  onClick={() => setTab(t.key)}
                >
                  {t.label}
                  <span className="bl-stage-n">{counts[t.key]}</span>
                </button>
              ))}
            </div>
            <div className="bl-tools">
              <label className="bl-search is-wide">
                <Icon.search size={11} />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search vendor or email"
                  aria-label="Search vendor or email"
                />
              </label>
            </div>
          </div>

          <div className="bl-table">
            <div className="bl-grid">
              <div className="bl-head">
                <Cells>
                  <span className="bl-th">VENDOR</span>
                  <span className="bl-th">EMAIL</span>
                  <span className="bl-th">LOCATION</span>
                  <span className="bl-th is-end">BILLS</span>
                  <span className="bl-th">LATEST BILL</span>
                  <span className="bl-th">STATUS</span>
                </Cells>
              </div>
              {shown.map((row) => (
                <VendorLine key={row.vendor.counterpartyId} row={row} organizationId={organizationId} />
              ))}
            </div>
            {shown.length === 0 ? <div className="bl-empty">{query ? 'No vendors match.' : EMPTY[tab]}</div> : null}
          </div>
        </>
      )}
    </div>
  );
}

/** The six cells of a vendor's row with the five gaps between them. */
function VendorLine({ row, organizationId }: { row: VendorRow; organizationId: string }) {
  const latest = row.bills[0];
  const location = locationOf(row.address);
  return (
    <Link
      to={`/organizations/${organizationId}/counterparties/${row.vendor.counterpartyId}`}
      className="bl-row"
      title={`Opens ${row.vendor.displayName}`}
    >
      <Cells>
        <span className="bl-td bl-vendor">{row.vendor.displayName}</span>
        <span className={`bl-td bl-desc${row.email ? '' : ' vd-none'}`}>{row.email ?? '—'}</span>
        <span className={`bl-td bl-desc${location ? '' : ' vd-none'}`}>{location ?? '—'}</span>
        <span className="bl-td is-end bl-amt num">{row.bills.length}</span>
        <span className="bl-td vd-latest">
          {latest ? (
            <>
              <span className="num">{fullDay(latest.createdAt)}</span>
              {latest.invoiceNumber ? (
                <span className="bl-inv num">{latest.invoiceNumber}</span>
              ) : (
                <span className="vd-nonum">No number</span>
              )}
            </>
          ) : null}
        </span>
        <span className="bl-td">
          {row.hold ? (
            <span className="chip is-hold" title={holdTitle(row.hold, fullDay)}>
              {row.hold.status === 'blocked' ? 'Blocked' : 'On hold'}
            </span>
          ) : row.isNew ? (
            <span className="vd-new">New</span>
          ) : null}
        </span>
      </Cells>
    </Link>
  );
}
