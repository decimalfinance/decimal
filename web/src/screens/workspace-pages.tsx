import type { FormEvent } from 'react';
import type {
  ExceptionItem,
  ObservedTransfer,
  ReconciliationDetail,
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
  isLoading,
  observedTransfers,
  onOpenSetup,
  onAddExceptionNote,
  onAddRequestNote,
  onApplyExceptionAction,
  onChangeReconciliationFilter,
  onRefresh,
  onSelectObservedTransfer,
  onSelectReconciliation,
  onTransitionRequest,
  onBackToDashboard,
  reconciliationFilter,
  reconciliationRows,
  selectedObservedTransfer,
  selectedReconciliationDetail,
  transferRequests,
  isLoadingReconciliationDetail,
}: {
  addresses: WorkspaceAddress[];
  currentRole: string | null;
  currentWorkspace: Workspace;
  isLoading: boolean;
  observedTransfers: ObservedTransfer[];
  onOpenSetup: () => void;
  onAddExceptionNote: (exceptionId: string, body: string) => Promise<void>;
  onAddRequestNote: (transferRequestId: string, body: string) => Promise<void>;
  onApplyExceptionAction: (
    exceptionId: string,
    action: 'reviewed' | 'expected' | 'dismissed' | 'reopen',
    note?: string,
  ) => Promise<void>;
  onChangeReconciliationFilter: (filter: ReconciliationRow['requestDisplayState'] | 'all') => void;
  onRefresh: () => Promise<void>;
  onSelectObservedTransfer: (transfer: ObservedTransfer) => void;
  onSelectReconciliation: (row: ReconciliationRow) => void;
  onTransitionRequest: (transferRequestId: string, toStatus: string) => Promise<void>;
  onBackToDashboard: () => void;
  reconciliationFilter: ReconciliationRow['requestDisplayState'] | 'all';
  reconciliationRows: ReconciliationRow[];
  selectedObservedTransfer: ObservedTransfer | null;
  selectedReconciliationDetail: ReconciliationDetail | null;
  transferRequests: TransferRequest[];
  isLoadingReconciliationDetail: boolean;
}) {
  const matchedCount = reconciliationRows.filter((row) => row.requestDisplayState === 'matched').length;
  const pendingCount = reconciliationRows.filter((row) => row.requestDisplayState === 'pending').length;

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
          <button className="ghost-button" onClick={onBackToDashboard} type="button">
            org dashboard
          </button>
          <button className="ghost-button" onClick={() => void onRefresh()} type="button">
            refresh
          </button>
          <button className="primary-button" onClick={onOpenSetup} type="button">
            wallets + planned transfers
          </button>
        </div>
      </section>

      <section className="content-grid content-grid-single">
        <div className="workspace-pulse-strip workspace-pulse-strip-standalone">
          <div className="workspace-pulse-strip-grid">
            <Metric label="Wallets" value={String(addresses.length).padStart(2, '0')} />
            <Metric label="Planned" value={String(transferRequests.length).padStart(2, '0')} />
            <Metric label="Observed" value={String(observedTransfers.length).padStart(2, '0')} />
            <Metric label="Matched" value={String(matchedCount).padStart(2, '0')} />
            <Metric label="Pending" value={String(pendingCount).padStart(2, '0')} />
          </div>
          <span className="status-chip">{isLoading ? 'syncing' : currentRole ?? 'member'}</span>
        </div>
      </section>

      <section className="content-grid content-grid-single">
        <div className="content-panel content-panel-soft">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Observed transfers</p>
              <h2>Real USDC movement</h2>
              <p className="compact-copy">Every observed USDC leg across the wallets saved in this workspace.</p>
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
                <InfoLine label="Route" value={getRouteLabel(selectedObservedTransfer)} />
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

      <section className="workspace-home-main">
        <div className="content-panel content-panel-strong">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Planned transfers</p>
              <h2>Requests and matches</h2>
              <p className="compact-copy">This is the main operator queue. Start here, then inspect chain activity below.</p>
            </div>
            <span className="status-chip">{reconciliationRows.length}</span>
          </div>

          <div className="filter-row filter-row-compact">
            {(['all', 'pending', 'matched', 'partial', 'exception'] as const).map((filter) => (
              <button
                key={filter}
                className={reconciliationFilter === filter ? 'filter-chip is-active' : 'filter-chip'}
                onClick={() => onChangeReconciliationFilter(filter)}
                type="button"
              >
                {filter}
              </button>
            ))}
          </div>

          <div className="stack-list">
            {reconciliationRows.length ? (
              reconciliationRows.map((row) => (
                <button
                  key={row.transferRequestId}
                  className={
                    selectedReconciliationDetail?.transferRequestId === row.transferRequestId
                      ? 'feed-row is-active'
                      : 'feed-row'
                  }
                  data-tone={row.requestDisplayState}
                  onClick={() => onSelectReconciliation(row)}
                  type="button"
                >
                  <div>
                    <strong>{getTransferLabel(row)}</strong>
                    <small>
                      {row.requestType.replaceAll('_', ' ')} // {getDisplayStateLabel(row.requestDisplayState)}
                    </small>
                  </div>
                  <span>{formatRawUsdc(row.amountRaw)}</span>
                </button>
              ))
            ) : (
              <div className="empty-box compact">No planned transfers yet. Open setup and create the first one.</div>
            )}
          </div>
          {selectedReconciliationDetail ? (
            <div className="transfer-inspector-drawer">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Request inspector</p>
                  <h2>Request and match</h2>
                </div>
              </div>
              <div className="stack-list">
                <InfoLine label="Transfer" value={getTransferLabel(selectedReconciliationDetail)} />
                <InfoLine label="Requested amount" value={formatRawUsdc(selectedReconciliationDetail.amountRaw)} />
                <InfoLine
                  label="Receiving wallet"
                  value={selectedReconciliationDetail.destinationWorkspaceAddress?.address ?? 'Unknown'}
                />
                <InfoLine
                  label="Receiving USDC ATA"
                  value={selectedReconciliationDetail.destinationWorkspaceAddress?.usdcAtaAddress ?? 'Unknown'}
                />
                <InfoLine label="Lifecycle state" value={selectedReconciliationDetail.status.replaceAll('_', ' ')} />
                <InfoLine label="Queue state" value={getDisplayStateLabel(selectedReconciliationDetail.requestDisplayState)} />
                <InfoLine label="Requested at" value={formatTimestamp(selectedReconciliationDetail.requestedAt)} />

                {selectedReconciliationDetail.availableTransitions.length ? (
                  <div className="detail-section">
                    <div className="detail-section-head">
                      <strong>Request actions</strong>
                      <span>{selectedReconciliationDetail.availableTransitions.length}</span>
                    </div>
                    <div className="exception-actions">
                      {selectedReconciliationDetail.availableTransitions.map((status) => (
                        <button
                          className="ghost-button compact-button"
                          key={status}
                          onClick={() => void onTransitionRequest(selectedReconciliationDetail.transferRequestId, status)}
                          type="button"
                        >
                          move to {status.replaceAll('_', ' ')}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {selectedReconciliationDetail.linkedSignature ? (
                  <div className="inspector-callout">
                    <div>
                      <p className="eyebrow">Linked signature</p>
                      <strong>{shortenAddress(selectedReconciliationDetail.linkedSignature, 10, 10)}</strong>
                    </div>
                    <a
                      className="ghost-button inline-link-button"
                      href={orbTransactionUrl(selectedReconciliationDetail.linkedSignature)}
                      rel="noreferrer"
                      target="_blank"
                    >
                      open on orb
                    </a>
                  </div>
                ) : null}
                {selectedReconciliationDetail.match ? (
                  <>
                    <InfoLine label="Match rule" value={selectedReconciliationDetail.match.matchRule} />
                    <InfoLine label="Match status" value={selectedReconciliationDetail.match.matchStatus.replaceAll('_', ' ')} />
                    <InfoLine label="Matched amount" value={formatRawUsdc(selectedReconciliationDetail.match.matchedAmountRaw)} />
                    <InfoLine
                      label="Observed event"
                      value={
                        selectedReconciliationDetail.match.observedEventTime
                          ? formatTimestamp(selectedReconciliationDetail.match.observedEventTime)
                          : 'n/a'
                      }
                    />
                    <InfoLine
                      label="Matched at"
                      value={
                        selectedReconciliationDetail.match.matchedAt
                          ? formatTimestamp(selectedReconciliationDetail.match.matchedAt)
                          : 'n/a'
                      }
                    />
                    <InfoLine
                      label="Chain to match"
                      value={
                        selectedReconciliationDetail.match.chainToMatchMs === null
                          ? 'n/a'
                          : `${selectedReconciliationDetail.match.chainToMatchMs} ms`
                      }
                    />
                    <div className="empty-box compact">{selectedReconciliationDetail.matchExplanation ?? 'No explanation yet.'}</div>
                  </>
                ) : (
                  <div className="empty-box compact">
                    No exact match yet. The request is still waiting for a compatible observed payment.
                  </div>
                )}

                {selectedReconciliationDetail.linkedObservedPayment ? (
                  <div className="empty-box compact">
                    <strong>Observed payment</strong>
                    <div className="detail-grid">
                      <span>{selectedReconciliationDetail.linkedObservedPayment.paymentKind.replaceAll('_', ' ')}</span>
                      <span>{formatRawUsdc(selectedReconciliationDetail.linkedObservedPayment.netDestinationAmountRaw)}</span>
                      <span>{selectedReconciliationDetail.linkedObservedPayment.routeCount} route(s)</span>
                    </div>
                  </div>
                ) : null}

                {selectedReconciliationDetail.exceptions.length ? (
                  <div className="detail-section">
                    <div className="detail-section-head">
                      <strong>Exceptions</strong>
                      <span>{selectedReconciliationDetail.exceptions.length}</span>
                    </div>
                    <div className="stack-list">
                      {selectedReconciliationDetail.exceptions.map((exception) => (
                        <ExceptionCard
                          exception={exception}
                          onAddNote={onAddExceptionNote}
                          onApplyAction={onApplyExceptionAction}
                          key={exception.exceptionId}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="detail-section">
                  <div className="detail-section-head">
                    <strong>Request notes</strong>
                    <span>{selectedReconciliationDetail.notes.length}</span>
                  </div>
                  <div className="stack-list">
                    {selectedReconciliationDetail.notes.length ? (
                      selectedReconciliationDetail.notes.map((note) => (
                        <div key={note.transferRequestNoteId} className="note-card">
                          <strong>{note.authorUser?.displayName ?? note.authorUser?.email ?? 'Operator'}</strong>
                          <small>{formatTimestamp(note.createdAt)}</small>
                          <p>{note.body}</p>
                        </div>
                      ))
                    ) : (
                      <div className="empty-box compact">No request notes yet.</div>
                    )}
                    <form
                      className="inline-note-form"
                      onSubmit={(event) =>
                        void handleNoteSubmit(event, (body) =>
                          onAddRequestNote(selectedReconciliationDetail.transferRequestId, body),
                        )
                      }
                    >
                      <label className="field">
                        <span>Add request note</span>
                        <textarea name="body" placeholder="Capture context for the next operator." rows={3} />
                      </label>
                      <button className="ghost-button compact-button" type="submit">
                        save note
                      </button>
                    </form>
                  </div>
                </div>

                <div className="detail-section">
                  <div className="detail-section-head">
                    <strong>Timeline</strong>
                    <span>{selectedReconciliationDetail.timeline.length}</span>
                  </div>
                  <div className="timeline-list">
                    {selectedReconciliationDetail.timeline.map((item, index) => (
                      <div className="timeline-item" key={`${item.timelineType}-${index}-${item.createdAt}`}>
                        <div>
                          <strong>{getTimelineTitle(item)}</strong>
                          <small>{formatTimestamp(item.createdAt)}</small>
                        </div>
                        <p>{getTimelineBody(item)}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : isLoadingReconciliationDetail ? (
            <div className="empty-box compact transfer-empty-state">Loading request detail…</div>
          ) : (
            <div className="empty-box compact transfer-empty-state">
              Select a request to inspect the settlement timeline, exceptions, and notes.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

export function WorkspaceSetupPage({
  addresses,
  canManage,
  currentWorkspace,
  onBackToDashboard,
  onBackToWatchSystem,
  onCreateAddress,
  onCreateTransferRequest,
  transferRequests,
}: {
  addresses: WorkspaceAddress[];
  canManage: boolean;
  currentWorkspace: Workspace;
  onBackToDashboard: () => void;
  onBackToWatchSystem: () => void;
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
        <div className="headline-actions">
          <button className="ghost-button" onClick={onBackToDashboard} type="button">
            org dashboard
          </button>
          <button className="ghost-button" onClick={onBackToWatchSystem} type="button">
            watch system
          </button>
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

      <section className="setup-stage-grid">
        <div className="content-panel content-panel-strong" id="wallets-section">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Step 1</p>
              <h2>Wallets</h2>
              <p className="compact-copy">Save the wallets you care about first. Everything else in the workspace builds from this list.</p>
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

        <div className="content-panel content-panel-strong" id="planned-transfers-section">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Step 2</p>
              <h2>Planned transfers</h2>
              <p className="compact-copy">Once wallets exist, define the transfer shape you expect to observe on-chain.</p>
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
        <div className="content-panel content-panel-soft">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Matching note</p>
              <h2>How it works</h2>
              <p className="compact-copy">Keep the explanation light and operational. The page itself should carry the workflow.</p>
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

function ExceptionCard({
  exception,
  onAddNote,
  onApplyAction,
}: {
  exception: ExceptionItem;
  onAddNote: (exceptionId: string, body: string) => Promise<void>;
  onApplyAction: (
    exceptionId: string,
    action: 'reviewed' | 'expected' | 'dismissed' | 'reopen',
    note?: string,
  ) => Promise<void>;
}) {
  return (
    <div className="exception-card">
      <div className="exception-card-head">
        <div>
          <strong>{exception.reasonCode.replaceAll('_', ' ')}</strong>
          <small>{exception.severity} // {exception.status}</small>
        </div>
      </div>
      <p className="exception-copy">{exception.explanation}</p>
      {exception.availableActions?.length ? (
        <div className="exception-actions">
          {exception.availableActions.map((action) => (
            <button
              className="ghost-button compact-button"
              key={action}
              onClick={() => void onApplyAction(exception.exceptionId, action)}
              type="button"
            >
              {action === 'reopen' ? 'reopen' : `mark ${action}`}
            </button>
          ))}
        </div>
      ) : null}
      {exception.notes?.length ? (
        <div className="stack-list">
          {exception.notes.map((note) => (
            <div className="note-card" key={note.exceptionNoteId}>
              <strong>{note.authorUser?.displayName ?? note.authorUser?.email ?? 'Operator'}</strong>
              <small>{formatTimestamp(note.createdAt)}</small>
              <p>{note.body}</p>
            </div>
          ))}
        </div>
      ) : null}
      <form
        className="inline-note-form"
        onSubmit={(event) =>
          void handleNoteSubmit(event, (body) => onAddNote(exception.exceptionId, body))
        }
      >
        <label className="field">
          <span>Add exception note</span>
          <textarea name="body" placeholder="Record operator context or resolution notes." rows={3} />
        </label>
        <button className="ghost-button compact-button" type="submit">
          save note
        </button>
      </form>
    </div>
  );
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

function getDisplayStateLabel(state: ReconciliationRow['requestDisplayState']) {
  switch (state) {
    case 'matched':
      return 'matched';
    case 'partial':
      return 'partial';
    case 'exception':
      return 'exception';
    case 'pending':
    default:
      return 'pending';
  }
}

function getTimelineTitle(item: ReconciliationDetail['timeline'][number]) {
  switch (item.timelineType) {
    case 'request_event':
      return item.eventType.replaceAll('_', ' ');
    case 'request_note':
      return 'request note';
    case 'match_result':
      return item.matchStatus.replaceAll('_', ' ');
    case 'exception':
      return item.reasonCode.replaceAll('_', ' ');
  }
}

function getTimelineBody(item: ReconciliationDetail['timeline'][number]) {
  switch (item.timelineType) {
    case 'request_event':
      return item.beforeState && item.afterState
        ? `${item.beforeState.replaceAll('_', ' ')} -> ${item.afterState.replaceAll('_', ' ')}`
        : item.eventSource;
    case 'request_note':
      return item.body;
    case 'match_result':
      return item.explanation;
    case 'exception':
      return item.explanation;
  }
}

async function handleNoteSubmit(
  event: FormEvent<HTMLFormElement>,
  onSubmit: (body: string) => Promise<void>,
) {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const body = String(formData.get('body') ?? '').trim();
  if (!body) {
    return;
  }

  await onSubmit(body);
  form.reset();
}
