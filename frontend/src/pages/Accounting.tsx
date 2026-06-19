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
import { Ico } from '../dec/icons';

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

  return (
    <div className="stack stack-24">
      <PageHead
        eyebrow="Integrations"
        title="Accounting"
        desc="Connect QuickBooks Online. Settled payments post automatically as a bill and a bill payment."
        actions={
          connected && isAdmin ? (
            <button
              className="btn btn-danger-ghost btn-sm"
              onClick={() => disconnectMutation.mutate()}
              disabled={disconnectMutation.isPending}
            >
              Disconnect
            </button>
          ) : null
        }
      />

      {/* Connection */}
      <div className="panel">
        <div className="field-label-row">
          <span className="field-label">QuickBooks Online</span>
          {connected ? <Pill tone="success">Connected</Pill> : <Pill tone="neutral">Not connected</Pill>}
        </div>
        {connected ? (
          <p className="input-help">
            Company realm <span className="mono">{status?.realmId}</span> · {status?.environment} environment.
          </p>
        ) : (
          <>
            <p className="input-help">
              Connect your QuickBooks company so settled payments flow into your books automatically.
            </p>
            {isAdmin ? (
              <button
                className="btn btn-primary"
                onClick={() => connectMutation.mutate()}
                disabled={connectMutation.isPending}
                style={{ marginTop: 12 }}
              >
                <Ico.link w={16} /> Connect QuickBooks
              </button>
            ) : (
              <p className="input-help">Ask an organization admin to connect QuickBooks.</p>
            )}
          </>
        )}
      </div>

      {/* Account mapping */}
      {connected ? (
        <div className="panel">
          <div className="field-label-row">
            <span className="field-label">Account mapping</span>
            {status?.mappingComplete ? <Pill tone="success">Complete</Pill> : <Pill tone="warning">Incomplete</Pill>}
          </div>
          <p className="input-help">
            Which GL accounts each payment posts to. The clearing account stands in for your on-chain
            treasury; the expense account codes the bill.
          </p>

          <div className="stack stack-16" style={{ marginTop: 14, maxWidth: 520 }}>
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
                <button className="btn btn-primary btn-sm" onClick={() => saveMutation.mutate()} disabled={!canSave}>
                  Save mapping
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Sync health */}
      {connected ? (
        <div className="panel">
          <span className="field-label">Sync health</span>
          <p className="input-help">Settled payments post automatically. Failures retry on their own.</p>
          <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
            <Pill tone="success">{counts.synced} synced</Pill>
            <Pill tone="warning">{counts.pending} pending</Pill>
            <Pill tone={counts.error > 0 ? 'danger' : 'neutral'}>{counts.error} error</Pill>
          </div>
        </div>
      ) : null}
    </div>
  );
}
