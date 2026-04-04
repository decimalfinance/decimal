import type { FormEvent } from 'react';
import type {
  ExceptionItem,
  ObservedTransfer,
  ReconciliationRow,
  TransferRequest,
  Workspace,
  WorkspaceAddress,
} from '../types';
import { formatRawUsdc, formatTimestamp, orbTransactionUrl, shortenAddress } from '../lib/app';
import { InfoLine, Metric } from '../components/ui';

export function WorkspaceHomePage({
  addresses,
  currentRole,
  currentWorkspace,
  exceptions,
  isLoading,
  observedTransfers,
  onOpenSetup,
  onRefresh,
  onSelectObservedTransfer,
  onSelectReconciliation,
  reconciliationRows,
  selectedObservedTransfer,
  selectedReconciliation,
  workspaceLoadedAt,
  workspaceServedAt,
  transferRequests,
}: {
  addresses: WorkspaceAddress[];
  currentRole: string | null;
  currentWorkspace: Workspace;
  exceptions: ExceptionItem[];
  isLoading: boolean;
  observedTransfers: ObservedTransfer[];
  onOpenSetup: () => void;
  onRefresh: () => Promise<void>;
  onSelectObservedTransfer: (transfer: ObservedTransfer) => void;
  onSelectReconciliation: (row: ReconciliationRow) => void;
  reconciliationRows: ReconciliationRow[];
  selectedObservedTransfer: ObservedTransfer | null;
  selectedReconciliation: ReconciliationRow | null;
  workspaceLoadedAt: string | null;
  workspaceServedAt: string | null;
  transferRequests: TransferRequest[];
}) {
  const matchedCount = reconciliationRows.filter((row) => row.match?.matchStatus === 'matched_exact').length;
  const pendingCount = reconciliationRows.filter((row) => row.reconciliationStatus === 'unmatched_pending').length;
  const exceptionCount = exceptions.filter((item) => item.status === 'open').length;

  return (
    <div className="page-stack">
      <section className="section-headline">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1>{currentWorkspace.workspaceName}</h1>
          <p className="section-copy">
            Save wallets, create planned transfers, observe real USDC transfers, and reconcile them against what you expected.
          </p>
        </div>
        <div className="headline-actions">
          <button className="ghost-button" onClick={() => void onRefresh()} type="button">
            refresh
          </button>
          <button className="primary-button" onClick={onOpenSetup} type="button">
            wallets + planned transfers
          </button>
        </div>
      </section>

      <section className="content-grid">
        <div className="content-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Status</p>
              <h2>Workspace pulse</h2>
            </div>
            <span className="status-chip">{isLoading ? 'syncing' : currentRole ?? 'member'}</span>
          </div>

          <div className="hero-metrics">
            <Metric label="Wallets" value={String(addresses.length).padStart(2, '0')} />
            <Metric label="Planned" value={String(transferRequests.length).padStart(2, '0')} />
            <Metric label="Observed" value={String(observedTransfers.length).padStart(2, '0')} />
            <Metric label="Open issues" value={String(exceptionCount).padStart(2, '0')} />
          </div>

          <div className="info-grid">
            <InfoLine label="Matched" value={String(matchedCount)} />
            <InfoLine label="Pending" value={String(pendingCount)} />
            <InfoLine label="API served" value={workspaceServedAt ? formatTimestamp(workspaceServedAt) : 'n/a'} />
            <InfoLine label="UI refreshed" value={workspaceLoadedAt ? formatTimestamp(workspaceLoadedAt) : 'n/a'} />
          </div>
        </div>

        <div className="content-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Planned transfers</p>
              <h2>Requests and matches</h2>
            </div>
            <span className="status-chip">{reconciliationRows.length}</span>
          </div>

          <div className="stack-list">
            {reconciliationRows.length ? (
              reconciliationRows.map((row) => (
                <button
                  key={row.transferRequestId}
                  className={selectedReconciliation?.transferRequestId === row.transferRequestId ? 'feed-row is-active' : 'feed-row'}
                  data-tone={row.reconciliationStatus}
                  onClick={() => onSelectReconciliation(row)}
                  type="button"
                >
                  <div>
                    <strong>{getTransferLabel(row)}</strong>
                    <small>
                      {row.requestType.replaceAll('_', ' ')} // {row.reconciliationStatus.replaceAll('_', ' ')}
                    </small>
                  </div>
                  <span>{formatRawUsdc(row.amountRaw)}</span>
                </button>
              ))
            ) : (
              <div className="empty-box compact">No planned transfers yet. Open setup and create the first one.</div>
            )}
          </div>
        </div>

        <div className="content-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Inspector</p>
              <h2>Transfer detail</h2>
            </div>
          </div>

          {selectedReconciliation ? (
            <div className="stack-list">
              <InfoLine label="Transfer" value={getTransferLabel(selectedReconciliation)} />
              <InfoLine label="Requested amount" value={formatRawUsdc(selectedReconciliation.amountRaw)} />
              <InfoLine
                label="Receiving wallet"
                value={selectedReconciliation.destinationWorkspaceAddress?.address ?? 'Unknown'}
              />
              <InfoLine
                label="Receiving USDC ATA"
                value={selectedReconciliation.destinationWorkspaceAddress?.usdcAtaAddress ?? 'Unknown'}
              />
              <InfoLine label="Status" value={selectedReconciliation.reconciliationStatus.replaceAll('_', ' ')} />
              <InfoLine label="Requested at" value={formatTimestamp(selectedReconciliation.requestedAt)} />
              {selectedReconciliation.match ? (
                <>
                  <InfoLine label="Signature" value={selectedReconciliation.match.signature ?? 'pending'} />
                  <InfoLine label="Match rule" value={selectedReconciliation.match.matchRule} />
                  <InfoLine label="Matched amount" value={formatRawUsdc(selectedReconciliation.match.matchedAmountRaw)} />
                  <InfoLine
                    label="Observed event"
                    value={selectedReconciliation.match.observedEventTime ? formatTimestamp(selectedReconciliation.match.observedEventTime) : 'n/a'}
                  />
                  <InfoLine
                    label="Matched at"
                    value={selectedReconciliation.match.matchedAt ? formatTimestamp(selectedReconciliation.match.matchedAt) : 'n/a'}
                  />
                  <InfoLine
                    label="Chain to match"
                    value={
                      selectedReconciliation.match.chainToMatchMs === null
                        ? 'n/a'
                        : `${selectedReconciliation.match.chainToMatchMs} ms`
                    }
                  />
                  <div className="empty-box compact">{selectedReconciliation.match.explanation}</div>
                </>
              ) : (
                <div className="empty-box compact">
                  No exact match yet. The request is still waiting for a compatible observed transfer.
                </div>
              )}
            </div>
          ) : (
            <div className="empty-box compact">Select a planned transfer to inspect its match state.</div>
          )}
        </div>
      </section>

      <section className="content-grid content-grid-single">
        <div className="content-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Observed transfers</p>
              <h2>Real USDC movement</h2>
            </div>
          </div>
          <div className="transfer-table">
            <div className="transfer-table-head">
              <span>Amount</span>
              <span>From</span>
              <span>To</span>
              <span>Route</span>
              <span>Type</span>
              <span>Actions</span>
            </div>
            {observedTransfers.length ? (
              observedTransfers.map((transfer) => (
                <div
                  key={transfer.transferId}
                  className={
                    selectedObservedTransfer?.transferId === transfer.transferId
                      ? 'transfer-table-row is-active'
                      : 'transfer-table-row'
                  }
                >
                  <a
                    className="transfer-table-link"
                    href={orbTransactionUrl(transfer.signature)}
                    rel="noreferrer"
                    target="_blank"
                    title={transfer.signature}
                  >
                    <span className="transfer-table-amount">{transfer.amountDecimal}</span>
                    <span className="transfer-table-mono" title={transfer.sourceWallet ?? transfer.sourceTokenAccount ?? 'Unknown'}>
                      {shortenAddress(transfer.sourceWallet ?? transfer.sourceTokenAccount, 8, 8)}
                    </span>
                    <span className="transfer-table-mono" title={transfer.destinationWallet ?? transfer.destinationTokenAccount}>
                      {shortenAddress(transfer.destinationWallet ?? transfer.destinationTokenAccount, 8, 8)}
                    </span>
                    <span className="transfer-table-meta" title={transfer.routeGroup}>
                      {getRouteLabel(transfer)}
                    </span>
                    <span className="transfer-table-meta">{transfer.legRole.replaceAll('_', ' ')}</span>
                  </a>
                  <div className="transfer-table-actions">
                    <button
                      className="ghost-button compact-button"
                      onClick={() => onSelectObservedTransfer(transfer)}
                      type="button"
                    >
                      inspect
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className="empty-box compact">No observed transfers yet for the saved wallets.</div>
            )}
          </div>
          {selectedObservedTransfer ? (
            <div className="transfer-inspector-drawer">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Observed transfer</p>
                  <h2>Transfer inspector</h2>
                </div>
              </div>
              <div className="stack-list">
              <div className="inspector-callout">
                <div>
                  <p className="eyebrow">Explorer</p>
                  <strong>{shortenAddress(selectedObservedTransfer.signature, 10, 10)}</strong>
                </div>
                <a
                  className="ghost-button inline-link-button"
                  href={orbTransactionUrl(selectedObservedTransfer.signature)}
                  rel="noreferrer"
                  target="_blank"
                >
                  open on orb
                </a>
              </div>
              <InfoLine label="Signature" value={selectedObservedTransfer.signature} />
              <InfoLine label="Observed at" value={formatTimestamp(selectedObservedTransfer.eventTime)} />
              <InfoLine label="Written at" value={formatTimestamp(selectedObservedTransfer.createdAt)} />
              <InfoLine label="Chain to write" value={`${selectedObservedTransfer.chainToWriteMs} ms`} />
              <InfoLine
                label="Route"
                value={getRouteLabel(selectedObservedTransfer)}
              />
              <InfoLine label="Leg role" value={selectedObservedTransfer.legRole.replaceAll('_', ' ')} />
              <InfoLine label="Source wallet" value={selectedObservedTransfer.sourceWallet ?? 'Unknown'} />
              <InfoLine label="Source token account" value={selectedObservedTransfer.sourceTokenAccount ?? 'Unknown'} />
              <InfoLine label="Destination wallet" value={selectedObservedTransfer.destinationWallet ?? 'Unknown'} />
              <InfoLine label="Destination token account" value={selectedObservedTransfer.destinationTokenAccount} />
              <InfoLine label="Amount" value={selectedObservedTransfer.amountDecimal} />
              </div>
            </div>
          ) : (
            <div className="empty-box compact transfer-empty-state">
              Select a transfer row to inspect its exact chain-facing fields.
            </div>
          )}
        </div>
      </section>

      <section className="content-grid content-grid-single">
        <div className="content-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Exceptions</p>
              <h2>Open issues</h2>
            </div>
          </div>
          <div className="stack-list">
            {exceptions.length ? (
              exceptions.map((exception) => (
                <div key={exception.exceptionId} className="status-row" data-severity={exception.severity}>
                  <div>
                    <strong>{exception.exceptionType}</strong>
                    <small>{exception.explanation}</small>
                  </div>
                  <span>{exception.severity}</span>
                </div>
              ))
            ) : (
              <div className="empty-box compact">No open issues right now.</div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

export function WorkspaceSetupPage({
  addresses,
  canManage,
  currentWorkspace,
  onCreateAddress,
  onCreateTransferRequest,
  transferRequests,
}: {
  addresses: WorkspaceAddress[];
  canManage: boolean;
  currentWorkspace: Workspace;
  onCreateAddress: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onCreateTransferRequest: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  transferRequests: TransferRequest[];
}) {
  return (
    <div className="page-stack">
      <section className="section-headline">
        <div>
          <p className="eyebrow">Setup</p>
          <h1>{currentWorkspace.workspaceName}</h1>
          <p className="section-copy">
            Keep this simple: save wallets first, then create planned transfers between those wallets.
          </p>
        </div>
      </section>

      {!canManage ? (
        <div className="notice-banner">
          <div>
            <strong>Read only.</strong>
            <p>Only organization admins can change wallets and planned transfers in this workspace.</p>
          </div>
        </div>
      ) : null}

      <section className="content-grid">
        <div className="content-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Step 1</p>
              <h2>Wallets</h2>
            </div>
          </div>
          <form className="form-stack" onSubmit={onCreateAddress}>
            <label className="field">
              <span>Wallet address</span>
              <input name="address" placeholder="Solana wallet address" required />
            </label>
            <label className="field">
              <span>Name</span>
              <input name="displayName" placeholder="Treasury wallet, hot wallet, vendor wallet..." required />
            </label>
            <label className="field">
              <span>Notes</span>
              <input name="notes" placeholder="Optional" />
            </label>
            <button className="primary-button" disabled={!canManage} type="submit">
              Save wallet
            </button>
          </form>

          <div className="stack-list">
            {addresses.length ? (
              addresses.map((address) => (
                <div key={address.workspaceAddressId} className="workspace-row static-row">
                  <div>
                    <strong>{getWalletName(address)}</strong>
                    <small>{address.address}</small>
                  </div>
                </div>
              ))
            ) : (
              <div className="empty-box compact">No wallets saved yet.</div>
            )}
          </div>
        </div>

        <div className="content-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Step 2</p>
              <h2>Planned transfers</h2>
            </div>
          </div>
          <form className="form-stack" onSubmit={onCreateTransferRequest}>
            <label className="field">
              <span>From wallet</span>
              <select name="sourceWorkspaceAddressId" defaultValue="">
                <option value="">Optional</option>
                {addresses.map((address) => (
                  <option key={address.workspaceAddressId} value={address.workspaceAddressId}>
                    {getWalletName(address)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>To wallet</span>
              <select name="destinationWorkspaceAddressId" defaultValue="" required>
                <option value="" disabled>
                  Select wallet
                </option>
                {addresses.map((address) => (
                  <option key={address.workspaceAddressId} value={address.workspaceAddressId}>
                    {getWalletName(address)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Transfer type</span>
              <input name="requestType" placeholder="wallet_transfer" required />
            </label>
            <label className="field">
              <span>Amount raw</span>
              <input name="amountRaw" placeholder="10000 for 0.01 USDC" required />
            </label>
            <label className="field">
              <span>Reference</span>
              <input name="externalReference" placeholder="Optional" />
            </label>
            <label className="field">
              <span>Reason</span>
              <input name="reason" placeholder="Optional" />
            </label>
            <button className="primary-button" disabled={!canManage || addresses.length === 0} type="submit">
              Create planned transfer
            </button>
          </form>

          <div className="stack-list">
            {transferRequests.length ? (
              transferRequests.map((item) => (
                <div key={item.transferRequestId} className="workspace-row static-row">
                  <div>
                    <strong>{getTransferLabel(item)}</strong>
                    <small>{item.requestType.replaceAll('_', ' ')} // {formatRawUsdc(item.amountRaw)}</small>
                  </div>
                  <span>{item.status}</span>
                </div>
              ))
            ) : (
              <div className="empty-box compact">No planned transfers yet.</div>
            )}
          </div>
        </div>
      </section>

      <section className="content-grid content-grid-single">
        <div className="content-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Matching note</p>
              <h2>How it works</h2>
            </div>
          </div>
          <div className="empty-box compact">
            Every saved wallet gets a hidden USDC receiving address derived in the backend. Planned transfers match against that receiving address and the exact amount observed on-chain.
          </div>
        </div>
      </section>
    </div>
  );
}

function getWalletName(address: WorkspaceAddress) {
  return address.displayName?.trim() || address.address;
}

function getTransferLabel(
  row:
    | Pick<ReconciliationRow, 'sourceWorkspaceAddress' | 'destinationWorkspaceAddress'>
    | Pick<TransferRequest, 'sourceWorkspaceAddress' | 'destinationWorkspaceAddress'>,
) {
  const source = row.sourceWorkspaceAddress?.displayName ?? row.sourceWorkspaceAddress?.address ?? 'Unknown';
  const destination =
    row.destinationWorkspaceAddress?.displayName ?? row.destinationWorkspaceAddress?.address ?? 'Unknown';
  return `${source} -> ${destination}`;
}

function getRouteLabel(transfer: ObservedTransfer) {
  if (transfer.innerInstructionIndex !== null && transfer.instructionIndex !== null) {
    return `ix ${transfer.instructionIndex}.${transfer.innerInstructionIndex}`;
  }

  if (transfer.instructionIndex !== null) {
    return `ix ${transfer.instructionIndex}`;
  }

  return 'derived';
}
