// Accounting — the home for GL integrations (QuickBooks Online today). Connect
// the customer's books, map the key accounts, and watch sync health. Settled
// payments are posted automatically by the backend sync agent.

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type { AuthenticatedSession } from '../types';
import { useToast } from '../ui/Toast';
import { Pill, PageHead } from '../dec/primitives';

export function AccountingPage({ session }: { session: AuthenticatedSession }) {
  const { organizationId } = useParams<{ organizationId: string }>();
  const orgId = organizationId!;
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();

  const membership = useMemo(
    () => session.organizations.find((o) => o.organizationId === orgId),
    [session.organizations, orgId],
  );
  const isAdmin = membership?.role === 'owner' || membership?.role === 'admin';

  const statusQuery = useQuery({
    queryKey: ['accounting-status', orgId] as const,
    queryFn: () => api.getAccountingStatus(orgId),
    enabled: Boolean(orgId),
  });
  const status = statusQuery.data;
  const connected = Boolean(status?.connected);

  const accountsQuery = useQuery({
    queryKey: ['quickbooks-accounts', orgId] as const,
    queryFn: () => api.listQuickBooksAccounts(orgId),
    enabled: connected,
  });
  const accounts = accountsQuery.data?.items ?? [];

  // After the OAuth redirect we land back with ?quickbooks=connected — toast it
  // and strip the param.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const qb = params.get('quickbooks');
    if (!qb) return;
    if (qb === 'connected') success('QuickBooks connected.');
    else toastError(`QuickBooks ${qb}.`);
    params.delete('quickbooks');
    params.delete('detail');
    const rest = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : ''));
    void statusQuery.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connectMutation = useMutation({
    mutationFn: () => api.getQuickBooksConnectUrl(orgId),
    onSuccess: (r) => {
      window.location.href = r.authorizeUrl;
    },
    onError: (e) => toastError(e instanceof Error ? e.message : 'Could not start the connection.'),
  });

  const disconnectMutation = useMutation({
    mutationFn: () => api.disconnectQuickBooks(orgId),
    onSuccess: () => {
      success('QuickBooks disconnected.');
      void queryClient.invalidateQueries({ queryKey: ['accounting-status', orgId] });
    },
    onError: (e) => toastError(e instanceof Error ? e.message : 'Could not disconnect.'),
  });

  const [clearingId, setClearingId] = useState('');
  const [expenseId, setExpenseId] = useState('');
  const [apId, setApId] = useState('');
  useEffect(() => {
    if (status?.accountMap) {
      setClearingId(status.accountMap.clearingAccountId ?? '');
      setExpenseId(status.accountMap.defaultExpenseAccountId ?? '');
      setApId(status.accountMap.apAccountId ?? '');
    }
  }, [status?.accountMap]);

  const bankAccounts = accounts.filter((a) => a.accountType === 'Bank');
  const expenseAccounts = accounts.filter((a) => a.classification === 'Expense');
  const apAccounts = accounts.filter((a) => a.accountType === 'Accounts Payable');

  const saveMutation = useMutation({
    mutationFn: () => {
      const named = (id: string) => accounts.find((a) => a.id === id)?.name ?? null;
      return api.saveQuickBooksAccountMap(orgId, {
        clearingAccountId: clearingId,
        clearingAccountName: named(clearingId),
        defaultExpenseAccountId: expenseId,
        defaultExpenseAccountName: named(expenseId),
        apAccountId: apId || null,
        apAccountName: apId ? named(apId) : null,
      });
    },
    onSuccess: () => {
      success('Account mapping saved.');
      void queryClient.invalidateQueries({ queryKey: ['accounting-status', orgId] });
    },
    onError: (e) => toastError(e instanceof Error ? e.message : 'Could not save the mapping.'),
  });

  const counts = status?.syncCounts ?? { synced: 0, pending: 0, error: 0 };
  const canSave = Boolean(clearingId && expenseId) && !saveMutation.isPending;
  const muted = { color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.55 } as const;

  return (
    <div className="page">
      <div className="stack stack-24">
        <PageHead
          eyebrow="Integrations"
          title="Accounting"
          desc="Connect QuickBooks Online. Settled payments post automatically as a bill and a bill payment."
          actions={
            connected && isAdmin ? (
              <button
                type="button"
                className="btn btn-danger-ghost btn-sm"
                onClick={() => disconnectMutation.mutate()}
                disabled={disconnectMutation.isPending}
              >
                Disconnect
              </button>
            ) : undefined
          }
        />

        {/* Connection */}
        <div className="tbl-card" style={{ padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <img src="/quickbooks.svg" alt="" style={{ width: 18, height: 18 }} />
              <strong style={{ fontSize: 14 }}>QuickBooks Online</strong>
            </span>
            {connected ? <Pill tone="success">Connected</Pill> : <Pill tone="neutral">Not connected</Pill>}
          </div>
          {connected ? (
            <p style={{ ...muted, margin: '10px 0 0' }}>
              Company realm <span className="mono">{status?.realmId}</span> · {status?.environment} environment.
            </p>
          ) : (
            <>
              <p style={{ ...muted, margin: '10px 0 14px' }}>
                Connect your QuickBooks company so settled payments flow into your books automatically.
              </p>
              {isAdmin ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => connectMutation.mutate()}
                  disabled={connectMutation.isPending}
                >
                  <img src="/quickbooks.svg" alt="" style={{ width: 16, height: 16 }} />Connect QuickBooks
                </button>
              ) : (
                <p style={muted}>Ask an organization admin to connect QuickBooks.</p>
              )}
            </>
          )}
        </div>

        {/* Account mapping */}
        {connected ? (
          <div>
            <div className="sec-head">
              <div className="sh-titles">
                <h2>Account mapping</h2>
                <p className="sh-desc">
                  Which GL accounts each payment posts to. The clearing account stands in for your
                  on-chain treasury; the expense account codes the bill.
                </p>
              </div>
              {status?.mappingComplete ? (
                <Pill tone="success">Complete</Pill>
              ) : (
                <Pill tone="warning">Incomplete</Pill>
              )}
            </div>

            <div className="tbl-card" style={{ padding: 18 }}>
              <div style={{ display: 'grid', gap: 14, maxWidth: 520 }}>
                <label className="field">
                  <span className="field-label">Clearing account (bank)</span>
                  <select className="input" value={clearingId} onChange={(e) => setClearingId(e.target.value)} disabled={!isAdmin}>
                    <option value="">Select a bank account…</option>
                    {bankAccounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </label>

                <label className="field">
                  <span className="field-label">Default expense account</span>
                  <select className="input" value={expenseId} onChange={(e) => setExpenseId(e.target.value)} disabled={!isAdmin}>
                    <option value="">Select an expense account…</option>
                    {expenseAccounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </label>

                <label className="field">
                  <span className="field-label">Accounts Payable (optional)</span>
                  <select className="input" value={apId} onChange={(e) => setApId(e.target.value)} disabled={!isAdmin}>
                    <option value="">Use the company default</option>
                    {apAccounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </label>

                {isAdmin ? (
                  <div>
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => saveMutation.mutate()} disabled={!canSave}>
                      Save mapping
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {/* Sync health */}
        {connected ? (
          <div>
            <div className="sec-head">
              <div className="sh-titles">
                <h2>Sync health</h2>
                <p className="sh-desc">Settled payments post automatically. Failures retry on their own.</p>
              </div>
            </div>
            <div className="metrics" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
              <div className="metric">
                <div className="m-label">Synced</div>
                <div className="m-value">{counts.synced}</div>
                <div className="m-sub">posted to QuickBooks</div>
              </div>
              <div className="metric">
                <div className="m-label">Pending</div>
                <div className="m-value">{counts.pending}</div>
                <div className="m-sub">awaiting sync</div>
              </div>
              <div className="metric">
                <div className="m-label">Errors</div>
                <div className="m-value">{counts.error}</div>
                <div className="m-sub">auto-retrying</div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
