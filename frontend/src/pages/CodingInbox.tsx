// Coding inbox — the one place GL coding happens. A table of settled payments not yet
// in QuickBooks; click a row to open the coding form in a modal: edit the Bill header
// (vendor / invoice # / bill date / total), then code the lines (account from a search
// or a suggestion chip → description → amount), split with "Add line", and the balance
// bar must hit the total before you Save. "Sync coded" pushes the coded batch.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type CodingInboxItem } from '../api';
import type { AuthenticatedSession } from '../types';
import { useToast } from '../ui/Toast';
import { Ico } from '../dec/icons';
import { PageHead, Pill } from '../dec/primitives';

type FormLine = { accountId: string; accountName: string; amount: string; description: string };

const colHead = { fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const, color: 'var(--text-muted)' };
const LINE_COLS = 'minmax(0,1fr) minmax(0,1fr) 110px 28px';
const CANDIDATE_REASON: Record<string, string> = {
  vendor_history: "From this vendor's past coding",
  ocr: 'From the invoice',
  frequent: 'Commonly used here',
  default: 'Default account',
};

export function CodingInboxPage({ session: _session }: { session: AuthenticatedSession }) {
  const { organizationId } = useParams<{ organizationId: string }>();
  const orgId = organizationId!;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { success, error: toastError } = useToast();

  const [openRow, setOpenRow] = useState<CodingInboxItem | null>(null);
  const [vendor, setVendor] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [billDate, setBillDate] = useState('');
  const [total, setTotal] = useState('');
  const [lines, setLines] = useState<FormLine[]>([]);

  // Esc closes the dialog (the .dialog structure has no built-in handler).
  useEffect(() => {
    if (!openRow) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenRow(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openRow]);

  const inboxQuery = useQuery({ queryKey: ['coding-inbox', orgId] as const, queryFn: () => api.listCodingInbox(orgId), enabled: Boolean(orgId) });
  const accountsQuery = useQuery({ queryKey: ['qbo-accounts', orgId] as const, queryFn: () => api.listQuickBooksAccounts(orgId), enabled: Boolean(orgId), retry: false, staleTime: 5 * 60 * 1000 });
  const syncedQuery = useQuery({ queryKey: ['coding-synced', orgId] as const, queryFn: () => api.listSyncedPayments(orgId), enabled: Boolean(orgId) });
  const synced = syncedQuery.data?.items ?? [];

  const rows = inboxQuery.data?.items ?? [];
  const expenseAccounts = (accountsQuery.data?.items ?? []).filter((a) => a.classification === 'Expense');
  const accountByName = useMemo(() => new Map(expenseAccounts.map((a) => [a.name, a])), [expenseAccounts]);
  const codedCount = useMemo(() => rows.filter((r) => r.coding).length, [rows]);
  const toCodeCount = rows.length - codedCount;

  function openCoder(row: CodingInboxItem) {
    setOpenRow(row);
    const h = row.coding?.billHeader ?? {};
    const existing = row.coding?.lines ?? [];
    setVendor(h.vendorName ?? row.vendorLabel ?? '');
    setInvoiceNo(h.invoiceNumber ?? row.invoiceNumber ?? '');
    setBillDate(h.billDate ?? new Date(row.createdAt).toISOString().slice(0, 10));
    // Total is the on-chain payment amount — fixed, not editable. Lines must sum to it.
    setTotal(row.amountUsdc.toFixed(2));
    setLines(
      existing.length
        ? existing.map((l) => ({ accountId: l.accountId, accountName: l.accountName ?? '', amount: String(l.amount), description: l.description ?? '' }))
        : [{ accountId: '', accountName: '', amount: row.amountUsdc.toFixed(2), description: '' }],
    );
  }

  const billTotal = Number(total) || 0;
  const codedSum = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const diff = Math.round((billTotal - codedSum) * 100) / 100;
  const balanced = Math.abs(diff) < 0.005;
  const canSave = balanced && billTotal > 0 && lines.length > 0 && lines.every((l) => l.accountId);

  const setLine = (i: number, patch: Partial<FormLine>) => setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const setLineByName = (i: number, name: string) => setLine(i, { accountName: name, accountId: accountByName.get(name)?.id ?? '' });
  const addLine = () => {
    const remaining = Math.max(0, Math.round((billTotal - codedSum) * 100) / 100);
    setLines((ls) => [...ls, { accountId: '', accountName: '', amount: remaining.toFixed(2), description: '' }]);
  };
  const removeLine = (i: number) => setLines((ls) => ls.filter((_, idx) => idx !== i));

  const confirmMutation = useMutation({
    mutationFn: () =>
      api.setPaymentOrderGlCoding(orgId, openRow!.paymentOrderId, {
        lines: lines.map((l) => ({ accountId: l.accountId, accountName: l.accountName || null, amount: Number(l.amount) || 0, description: l.description.trim() || null })),
        billHeader: { vendorName: vendor.trim() || null, invoiceNumber: invoiceNo.trim() || null, billDate: billDate || null },
        predictedAccountId: openRow!.candidates[0]?.accountId ?? null,
        predictedAccountName: openRow!.candidates[0]?.accountName ?? null,
        predictionSource: openRow!.candidates[0]?.reason ?? null,
      }),
    onSuccess: () => {
      success('Coded.');
      setOpenRow(null);
      void queryClient.invalidateQueries({ queryKey: ['coding-inbox', orgId] });
    },
    onError: (e) => toastError(e instanceof Error ? e.message : 'Could not code this payment.'),
  });

  const syncMutation = useMutation({
    mutationFn: () => api.syncCodedPayments(orgId),
    onSuccess: (r) => {
      if (r.error) toastError(`Synced ${r.synced}, ${r.error} failed.`);
      else success(`Synced ${r.synced} to QuickBooks.`);
      void queryClient.invalidateQueries({ queryKey: ['coding-inbox', orgId] });
      void queryClient.invalidateQueries({ queryKey: ['coding-synced', orgId] });
    },
    onError: (e) => toastError(e instanceof Error ? e.message : 'Sync failed.'),
  });

  const muted = { color: 'var(--text-muted)' } as const;

  // One unified list — to-code, coded, and synced — with a status filter + search,
  // like the Payments table. Inbox rows carry their item so a click opens the coder.
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'to_code' | 'coded' | 'synced'>('all');
  type UnifiedRow = {
    paymentOrderId: string;
    vendor: string;
    amountUsdc: number;
    invoiceNumber: string | null;
    date: string;
    status: 'to_code' | 'coded' | 'synced';
    account: string | null;
    inboxItem?: CodingInboxItem;
  };
  const allRows = useMemo<UnifiedRow[]>(() => {
    const fromInbox = rows.map((item): UnifiedRow => ({
      paymentOrderId: item.paymentOrderId,
      vendor: item.vendorLabel ?? 'Unknown vendor',
      amountUsdc: item.amountUsdc,
      invoiceNumber: item.invoiceNumber,
      date: item.createdAt,
      status: item.coding ? 'coded' : 'to_code',
      account: item.coding ? (item.coding.lines.length > 1 ? `${item.coding.lines.length} lines` : item.coding.accountName ?? item.coding.accountId) : null,
      inboxItem: item,
    }));
    const fromSynced = synced.map((s): UnifiedRow => ({
      paymentOrderId: s.paymentOrderId,
      vendor: s.vendor,
      amountUsdc: Number(s.amountRaw) / 1e6,
      invoiceNumber: s.invoiceNumber,
      date: s.syncedAt ?? '',
      status: 'synced',
      account: s.account,
    }));
    return [...fromInbox, ...fromSynced];
  }, [rows, synced]);
  const filteredRows = useMemo(() => {
    let out = allRows;
    if (filter !== 'all') out = out.filter((r) => r.status === filter);
    const q = search.trim().toLowerCase();
    if (q) out = out.filter((r) => r.vendor.toLowerCase().includes(q) || (r.invoiceNumber ?? '').toLowerCase().includes(q));
    return out;
  }, [allRows, filter, search]);

  return (
    <div className="page">
      <div className="stack stack-24">
        <PageHead
          eyebrow="Accounting"
          title="Coding inbox"
          desc="Assign an expense account to each settled payment, then sync the coded batch to QuickBooks."
          actions={
            <button type="button" className="btn btn-primary" onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending || codedCount === 0}>
              <Ico.download w={15} />
              {syncMutation.isPending ? 'Syncing…' : `Sync ${codedCount} coded`}
            </button>
          }
        />

        <div className="metrics" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className="metric"><div className="m-label">To code</div><div className="m-value">{toCodeCount}</div><div className="m-sub">need an account</div></div>
          <div className="metric"><div className="m-label">Coded</div><div className="m-value">{codedCount}</div><div className="m-sub">ready to sync</div></div>
          <div className="metric"><div className="m-label">Synced</div><div className="m-value">{synced.length}</div><div className="m-sub">posted to QuickBooks</div></div>
        </div>

        <div className="filterbar">
          <div className="tabs">
            {([
              ['all', 'All', allRows.length] as const,
              ['to_code', 'To code', toCodeCount] as const,
              ['coded', 'Coded', codedCount] as const,
              ['synced', 'Synced', synced.length] as const,
            ]).map(([key, label, count]) => (
              <button key={key} type="button" className={`tab${filter === key ? ' on' : ''}`} onClick={() => setFilter(key)}>
                {label}<span className="tab-count">{count}</span>
              </button>
            ))}
          </div>
          <div className="filter-right">
            <div className="input-search">
              <Ico.search w={14} />
              <input className="input" placeholder="Vendor or invoice #" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>
        </div>

        <div className="tbl-card">
          {inboxQuery.isLoading ? (
            <div style={{ padding: 16 }}>
              <div className="skeleton" style={{ height: 44, marginBottom: 6 }} />
              <div className="skeleton" style={{ height: 44 }} />
            </div>
          ) : accountsQuery.isError ? (
            <div className="empty">
              <div className="empty-icon"><Ico.book w={22} /></div>
              <h4>Connect QuickBooks first</h4>
              <p>Coding needs your chart of accounts. Connect QuickBooks on the Accounting page.</p>
            </div>
          ) : allRows.length === 0 ? (
            <div className="empty">
              <div className="empty-icon"><Ico.inbox w={22} /></div>
              <h4>Nothing here yet</h4>
              <p>Settled payments land here to be coded and synced to QuickBooks.</p>
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="empty">
              <div className="empty-icon"><Ico.search w={22} /></div>
              <h4>No matches</h4>
              <p>Try a different filter or search term.</p>
            </div>
          ) : (
            <table className="tbl">
              <thead>
                <tr><th>Vendor</th><th className="num">Amount</th><th>Date</th><th>Invoice</th><th>Status</th></tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => (
                  <tr
                    key={row.paymentOrderId}
                    onClick={() => (row.status === 'synced' ? navigate(`/organizations/${orgId}/payments/${row.paymentOrderId}`) : openCoder(row.inboxItem!))}
                    style={{ cursor: 'pointer' }}
                  >
                    <td><strong>{row.vendor}</strong></td>
                    <td className="num" style={{ fontFamily: 'var(--font-mono)' }}>{row.amountUsdc.toFixed(2)} USDC</td>
                    <td style={muted}>{row.date ? new Date(row.date).toLocaleDateString() : '—'}</td>
                    <td style={muted}>{row.invoiceNumber ?? '—'}</td>
                    <td>
                      {row.status === 'to_code' ? (
                        <Pill tone="warning">Needs coding</Pill>
                      ) : (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          <Pill tone={row.status === 'synced' ? 'success' : 'info'}>{row.status === 'synced' ? 'Synced' : 'Coded'}</Pill>
                          {row.account ? <span>{row.account}</span> : null}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {openRow ? (
        <div className="overlay" style={{ position: 'fixed', inset: 0, zIndex: 60 }} onClick={(e) => { if (e.target === e.currentTarget) setOpenRow(null); }}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dec-coding-title" style={{ width: 760, maxHeight: 'calc(100vh - 48px)' }}>
            <div className="dialog-head">
              <div>
                <h2 id="dec-coding-title">Code payment</h2>
                <p style={{ maxWidth: 'none' }}>Assign accounts before this settled payment posts to QuickBooks.</p>
              </div>
              <button type="button" className="drawer-x" onClick={() => setOpenRow(null)} aria-label="Close">×</button>
            </div>

            <div className="dialog-body" style={{ overflowY: 'auto' }}>
            <datalist id="exp-accts">{expenseAccounts.map((a) => <option key={a.id} value={a.name} />)}</datalist>

            {/* Bill header — vendor / invoice / date editable; total is the fixed payment amount */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div className="field"><div className="field-label">Vendor</div><input className="input" value={vendor} onChange={(e) => setVendor(e.target.value)} /></div>
              <div className="field"><div className="field-label">Invoice #</div><input className="input" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} placeholder="(optional)" /></div>
              <div className="field"><div className="field-label">Bill date</div><input className="input" type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} /></div>
              <div className="field"><div className="field-label">Total</div><input className="input" type="text" readOnly value={total} title="Matches the on-chain payment" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', cursor: 'default' }} /></div>
            </div>

            <div style={{ borderTop: '1px solid var(--border)' }} />

            {/* lines — column headers sit tight above the inputs */}
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: LINE_COLS, gap: 10, marginBottom: 6 }}>
                <span style={colHead}>Account</span>
                <span style={colHead}>Description</span>
                <span style={{ ...colHead, textAlign: 'right' }}>Amount</span>
                <span />
              </div>
              {lines.map((line, i) => (
              <div key={i} style={{ marginTop: i > 0 ? 14 : 0 }}>
                <div style={{ display: 'grid', gridTemplateColumns: LINE_COLS, gap: 10, alignItems: 'center' }}>
                  <input className="input" list="exp-accts" value={line.accountName} onChange={(e) => setLineByName(i, e.target.value)} placeholder="Search account…" />
                  <input className="input" value={line.description} onChange={(e) => setLine(i, { description: e.target.value })} placeholder="(optional)" />
                  <input className="input" type="number" step="0.01" min="0" style={{ fontFamily: 'var(--font-mono)', textAlign: 'right' }} value={line.amount} onChange={(e) => setLine(i, { amount: e.target.value })} />
                  {lines.length > 1 ? (
                    <button type="button" onClick={() => removeLine(i)} aria-label="Remove line" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 18, lineHeight: 1, padding: 4 }}>×</button>
                  ) : <span />}
                </div>
                {openRow.candidates.length > 0 ? (
                  <div style={{ marginTop: 7, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ ...muted, fontSize: 12 }}>Suggested</span>
                    {openRow.candidates.map((c) => {
                      const on = line.accountId === c.accountId;
                      return (
                        <button
                          key={c.accountId}
                          type="button"
                          title={
                            c.reason === 'ocr' && c.rationale
                              ? `From the invoice — ${c.rationale}${typeof c.weight === 'number' ? ` (${Math.round(c.weight * 100)}% sure)` : ''}`
                              : CANDIDATE_REASON[c.reason]
                          }
                          onClick={() => setLine(i, { accountId: c.accountId, accountName: c.accountName ?? '' })}
                          style={{
                            borderRadius: 999,
                            border: `1px solid ${on ? 'var(--primary)' : 'color-mix(in srgb, var(--primary) 28%, transparent)'}`,
                            background: 'color-mix(in srgb, var(--primary) 9%, transparent)',
                            color: 'var(--primary)',
                            fontSize: 12,
                            fontWeight: on ? 600 : 500,
                            padding: '3px 11px',
                            lineHeight: 1.5,
                            cursor: 'pointer',
                          }}
                        >
                          {c.accountName ?? c.accountId}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
              ))}
            </div>

            <div>
              <button type="button" className="btn btn-secondary btn-sm" onClick={addLine}>+ Add line (split)</button>
            </div>

            {/* balance bar */}
            <div style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>Lines {codedSum.toFixed(2)} / Bill {billTotal.toFixed(2)} USDC</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>diff {diff.toFixed(2)}</span>
                {balanced ? <Pill tone="success">Balanced</Pill> : <Pill tone="warning">Off by {Math.abs(diff).toFixed(2)}</Pill>}
              </span>
            </div>
            </div>

            <div className="dialog-foot" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setOpenRow(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={!canSave || confirmMutation.isPending} onClick={() => confirmMutation.mutate()}>
                {confirmMutation.isPending ? 'Saving…' : 'Save coding'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
