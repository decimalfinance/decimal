import type { FormEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type AuthenticatedSession, type UserWallet } from '../api';
import { formatRawUsdcCompact } from '../domain';
import { ChainLink } from '../ui-primitives';
import { useToast } from '../ui/Toast';
import {
  getFormString,
  getOptionalFormString,
  queryKeys,
} from '../lib/app-helpers';

const PROFILE_LAMPORTS_PER_SOL = 1_000_000_000n;

// Lamports (string from API) -> human SOL with 4 decimal places.
// Inline duplicate of the same helper in pages/Wallets.tsx; small enough
// to not warrant hoisting yet.
function formatSolFromLamports(lamports: string): string {
  let value: bigint;
  try {
    value = BigInt(lamports);
  } catch {
    return '0.0000';
  }
  const whole = value / PROFILE_LAMPORTS_PER_SOL;
  const fractional = value % PROFILE_LAMPORTS_PER_SOL;
  const fracPadded = fractional.toString().padStart(9, '0').slice(0, 4);
  return `${whole.toString()}.${fracPadded}`;
}

export function ProfilePage({ session }: { session: AuthenticatedSession }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { success, error: toastError } = useToast();
  const [createPersonalWalletOpen, setCreatePersonalWalletOpen] = useState(false);
  const [createOrgOpen, setCreateOrgOpen] = useState(false);
  const [transferWallet, setTransferWallet] = useState<UserWallet | null>(null);
  const [airdropWallet, setAirdropWallet] = useState<UserWallet | null>(null);
  const [deleteWallet, setDeleteWallet] = useState<UserWallet | null>(null);

  const personalWalletBalancesQuery = useQuery({
    queryKey: ['personal-wallet-balances'] as const,
    queryFn: () => api.listPersonalWalletBalances(),
    refetchInterval: 15_000,
  });
  const balancesByWalletId = useMemo(() => {
    const map = new Map<string, { solLamports: string; usdcRaw: string | null; rpcError: string | null }>();
    for (const b of personalWalletBalancesQuery.data?.items ?? []) {
      map.set(b.userWalletId, {
        solLamports: b.solLamports,
        usdcRaw: b.usdcRaw,
        rpcError: b.rpcError,
      });
    }
    return map;
  }, [personalWalletBalancesQuery.data]);

  const personalWalletsQuery = useQuery({
    queryKey: ['personal-wallets'] as const,
    queryFn: () => api.listPersonalWallets(),
  });

  const createOrganizationMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const organizationName = getFormString(formData, 'organizationName');
      if (!organizationName) throw new Error('Organization name is required.');
      return api.createOrganization({ organizationName });
    },
    onSuccess: async (organization) => {
      success('Organization created.');
      setCreateOrgOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys().session });
      navigate(`/organizations/${organization.organizationId}`);
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Unable to create organization.'),
  });

  const createPersonalWalletMutation = useMutation({
    mutationFn: (formData: FormData) => {
      const label = getOptionalFormString(formData, 'label');
      return api.createPersonalWalletManaged({
        provider: 'privy',
        label: label || undefined,
      });
    },
    onSuccess: async () => {
      success('Personal wallet created.');
      setCreatePersonalWalletOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['personal-wallets'] });
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Unable to create personal wallet.'),
  });

  const airdropMutation = useMutation({
    mutationFn: (input: { userWalletId: string; amountSol: number }) =>
      api.airdropSolToPersonalWallet(input.userWalletId, { amountSol: input.amountSol }),
    onSuccess: async (result) => {
      success(`Airdropped ${result.amountSol} devnet SOL.`);
      setAirdropWallet(null);
      await queryClient.invalidateQueries({ queryKey: ['personal-wallet-balances'] });
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Airdrop failed.'),
  });

  const deleteWalletMutation = useMutation({
    mutationFn: (input: { userWalletId: string }) =>
      api.deletePersonalWallet(input.userWalletId),
    onSuccess: async () => {
      success('Personal wallet deleted.');
      setDeleteWallet(null);
      await queryClient.invalidateQueries({ queryKey: ['personal-wallets'] });
      await queryClient.invalidateQueries({ queryKey: ['personal-wallet-balances'] });
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Could not delete wallet.'),
  });

  const transferOutMutation = useMutation({
    mutationFn: (input: { userWalletId: string; recipient: string; amountRaw: string; asset: 'sol' | 'usdc' }) =>
      api.transferOutPersonalWallet(input.userWalletId, {
        recipient: input.recipient,
        amountRaw: input.amountRaw,
        asset: input.asset,
      }),
    onSuccess: (result) => {
      success(
        `Transfer submitted (signature ${result.signature.slice(0, 8)}…${result.signature.slice(-6)}).`,
      );
      setTransferWallet(null);
    },
    onError: (err) => toastError(err instanceof Error ? err.message : 'Transfer failed.'),
  });

  const personalWallets = personalWalletsQuery.data?.items ?? [];
  const organizations = session.organizations;
  const isLoadingWallets = personalWalletsQuery.isLoading && personalWallets.length === 0;

  return (
    <main className="page-frame">
      <header className="page-header">
        <div>
          <p className="eyebrow">Account · {session.user.email}</p>
          <h1>Profile</h1>
          <p>Manage your identity, personal signing wallets, and organizations.</p>
        </div>
      </header>

      <div className="rd-metrics">
        <div className="rd-metric">
          <span className="rd-metric-label">Personal wallets</span>
          <span className="rd-metric-value">{personalWallets.length}</span>
        </div>
        <div className="rd-metric">
          <span className="rd-metric-label">Organizations</span>
          <span className="rd-metric-value">{organizations.length}</span>
        </div>
        <div className="rd-metric">
          <span className="rd-metric-label">Display name</span>
          <span className="rd-metric-value" style={{ fontSize: 18 }}>
            {session.user.displayName || session.user.email.split('@')[0]}
          </span>
        </div>
      </div>

      <section className="rd-section" style={{ marginTop: 8 }}>
        <div className="rd-section-head">
          <div>
            <p className="eyebrow">Identity</p>
            <h2>Personal wallets</h2>
            <p style={{ margin: 0, color: 'var(--ax-text-muted)' }}>
              These wallets belong to you, not to any organization. Authorize one to act for a treasury account from the Treasury accounts page.
            </p>
          </div>
          <div>
            <button
              type="button"
              className="button button-primary"
              onClick={() => setCreatePersonalWalletOpen(true)}
            >
              + Create personal wallet
            </button>
          </div>
        </div>

        <div className="rd-table-shell" style={{ marginTop: 12 }}>
          {isLoadingWallets ? (
            <div style={{ padding: 16 }}>
              <div className="rd-skeleton rd-skeleton-block" style={{ height: 56, marginBottom: 8 }} />
              <div className="rd-skeleton rd-skeleton-block" style={{ height: 56 }} />
            </div>
          ) : personalWallets.length === 0 ? (
            <div className="rd-empty-cell" style={{ padding: '64px 24px' }}>
              <strong>Create your personal signing wallet</strong>
              <p style={{ margin: '0 0 16px' }}>
                This wallet belongs to you, not the organization. You can later authorize it to sign for any treasury account you have access to.
              </p>
              <button
                type="button"
                className="button button-primary"
                onClick={() => setCreatePersonalWalletOpen(true)}
              >
                + Create personal wallet
              </button>
            </div>
          ) : (
            <table className="rd-table">
              <thead>
                <tr>
                  <th style={{ width: '20%' }}>Name</th>
                  <th style={{ width: '22%' }}>Address</th>
                  <th className="rd-num" style={{ width: '12%' }}>SOL</th>
                  <th className="rd-num" style={{ width: '12%' }}>USDC</th>
                  <th style={{ width: '12%' }}>Status</th>
                  <th style={{ width: '22%', textAlign: 'right' }}>&nbsp;</th>
                </tr>
              </thead>
              <tbody>
                {personalWallets.map((wallet) => {
                  const bal = balancesByWalletId.get(wallet.userWalletId);
                  return (
                    <tr key={wallet.userWalletId}>
                      <td>
                        <div className="rd-payee-main">
                          <span className="rd-payee-name">
                            {wallet.label ?? 'Untitled wallet'}
                          </span>
                          <span className="rd-payee-ref" style={{ color: 'var(--ax-text-muted)' }}>
                            {wallet.provider ?? wallet.walletType}
                          </span>
                        </div>
                      </td>
                      <td>
                        <ChainLink address={wallet.walletAddress} />
                      </td>
                      <td className="rd-num">
                        {bal ? (
                          <span>{formatSolFromLamports(bal.solLamports)}</span>
                        ) : (
                          <span style={{ color: 'var(--ax-text-faint)' }}>—</span>
                        )}
                      </td>
                      <td className="rd-num">
                        {bal?.usdcRaw === null || bal?.usdcRaw === undefined ? (
                          <span style={{ color: 'var(--ax-text-faint)' }}>—</span>
                        ) : (
                          <span>{formatRawUsdcCompact(bal.usdcRaw)}</span>
                        )}
                      </td>
                      <td>
                        <span
                          className={
                            wallet.verifiedAt ? 'rd-pill rd-pill-success' : 'rd-pill rd-pill-warning'
                          }
                        >
                          {wallet.verifiedAt ? 'verified' : 'pending'}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {wallet.walletType === 'privy_embedded' ? (
                          <div style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}>
                            <button
                              type="button"
                              className="button button-secondary"
                              style={{ padding: '4px 10px', fontSize: 12 }}
                              onClick={() => setAirdropWallet(wallet)}
                            >
                              Airdrop
                            </button>
                            <button
                              type="button"
                              className="button button-secondary"
                              style={{ padding: '4px 10px', fontSize: 12 }}
                              onClick={() => setTransferWallet(wallet)}
                            >
                              Transfer
                            </button>
                            <button
                              type="button"
                              className="button button-secondary"
                              style={{
                                padding: '4px 10px',
                                fontSize: 12,
                                color: 'var(--ax-danger)',
                                borderColor: 'var(--ax-border)',
                              }}
                              onClick={() => setDeleteWallet(wallet)}
                              aria-label={`Delete ${wallet.label ?? 'wallet'}`}
                            >
                              Delete
                            </button>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="rd-section">
        <div className="rd-section-head">
          <div>
            <p className="eyebrow">Membership</p>
            <h2>Your organizations</h2>
            <p style={{ margin: 0, color: 'var(--ax-text-muted)' }}>
              Organizations you can sign in to. Each organization owns its own treasury accounts.
            </p>
          </div>
          <div>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setCreateOrgOpen(true)}
            >
              + Create organization
            </button>
          </div>
        </div>

        <div className="rd-table-shell" style={{ marginTop: 12 }}>
          {organizations.length === 0 ? (
            <div className="rd-empty-cell" style={{ padding: '64px 24px' }}>
              <strong>No organizations yet</strong>
              <p style={{ margin: '0 0 16px' }}>
                Create one to start adding treasury accounts and running payment flows.
              </p>
              <button
                type="button"
                className="button button-primary"
                onClick={() => setCreateOrgOpen(true)}
              >
                + Create organization
              </button>
            </div>
          ) : (
            <table className="rd-table">
              <thead>
                <tr>
                  <th style={{ width: '60%' }}>Organization</th>
                  <th style={{ width: '20%' }}>Role</th>
                  <th style={{ width: '20%' }}>&nbsp;</th>
                </tr>
              </thead>
              <tbody>
                {organizations.map((org) => (
                  <tr
                    key={org.organizationId}
                    style={{ cursor: 'pointer' }}
                    onClick={() => navigate(`/organizations/${org.organizationId}`)}
                  >
                    <td>
                      <span className="rd-payee-name">{org.organizationName}</span>
                    </td>
                    <td>
                      <span className="rd-pill rd-pill-info">{org.role}</span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span style={{ color: 'var(--ax-text-muted)', fontSize: 13 }}>Open →</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {createPersonalWalletOpen ? (
        <CreatePersonalWalletDialog
          pending={createPersonalWalletMutation.isPending}
          onClose={() => setCreatePersonalWalletOpen(false)}
          onSubmit={(form) => createPersonalWalletMutation.mutate(form)}
        />
      ) : null}
      {transferWallet ? (
        <TransferOutDialog
          wallet={transferWallet}
          pending={transferOutMutation.isPending}
          onClose={() => transferOutMutation.isPending ? undefined : setTransferWallet(null)}
          onSubmit={(input) =>
            transferOutMutation.mutate({
              userWalletId: transferWallet.userWalletId,
              ...input,
            })
          }
        />
      ) : null}
      {airdropWallet ? (
        <AirdropDialog
          wallet={airdropWallet}
          pending={airdropMutation.isPending}
          onClose={() => airdropMutation.isPending ? undefined : setAirdropWallet(null)}
          onSubmit={(amountSol) =>
            airdropMutation.mutate({
              userWalletId: airdropWallet.userWalletId,
              amountSol,
            })
          }
        />
      ) : null}
      {deleteWallet ? (
        <DeletePersonalWalletDialog
          wallet={deleteWallet}
          balance={balancesByWalletId.get(deleteWallet.userWalletId) ?? null}
          pending={deleteWalletMutation.isPending}
          onClose={() => deleteWalletMutation.isPending ? undefined : setDeleteWallet(null)}
          onConfirm={() =>
            deleteWalletMutation.mutate({ userWalletId: deleteWallet.userWalletId })
          }
        />
      ) : null}
      {createOrgOpen ? (
        <CreateOrganizationDialog
          pending={createOrganizationMutation.isPending}
          onClose={() => setCreateOrgOpen(false)}
          onSubmit={(form) => createOrganizationMutation.mutate(form)}
        />
      ) : null}
    </main>
  );
}

function CreateOrganizationDialog(props: {
  pending: boolean;
  onClose: () => void;
  onSubmit: (form: FormData) => void;
}) {
  const { pending, onClose, onSubmit } = props;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="rd-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rd-create-org-title"
    >
      <div className="rd-dialog" style={{ maxWidth: 460 }}>
        <h2 id="rd-create-org-title" className="rd-dialog-title">
          Create organization
        </h2>
        <p className="rd-dialog-body">
          Create a new company or treasury entity. You become its owner; you can invite members and add treasury accounts after.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(new FormData(e.currentTarget));
          }}
        >
          <label className="field">
            Organization name
            <input
              name="organizationName"
              required
              placeholder="Acme Treasury Group"
              autoComplete="off"
              autoFocus
            />
          </label>
          <div className="rd-dialog-actions" style={{ marginTop: 20 }}>
            <button type="button" className="button button-secondary" onClick={onClose} disabled={pending}>
              Cancel
            </button>
            <button type="submit" className="button button-primary" disabled={pending} aria-busy={pending}>
              {pending ? 'Creating…' : 'Create organization'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CreatePersonalWalletDialog(props: {
  pending: boolean;
  onClose: () => void;
  onSubmit: (form: FormData) => void;
}) {
  const { pending, onClose, onSubmit } = props;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="rd-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rd-create-personal-wallet-title"
    >
      <div className="rd-dialog" style={{ maxWidth: 480 }}>
        <h2 id="rd-create-personal-wallet-title" className="rd-dialog-title">
          Create personal wallet
        </h2>
        <p className="rd-dialog-body">
          Decimal will create a Privy-managed Solana wallet under your user. Keys never leave your browser. This wallet belongs to you — you can later authorize it to act for any organization treasury account.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(new FormData(e.currentTarget));
          }}
        >
          <div className="provider-modal-summary" style={{ marginBottom: 16 }}>
            <span
              className="provider-icon provider-icon-large provider-icon-logo"
              data-provider="privy"
              aria-hidden
            />
            <div>
              <strong>Privy</strong>
              <p>Embedded Solana wallet managed through Privy.</p>
            </div>
          </div>
          <label className="field">
            Wallet name
            <input
              name="label"
              placeholder="My signing wallet"
              autoComplete="off"
              autoFocus
            />
          </label>
          <div className="rd-dialog-actions" style={{ marginTop: 20 }}>
            <button type="button" className="button button-secondary" onClick={onClose} disabled={pending}>
              Cancel
            </button>
            <button type="submit" className="button button-primary" disabled={pending} aria-busy={pending}>
              {pending ? 'Creating…' : 'Create wallet'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// TransferOutDialog
//
// Sends SOL or USDC out of a Privy personal wallet via the backend
// transfer-out endpoint (which signs server-side via Privy and submits).
// Used to recover funds from a wallet that was funded for testing.
//
// Amount handling: user enters human-readable amount; we convert to
// raw base units before sending. SOL: 9 decimals. USDC: 6 decimals.
function TransferOutDialog(props: {
  wallet: UserWallet;
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: { recipient: string; amountRaw: string; asset: 'sol' | 'usdc' }) => void;
}) {
  const { wallet, pending, onClose, onSubmit } = props;
  const [asset, setAsset] = useState<'sol' | 'usdc'>('sol');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !pending) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, pending]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmedRecipient = recipient.trim();
    if (!trimmedRecipient) {
      setError('Recipient address is required.');
      return;
    }
    if (trimmedRecipient === wallet.walletAddress) {
      setError('Cannot transfer to the same wallet.');
      return;
    }
    const amountTrimmed = amount.trim();
    if (!/^\d+(\.\d+)?$/.test(amountTrimmed) || Number(amountTrimmed) <= 0) {
      setError('Enter a positive amount.');
      return;
    }
    const decimals = asset === 'sol' ? 9 : 6;
    const [whole, frac = ''] = amountTrimmed.split('.');
    const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
    const amountRaw = (BigInt(whole || '0') * BigInt(10) ** BigInt(decimals) + BigInt(fracPadded || '0')).toString();
    if (amountRaw === '0') {
      setError('Amount is too small for the selected asset.');
      return;
    }
    onSubmit({ recipient: trimmedRecipient, amountRaw, asset });
  };

  return (
    <div
      className="rd-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rd-transfer-out-title"
    >
      <div className="rd-dialog" style={{ maxWidth: 500 }}>
        <h2 id="rd-transfer-out-title" className="rd-dialog-title">
          Transfer from personal wallet
        </h2>
        <p className="rd-dialog-body">
          Send SOL or USDC out of this Privy-managed wallet. The backend signs via Privy and submits to the configured Solana network.
        </p>

        <div
          style={{
            padding: 12,
            background: 'var(--ax-surface-1)',
            borderRadius: 6,
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          <div style={{ color: 'var(--ax-text-muted)', marginBottom: 4 }}>From</div>
          <div>
            <strong>{wallet.label ?? 'Untitled wallet'}</strong>
          </div>
          <div style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--ax-text-muted)' }}>
            {wallet.walletAddress}
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="field" style={{ marginBottom: 12 }}>
            <span style={{ display: 'block', marginBottom: 6, fontSize: 13 }}>Asset</span>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['sol', 'usdc'] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setAsset(a)}
                  className={asset === a ? 'button button-primary' : 'button button-secondary'}
                  style={{ flex: 1, padding: '8px 12px', fontSize: 13 }}
                >
                  {a.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <label className="field">
            Recipient address
            <input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="Solana wallet address"
              autoComplete="off"
              autoFocus
            />
          </label>

          <label className="field">
            Amount ({asset.toUpperCase()})
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={asset === 'sol' ? '0.1' : '10.00'}
              inputMode="decimal"
              autoComplete="off"
            />
          </label>

          <p style={{ fontSize: 12, color: 'var(--ax-text-muted)', margin: '4px 0 12px' }}>
            For USDC: a recipient associated token account is created automatically if it doesn't exist (~0.002 SOL fee paid from this wallet).
          </p>

          {error ? (
            <div
              style={{
                padding: 10,
                border: '1px solid var(--ax-danger)',
                borderRadius: 6,
                background: 'var(--ax-surface-1)',
                color: 'var(--ax-danger)',
                fontSize: 13,
                marginBottom: 12,
              }}
            >
              {error}
            </div>
          ) : null}

          <div className="rd-dialog-actions" style={{ marginTop: 16 }}>
            <button
              type="button"
              className="button button-secondary"
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="button button-primary"
              disabled={pending}
              aria-busy={pending}
            >
              {pending ? 'Sending…' : `Send ${asset.toUpperCase()}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// AirdropDialog
//
// Devnet-only. SOL is requested directly via the backend airdrop
// endpoint (which always uses SOLANA_DEVNET_RPC_URL). USDC is not
// natively airdroppable on devnet — Circle's USDC test mint is
// faucet-controlled by Circle, so we just deep-link to their faucet
// with the wallet address pre-copied.
function AirdropDialog(props: {
  wallet: UserWallet;
  pending: boolean;
  onClose: () => void;
  onSubmit: (amountSol: number) => void;
}) {
  const { wallet, pending, onClose, onSubmit } = props;
  const [amountSol, setAmountSol] = useState('1');
  const [error, setError] = useState<string | null>(null);
  const { success } = useToast();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !pending) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, pending]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const parsed = Number(amountSol);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('Enter a positive amount.');
      return;
    }
    if (parsed > 2) {
      setError('Solana devnet caps airdrops at 2 SOL per call.');
      return;
    }
    onSubmit(parsed);
  };

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(wallet.walletAddress);
      success('Wallet address copied.');
    } catch {
      // ignore — user can copy from the input below as a fallback
    }
  };

  return (
    <div
      className="rd-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rd-airdrop-title"
    >
      <div className="rd-dialog" style={{ maxWidth: 500 }}>
        <h2 id="rd-airdrop-title" className="rd-dialog-title">
          Airdrop devnet funds
        </h2>
        <p className="rd-dialog-body">
          Top up this wallet on Solana devnet for testing. SOL is delivered through Decimal's devnet RPC; USDC has to be requested from Circle's faucet directly.
        </p>

        <div
          style={{
            padding: 12,
            background: 'var(--ax-surface-1)',
            borderRadius: 6,
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          <div style={{ color: 'var(--ax-text-muted)', marginBottom: 4 }}>Wallet</div>
          <div>
            <strong>{wallet.label ?? 'Untitled wallet'}</strong>
          </div>
          <div style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--ax-text-muted)' }}>
            {wallet.walletAddress}
          </div>
        </div>

        <form onSubmit={handleSubmit} style={{ marginBottom: 20 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 8,
            }}
          >
            <strong style={{ fontSize: 14 }}>SOL</strong>
            <span style={{ color: 'var(--ax-text-muted)', fontSize: 12 }}>devnet RPC · max 2 per call</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={amountSol}
              onChange={(e) => setAmountSol(e.target.value)}
              inputMode="decimal"
              placeholder="1"
              autoComplete="off"
              autoFocus
              style={{ flex: 1 }}
            />
            <button
              type="submit"
              className="button button-primary"
              disabled={pending}
              aria-busy={pending}
            >
              {pending ? 'Airdropping…' : 'Airdrop SOL'}
            </button>
          </div>
          {error ? (
            <div
              style={{
                marginTop: 8,
                color: 'var(--ax-danger)',
                fontSize: 13,
              }}
            >
              {error}
            </div>
          ) : null}
        </form>

        <div
          style={{
            paddingTop: 16,
            borderTop: '1px solid var(--ax-border)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 8,
            }}
          >
            <strong style={{ fontSize: 14 }}>USDC</strong>
            <span style={{ color: 'var(--ax-text-muted)', fontSize: 12 }}>via Circle faucet</span>
          </div>
          <p
            style={{
              margin: '0 0 12px',
              fontSize: 13,
              color: 'var(--ax-text-muted)',
              lineHeight: 1.5,
            }}
          >
            Circle owns the devnet USDC test mint, so we can't airdrop it from here. Copy this wallet's address and paste it into Circle's faucet, choose Solana, request USDC.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="button button-secondary" onClick={copyAddress}>
              Copy address
            </button>
            <a
              href="https://faucet.circle.com/"
              target="_blank"
              rel="noreferrer"
              className="button button-secondary"
              style={{ textDecoration: 'none' }}
            >
              Open Circle faucet ↗
            </a>
          </div>
        </div>

        <div className="rd-dialog-actions" style={{ marginTop: 20 }}>
          <button type="button" className="button button-secondary" onClick={onClose} disabled={pending}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// DeletePersonalWalletDialog
//
// Permanent + irreversible. Backend destroys the Privy keys via
// Privy's DELETE /v1/wallets/:id, then archives the local row and
// revokes any active wallet authorizations. Funds left in the wallet
// at delete time are unrecoverable, so we surface the live balance
// (if non-zero) prominently in the dialog body and gate the action
// behind a typed-confirmation when there's value at stake.
function DeletePersonalWalletDialog(props: {
  wallet: UserWallet;
  balance: { solLamports: string; usdcRaw: string | null; rpcError: string | null } | null;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { wallet, balance, pending, onClose, onConfirm } = props;
  const [confirmText, setConfirmText] = useState('');

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !pending) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, pending]);

  // Detect non-zero balance to require typed confirmation. We don't
  // gate on USDC alone equalling 0 because rpcError or a missing ATA
  // returns null — only zero/null is treated as "no funds at risk".
  const lamportsAreZero = (() => {
    try {
      return BigInt(balance?.solLamports ?? '0') === 0n;
    } catch {
      return true;
    }
  })();
  const usdcIsZero = balance?.usdcRaw == null
    ? true
    : (() => {
        try {
          return BigInt(balance.usdcRaw) === 0n;
        } catch {
          return true;
        }
      })();
  const hasValueAtRisk = !lamportsAreZero || !usdcIsZero;
  const expectedConfirm = 'DELETE';
  const confirmOk = !hasValueAtRisk || confirmText.trim() === expectedConfirm;

  return (
    <div
      className="rd-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rd-delete-wallet-title"
    >
      <div className="rd-dialog" style={{ maxWidth: 500 }}>
        <h2 id="rd-delete-wallet-title" className="rd-dialog-title" style={{ color: 'var(--ax-danger)' }}>
          Delete personal wallet
        </h2>
        <p className="rd-dialog-body">
          This permanently destroys the Privy keys for this wallet. The local record is archived and any organization wallet authorizations referencing it are revoked. <strong>Funds left in this wallet will be unrecoverable.</strong>
        </p>

        <div
          style={{
            padding: 12,
            background: 'var(--ax-surface-1)',
            borderRadius: 6,
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          <div style={{ color: 'var(--ax-text-muted)', marginBottom: 4 }}>Wallet</div>
          <div>
            <strong>{wallet.label ?? 'Untitled wallet'}</strong>
          </div>
          <div style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--ax-text-muted)' }}>
            {wallet.walletAddress}
          </div>
        </div>

        {hasValueAtRisk ? (
          <div
            style={{
              padding: 12,
              border: '1px solid var(--ax-danger)',
              borderRadius: 6,
              background: 'var(--ax-surface-1)',
              marginBottom: 16,
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            <strong style={{ color: 'var(--ax-danger)', display: 'block', marginBottom: 6 }}>
              This wallet has a non-zero balance
            </strong>
            <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
              {!lamportsAreZero ? (
                <span>
                  <span style={{ color: 'var(--ax-text-muted)' }}>SOL: </span>
                  <strong>{formatSolFromLamports(balance!.solLamports)}</strong>
                </span>
              ) : null}
              {!usdcIsZero ? (
                <span>
                  <span style={{ color: 'var(--ax-text-muted)' }}>USDC: </span>
                  <strong>{formatRawUsdcCompact(balance!.usdcRaw!)}</strong>
                </span>
              ) : null}
            </div>
            <div style={{ color: 'var(--ax-text-muted)' }}>
              Cancel and use the Transfer button to move these funds out before deleting. Once the keys are destroyed, no one can move them.
            </div>
            <label
              className="field"
              style={{ marginTop: 12, marginBottom: 0 }}
            >
              <span style={{ fontSize: 12, color: 'var(--ax-text-muted)' }}>
                Type <strong>{expectedConfirm}</strong> to confirm
              </span>
              <input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={expectedConfirm}
                autoComplete="off"
                disabled={pending}
              />
            </label>
          </div>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--ax-text-muted)', marginBottom: 16 }}>
            No detectable balance on this wallet — safe to delete.
          </p>
        )}

        <div className="rd-dialog-actions" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="button button-secondary"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button button-primary"
            style={{
              background: 'var(--ax-danger)',
              borderColor: 'var(--ax-danger)',
            }}
            disabled={pending || !confirmOk}
            aria-busy={pending}
            onClick={onConfirm}
          >
            {pending ? 'Deleting…' : 'Delete wallet'}
          </button>
        </div>
      </div>
    </div>
  );
}
