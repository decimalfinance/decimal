import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type {
  ApprovalPolicy,
  Counterparty,
  Destination,
  ExportJob,
  ExceptionItem,
  OpsHealth,
  ObservedTransfer,
  ReconciliationDetail,
  ReconciliationRow,
  TransferRequest,
  Workspace,
  WorkspaceAddress,
  WorkspaceAddressLite,
  WorkspaceMember,
} from '../types';
import { formatRawUsdc, formatRawUsdcCompact, formatRelativeTime, formatTimestamp, formatTimestampCompact, orbTransactionUrl, shortenAddress } from '../lib/app';
import { InfoLine, Metric } from '../components/ui';

function TableSurfaceHeader({
  actionDisabled = false,
  actionLabel,
  count,
  onAction,
  onSearchChange,
  searchPlaceholder,
  searchValue,
  title,
}: {
  actionDisabled?: boolean;
  actionLabel: string;
  count: number;
  onAction: () => void;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  searchValue: string;
  title: string;
}) {
  return (
    <div className="panel-header surface-panel-header">
      <div className="surface-panel-copy">
        <h2 className="registry-section-title">
          {title} <span className="registry-count-inline">[{count}]</span>
        </h2>
      </div>
      <div className="surface-toolbar">
        <label className="queue-select surface-search">
          <input
            value={searchValue}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={searchPlaceholder}
          />
        </label>
        <div className="surface-toolbar-actions">
          <button className="primary-button" disabled={actionDisabled} onClick={onAction} type="button">
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function WorkspaceHomePage({
  addresses,
  currentRole,
  currentWorkspace,
  isLoading,
  observedTransfers,
  onAddExceptionNote,
  onAddRequestNote,
  onApplyExceptionAction,
  onApplyApprovalDecision,
  onCreateExecutionRecord,
  onChangeReconciliationFilter,
  onDownloadAuditExport,
  onSelectObservedTransfer,
  onSelectReconciliation,
  onTransitionRequest,
  onUpdateExecutionRecord,
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
  onAddExceptionNote: (exceptionId: string, body: string, transferRequestId?: string | null) => Promise<void>;
  onAddRequestNote: (transferRequestId: string, body: string) => Promise<void>;
  onApplyExceptionAction: (
    exceptionId: string,
    action: 'reviewed' | 'expected' | 'dismissed' | 'reopen',
    transferRequestId?: string | null,
    note?: string,
  ) => Promise<void>;
  onApplyApprovalDecision: (
    transferRequestId: string,
    action: 'approve' | 'reject' | 'escalate',
    comment?: string,
  ) => Promise<void>;
  onCreateExecutionRecord: (transferRequestId: string) => Promise<void>;
  onChangeReconciliationFilter: (filter: ReconciliationRow['requestDisplayState'] | 'all') => void;
  onDownloadAuditExport: (transferRequestId: string) => Promise<void>;
  onSelectObservedTransfer: (transfer: ObservedTransfer) => void;
  onSelectReconciliation: (row: ReconciliationRow) => void;
  onTransitionRequest: (transferRequestId: string, toStatus: string) => Promise<void>;
  onUpdateExecutionRecord: (
    executionRecordId: string,
    input: {
      submittedSignature?: string;
      state?: 'ready_for_execution' | 'submitted_onchain' | 'broadcast_failed';
    },
    transferRequestId: string,
  ) => Promise<void>;
  reconciliationFilter: ReconciliationRow['requestDisplayState'] | 'all';
  reconciliationRows: ReconciliationRow[];
  selectedObservedTransfer: ObservedTransfer | null;
  selectedReconciliationDetail: ReconciliationDetail | null;
  transferRequests: TransferRequest[];
  isLoadingReconciliationDetail: boolean;
}) {
  const matchedCount = reconciliationRows.filter((row) => row.requestDisplayState === 'matched').length;
  const pendingCount = reconciliationRows.filter((row) => row.requestDisplayState === 'pending').length;
  const [approvalComment, setApprovalComment] = useState('');
  const [executionSignature, setExecutionSignature] = useState('');
  const [isRequestInspectorOpen, setIsRequestInspectorOpen] = useState(false);

  useEffect(() => {
    setApprovalComment('');
    setExecutionSignature('');
  }, [selectedReconciliationDetail?.transferRequestId]);

  useEffect(() => {
    if (selectedReconciliationDetail?.latestExecution?.submittedSignature) {
      setExecutionSignature('');
    }
  }, [selectedReconciliationDetail?.latestExecution?.submittedSignature]);

  useEffect(() => {
    if (selectedReconciliationDetail) {
      setIsRequestInspectorOpen(true);
    }
  }, [selectedReconciliationDetail?.transferRequestId]);

  const hasObservedSettlementWithoutExecution =
    selectedReconciliationDetail !== null
    && !selectedReconciliationDetail.latestExecution
    && Boolean(
      selectedReconciliationDetail.match
      || selectedReconciliationDetail.linkedSignature
      || selectedReconciliationDetail.observedExecutionTransaction,
    );

  const summarySignature = selectedReconciliationDetail
    ? getPrimarySettlementSignature(selectedReconciliationDetail)
    : null;
  const summarySourceAddress = selectedReconciliationDetail
    ? getPrimarySourceAddress(selectedReconciliationDetail)
    : null;
  const summaryDestinationAddress = selectedReconciliationDetail
    ? getPrimaryDestinationAddress(selectedReconciliationDetail)
    : null;
  const summaryTime = selectedReconciliationDetail
    ? getPrimarySettlementTime(selectedReconciliationDetail)
    : null;
  const sourceWalletHint = summarySourceAddress ? findWorkspaceAddressByChainValue(addresses, summarySourceAddress) : null;
  const destinationWalletHint = summaryDestinationAddress ? findWorkspaceAddressByChainValue(addresses, summaryDestinationAddress) : null;

  return (
    <div className="page-stack">
      <section className="section-headline section-headline-compact">
        <div className="section-headline-copy">
          <p className="eyebrow">Workspace</p>
          <h1>{currentWorkspace.workspaceName}</h1>
          <p className="section-copy">
            Save wallets, create planned transfers, observe real USDC transfers, and reconcile them against what you expected.
          </p>
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

      <section className="workspace-home-grid workspace-home-grid-single">
        <div className="workspace-home-primary">
          <div className="content-panel content-panel-strong">
            <div className="panel-header panel-header-stack">
              <div>
                <p className="eyebrow">Live queue</p>
                <h2>Requests in motion</h2>
                <p className="compact-copy">
                  This is the watch surface. Start with what is live, what needs attention, and what has already settled.
                </p>
              </div>
              <span className="status-chip">{reconciliationRows.length} live</span>
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

            <div className="request-table ops-request-table">
              <div className="request-table-head">
                <span>Request ID</span>
                <span>Source</span>
                <span>Destination</span>
                <span>Amount</span>
                <span>Approval</span>
                <span>Execution</span>
                <span>Settlement</span>
                <span>Requested</span>
              </div>
              {reconciliationRows.length ? (
                reconciliationRows.map((row) => (
                  <div
                    key={row.transferRequestId}
                    className={
                      selectedReconciliationDetail?.transferRequestId === row.transferRequestId
                        ? 'request-table-row is-active'
                        : 'request-table-row'
                    }
                  >
                    <button
                      className="request-row-button"
                      onClick={() => {
                        setIsRequestInspectorOpen(true);
                        onSelectReconciliation(row);
                      }}
                      type="button"
                    >
                      <span className="request-cell-primary">
                        <strong>{shortenAddress(row.transferRequestId, 8, 6)}</strong>
                      </span>
                      <span className="request-cell-single">
                        <strong>{row.sourceWorkspaceAddress ? getWalletNameLite(row.sourceWorkspaceAddress) : 'Not set'}</strong>
                      </span>
                      <span className="request-cell-single">
                        <strong>{getDestinationLabel(row.destination, row.destinationWorkspaceAddress)}</strong>
                      </span>
                      <span className="request-cell-amount request-cell-single">
                        <strong>{formatRawUsdc(row.amountRaw)}</strong>
                      </span>
                      <span className="request-cell-single">
                        <span className={`tone-pill tone-pill-${mapApprovalTone(row.approvalState)}`}>
                          {getApprovalStateLabel(row.approvalState)}
                        </span>
                      </span>
                      <span className="request-cell-single">
                        <span className={`tone-pill tone-pill-${mapExecutionTone(getExecutionStateForRow(row))}`}>
                          {getExecutionStateLabel(getExecutionStateForRow(row), row)}
                        </span>
                      </span>
                      <span className="request-cell-single">
                        <span className={`tone-pill tone-pill-${getSettlementTone(row)}`}>
                          {getDisplayStateLabel(row)}
                        </span>
                      </span>
                      <span className="request-cell-single">{formatTimestampCompact(row.requestedAt)}</span>
                    </button>
                  </div>
                ))
              ) : (
                <div className="empty-box compact">No planned transfers yet. Open setup and create the first one.</div>
              )}
            </div>
          </div>

          <div className="content-panel content-panel-soft">
            <div className="panel-header panel-header-stack">
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
                      <span className="transfer-table-meta">{getObservedTransferTypeLabel(transfer.legRole)}</span>
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
              <div className="transfer-inspector-drawer transfer-inspector-inline">
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
                  <InfoLine label="Leg role" value={getObservedTransferTypeLabel(selectedObservedTransfer.legRole)} />
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
        </div>
      </section>

      {isRequestInspectorOpen ? (
        <div className="registry-modal-backdrop" onClick={() => setIsRequestInspectorOpen(false)} role="presentation">
          <div
            className="registry-modal registry-modal-wide request-inspector-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            {selectedReconciliationDetail ? (
              <div className="transfer-inspector-drawer transfer-inspector-sticky">
                <div className="registry-modal-hero request-modal-hero">
                  <div className="registry-modal-hero-copy">
                    <p className="eyebrow">Request inspector</p>
                    <h2>Request and match</h2>
                  </div>
                  <div className="exception-actions">
                    <button
                      className="ghost-button compact-button"
                      onClick={() => void onDownloadAuditExport(selectedReconciliationDetail.transferRequestId)}
                      type="button"
                    >
                      export audit
                    </button>
                    <button className="ghost-button danger-button" onClick={() => setIsRequestInspectorOpen(false)} type="button">
                      close
                    </button>
                  </div>
                </div>
                <div className="request-chain-summary">
                  <div className="request-chain-summary-amount">
                    <span className="eyebrow">Amount</span>
                    <div className="request-chain-summary-amount-value">
                      <strong>{formatRawUsdcCompact(selectedReconciliationDetail.amountRaw)} USDC</strong>
                      <span>{formatUsdcUsdBadge(selectedReconciliationDetail.amountRaw)}</span>
                    </div>
                    <p className="request-chain-summary-status">
                      <strong>{getCompletionHeadline(selectedReconciliationDetail)}</strong>
                      <span>{getCompletionSubtext(selectedReconciliationDetail)}</span>
                    </p>
                  </div>
                  <div className="request-chain-summary-row">
                    <ChainSummaryBlock
                      label="Signature"
                      title={summarySignature ?? undefined}
                      value={summarySignature ? shortenAddress(summarySignature, 6, 6) : 'No linked signature'}
                      onCopy={summarySignature ? () => void navigator.clipboard.writeText(summarySignature).catch(() => undefined) : undefined}
                      copyTitle="Copy signature"
                    />
                    <ChainSummaryBlock
                      label="From"
                      title={sourceWalletHint ? `${sourceWalletHint.displayName ?? sourceWalletHint.address} // ${summarySourceAddress}` : summarySourceAddress ?? undefined}
                      value={summarySourceAddress ? shortenAddress(summarySourceAddress, 6, 6) : 'Not set'}
                      onCopy={summarySourceAddress ? () => void navigator.clipboard.writeText(summarySourceAddress).catch(() => undefined) : undefined}
                      copyTitle="Copy source wallet"
                    />
                    <ChainSummaryBlock
                      label="To"
                      title={destinationWalletHint ? `${destinationWalletHint.displayName ?? destinationWalletHint.address} // ${summaryDestinationAddress}` : summaryDestinationAddress ?? undefined}
                      value={summaryDestinationAddress ? shortenAddress(summaryDestinationAddress, 6, 6) : 'Destination not resolved'}
                      onCopy={summaryDestinationAddress ? () => void navigator.clipboard.writeText(summaryDestinationAddress).catch(() => undefined) : undefined}
                      copyTitle="Copy destination wallet"
                    />
                    <ChainSummaryBlock
                      label="Time"
                      title={summaryTime ? formatTimestamp(summaryTime) : undefined}
                      value={summaryTime ? formatRelativeTime(summaryTime) : 'Pending'}
                    />
                    <div className="chain-summary-top-action">
                      {summarySignature ? (
                        <a
                          className="ghost-button compact-button chain-summary-icon chain-summary-icon-large"
                          href={orbTransactionUrl(summarySignature)}
                          rel="noreferrer"
                          target="_blank"
                          title="Open settlement on Orb"
                        >
                          ↗
                        </a>
                      ) : null}
                    </div>
                  </div>
                </div>
                <div className="request-inspector-layout">
                  <div className="request-inspector-side">
                    <div className="request-section-card request-inspector-facts">
                      <InfoLine
                        label="Counterparty"
                        value={selectedReconciliationDetail.destination?.counterparty?.displayName ?? 'Unassigned'}
                      />
                      <InfoLine
                        label="Destination trust"
                        value={selectedReconciliationDetail.destination?.trustState ?? 'unreviewed'}
                      />
                      <InfoLine
                        label="Destination scope"
                        value={selectedReconciliationDetail.destination?.isInternal ? 'internal' : 'external'}
                      />
                      <InfoLine
                        label="Receiving wallet"
                        value={
                          shortenAddress(
                            selectedReconciliationDetail.destination?.walletAddress
                            ?? selectedReconciliationDetail.destinationWorkspaceAddress?.address,
                            8,
                            6,
                          )
                        }
                      />
                      <InfoLine
                        label="Receiving USDC ATA"
                        value={
                          shortenAddress(
                            selectedReconciliationDetail.destination?.tokenAccountAddress
                            ?? selectedReconciliationDetail.destinationWorkspaceAddress?.usdcAtaAddress,
                            8,
                            6,
                          )
                        }
                      />
                      <InfoLine label="Requested at" value={formatTimestamp(selectedReconciliationDetail.requestedAt)} />
                    </div>

                    <div className="state-summary-grid request-state-grid request-state-grid-wide">
                      <div className="state-summary-card">
                        <span className="eyebrow">Approval</span>
                        <strong>{getApprovalStateLabel(selectedReconciliationDetail.approvalState)}</strong>
                      </div>
                      <div className="state-summary-card">
                        <span className="eyebrow">Execution</span>
                        <strong>{getExecutionStateLabel(selectedReconciliationDetail.executionState, selectedReconciliationDetail)}</strong>
                      </div>
                      <div className="state-summary-card">
                        <span className="eyebrow">Reconciliation</span>
                        <strong>{getDisplayStateLabel(selectedReconciliationDetail)}</strong>
                      </div>
                    </div>

                    <InspectorAccordion
                      defaultOpen
                      status={
                        selectedReconciliationDetail.latestExecution
                          ? 'tracked attempt'
                          : hasObservedSettlementWithoutExecution
                            ? 'observed without record'
                            : 'no attempt yet'
                      }
                      title="Execution tracking"
                    >
                        {selectedReconciliationDetail.latestExecution ? (
                          <div className="stack-list">
                          <InfoLine
                            label="Execution state"
                            value={getExecutionStateLabel(selectedReconciliationDetail.executionState, selectedReconciliationDetail)}
                          />
                          <InfoLine
                            label="Execution source"
                            value={selectedReconciliationDetail.latestExecution.executionSource.replaceAll('_', ' ')}
                          />
                          <InfoLine
                            label="Attempt created"
                            value={formatTimestamp(selectedReconciliationDetail.latestExecution.createdAt)}
                          />
                          <InfoLine
                            label="Submitted at"
                            value={
                              selectedReconciliationDetail.latestExecution.submittedAt
                                ? formatTimestamp(selectedReconciliationDetail.latestExecution.submittedAt)
                                : 'Not submitted yet'
                            }
                          />
                          <InfoLine
                            label="Submitted signature"
                            value={
                              selectedReconciliationDetail.latestExecution.submittedSignature
                                ? shortenAddress(selectedReconciliationDetail.latestExecution.submittedSignature, 10, 10)
                                : 'Not attached yet'
                            }
                          />
                          <InfoLine
                            label="Observed onchain"
                            value={
                              selectedReconciliationDetail.observedExecutionTransaction
                                ? formatTimestamp(selectedReconciliationDetail.observedExecutionTransaction.eventTime)
                                : 'No observed transaction yet'
                            }
                          />

                          {selectedReconciliationDetail.latestExecution.submittedSignature ? (
                            <div className="inspector-callout">
                              <div>
                                <p className="eyebrow">Submitted signature</p>
                                <strong>
                                  {shortenAddress(selectedReconciliationDetail.latestExecution.submittedSignature, 10, 10)}
                                </strong>
                              </div>
                              <a
                                className="ghost-button inline-link-button"
                                href={orbTransactionUrl(selectedReconciliationDetail.latestExecution.submittedSignature)}
                                rel="noreferrer"
                                target="_blank"
                              >
                                open on orb
                              </a>
                            </div>
                          ) : null}

                          {!selectedReconciliationDetail.latestExecution.submittedSignature ? (
                            <div className="detail-section request-subsection-card">
                              <label className="field">
                                <span>Attach submitted signature</span>
                                <input
                                  name="executionSignature"
                                  onChange={(event) => setExecutionSignature(event.target.value)}
                                  placeholder="Paste the submitted transaction signature"
                                  type="text"
                                  value={executionSignature}
                                />
                              </label>
                              <div className="exception-actions">
                                <button
                                  className="primary-button compact-button"
                                  onClick={() =>
                                    void onUpdateExecutionRecord(
                                      selectedReconciliationDetail.latestExecution!.executionRecordId,
                                      { submittedSignature: executionSignature.trim() || undefined },
                                      selectedReconciliationDetail.transferRequestId,
                                    )
                                  }
                                  type="button"
                                >
                                  attach signature
                                </button>
                              </div>
                            </div>
                          ) : null}

                          {selectedReconciliationDetail.latestExecution.submittedSignature
                          && !selectedReconciliationDetail.observedExecutionTransaction
                          && selectedReconciliationDetail.executionState === 'submitted_onchain' ? (
                            <div className="exception-actions">
                              <button
                                className="ghost-button compact-button"
                                onClick={() =>
                                  void onUpdateExecutionRecord(
                                    selectedReconciliationDetail.latestExecution!.executionRecordId,
                                    { state: 'broadcast_failed' },
                                    selectedReconciliationDetail.transferRequestId,
                                  )
                                }
                                type="button"
                              >
                                mark broadcast failed
                              </button>
                            </div>
                          ) : null}

                          {selectedReconciliationDetail.executionRecords.length > 1 ? (
                            <div className="detail-section request-subsection-card">
                              <div className="detail-section-head">
                                <strong>Execution history</strong>
                                <span>{selectedReconciliationDetail.executionRecords.length}</span>
                              </div>
                              <div className="stack-list">
                                {selectedReconciliationDetail.executionRecords.map((execution) => (
                                  <div className="note-card" key={execution.executionRecordId}>
                                    <strong>{getExecutionStateLabel(execution.state)}</strong>
                                    <small>
                                      {formatTimestamp(execution.createdAt)} // {execution.executionSource.replaceAll('_', ' ')}
                                    </small>
                                    <p>
                                      {execution.submittedSignature
                                        ? `Submitted ${shortenAddress(execution.submittedSignature, 8, 8)}`
                                        : 'No signature attached yet.'}
                                    </p>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : null}
                          </div>
                        ) : hasObservedSettlementWithoutExecution ? (
                          <div className="stack-list">
                          <div className="empty-box compact">
                            Settlement was linked to this request, but no execution record was created in the product first.
                          </div>
                          <InfoLine
                            label="Observed settlement"
                            value={
                              selectedReconciliationDetail.match?.matchedAt
                                ? formatTimestamp(selectedReconciliationDetail.match.matchedAt)
                                : selectedReconciliationDetail.observedExecutionTransaction
                                  ? formatTimestamp(selectedReconciliationDetail.observedExecutionTransaction.eventTime)
                                  : 'Observed'
                            }
                          />
                          <InfoLine
                            label="Settlement signature"
                            value={
                              selectedReconciliationDetail.linkedSignature
                                ? selectedReconciliationDetail.linkedSignature
                                : 'Linked through observed settlement'
                            }
                          />
                          </div>
                        ) : (
                          <div className="stack-list">
                          <div className="empty-box compact">
                            No execution attempt is recorded yet. This request is approved, but that does not mean anything has been sent.
                          </div>
                          {selectedReconciliationDetail.approvalState === 'approved' ? (
                            <div className="exception-actions">
                              <button
                                className="primary-button compact-button"
                                onClick={() => void onCreateExecutionRecord(selectedReconciliationDetail.transferRequestId)}
                                type="button"
                              >
                              create execution record
                            </button>
                          </div>
                        ) : null}
                          </div>
                        )}
                    </InspectorAccordion>
                  </div>

                  <div className="request-inspector-main">
                    <InspectorAccordion
                      defaultOpen
                      status={getApprovalStateLabel(selectedReconciliationDetail.approvalState)}
                      title="Approval"
                    >
                        {selectedReconciliationDetail.approvalEvaluation.requiresApproval ? (
                          <div className="stack-list">
                            <div className="empty-box compact">
                              This request was routed into the approval inbox by{' '}
                              {selectedReconciliationDetail.approvalEvaluation.policyName}.
                            </div>
                            <div className="reason-list">
                              {selectedReconciliationDetail.approvalEvaluation.reasons.map((reason) => (
                                <div className="reason-card" key={reason.code}>
                                  <strong>{getApprovalReasonLabel(reason.code)}</strong>
                                  <p>{reason.message}</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <div className="empty-box compact">
                            Auto-approved by {selectedReconciliationDetail.approvalEvaluation.policyName}.
                          </div>
                        )}

                        {(selectedReconciliationDetail.approvalState === 'pending_approval'
                          || selectedReconciliationDetail.approvalState === 'escalated') ? (
                          <div className="detail-section request-subsection-card">
                            <div className="detail-section-head">
                              <strong>Approval actions</strong>
                              <span>
                                {selectedReconciliationDetail.approvalState === 'escalated'
                                  ? 'escalated review'
                                  : 'waiting for review'}
                              </span>
                            </div>
                            <label className="field">
                              <span>Comment</span>
                              <textarea
                                name="approvalComment"
                                onChange={(event) => setApprovalComment(event.target.value)}
                                placeholder="Optional approval context"
                                rows={3}
                                value={approvalComment}
                              />
                            </label>
                            <div className="exception-actions">
                              <button
                                className="primary-button compact-button"
                                onClick={() =>
                                  void onApplyApprovalDecision(
                                    selectedReconciliationDetail.transferRequestId,
                                    'approve',
                                    approvalComment,
                                  )
                                }
                                type="button"
                              >
                                approve
                              </button>
                              <button
                                className="ghost-button compact-button"
                                onClick={() =>
                                  void onApplyApprovalDecision(
                                    selectedReconciliationDetail.transferRequestId,
                                    'reject',
                                    approvalComment,
                                  )
                                }
                                type="button"
                              >
                                reject
                              </button>
                              {selectedReconciliationDetail.approvalState === 'pending_approval' ? (
                                <button
                                  className="ghost-button compact-button"
                                  onClick={() =>
                                    void onApplyApprovalDecision(
                                      selectedReconciliationDetail.transferRequestId,
                                      'escalate',
                                      approvalComment,
                                    )
                                  }
                                  type="button"
                                >
                                  escalate
                                </button>
                              ) : null}
                            </div>
                          </div>
                        ) : null}

                        {(selectedReconciliationDetail.approvalDecisions.length > 1
                          || selectedReconciliationDetail.approvalEvaluation.requiresApproval) ? (
                          <div className="stack-list">
                            {selectedReconciliationDetail.approvalDecisions.map((decision) => (
                              <div className="note-card" key={decision.approvalDecisionId}>
                                <strong>{getApprovalActionLabel(decision.action)}</strong>
                                <small>
                                  {decision.actorUser?.displayName ?? decision.actorUser?.email ?? decision.actorType} //{' '}
                                  {formatTimestamp(decision.createdAt)}
                                </small>
                                {decision.payloadJson
                                && 'reasons' in decision.payloadJson
                                && selectedReconciliationDetail.approvalEvaluation.requiresApproval ? (
                                  <p>{getApprovalDecisionSummary(decision.action)}</p>
                                ) : null}
                                {decision.comment ? <p>{decision.comment}</p> : null}
                              </div>
                            ))}
                          </div>
                        ) : null}
                    </InspectorAccordion>

                  {selectedReconciliationDetail.availableTransitions.length ? (
                    <InspectorAccordion
                      status={String(selectedReconciliationDetail.availableTransitions.length)}
                      title="Request actions"
                    >
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
                    </InspectorAccordion>
                  ) : null}

                    <InspectorAccordion
                      defaultOpen
                      status={getDisplayStateLabel(selectedReconciliationDetail)}
                      title="Settlement"
                    >
                      {selectedReconciliationDetail.linkedSignature ? (
                        <div className="inspector-callout request-section-card">
                          <div>
                            <p className="eyebrow">Settlement signature</p>
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
                        <div className="detail-section request-section-card">
                          <InfoLine label="Match rule" value={selectedReconciliationDetail.match.matchRule} />
                          <InfoLine
                            label="Match status"
                            value={selectedReconciliationDetail.match.matchStatus.replaceAll('_', ' ')}
                          />
                          <InfoLine
                            label="Matched amount"
                            value={formatRawUsdc(selectedReconciliationDetail.match.matchedAmountRaw)}
                          />
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
                          <div className="empty-box compact">
                            {selectedReconciliationDetail.matchExplanation ?? 'No explanation yet.'}
                          </div>
                        </div>
                      ) : (
                        <div className="empty-box compact request-section-card">
                          No exact match yet. The request is still waiting for a compatible observed payment.
                        </div>
                      )}

                      {selectedReconciliationDetail.linkedObservedPayment ? (
                        <div className="empty-box compact request-section-card">
                          <strong>Observed payment</strong>
                          <div className="detail-grid">
                            <span>{getObservedPaymentKindLabel(selectedReconciliationDetail.linkedObservedPayment.paymentKind)}</span>
                            <span>{formatRawUsdc(selectedReconciliationDetail.linkedObservedPayment.netDestinationAmountRaw)}</span>
                            <span>{selectedReconciliationDetail.linkedObservedPayment.routeCount} route(s)</span>
                          </div>
                        </div>
                      ) : null}

                      {selectedReconciliationDetail.relatedObservedPayments.length > 1 ? (
                        <div className="detail-section request-section-card">
                          <div className="detail-section-head">
                            <strong>Settlement breakdown</strong>
                            <span>{selectedReconciliationDetail.relatedObservedPayments.length}</span>
                          </div>
                          <div className="stack-list">
                            {selectedReconciliationDetail.relatedObservedPayments.map((payment) => (
                              <div className="note-card" key={payment.paymentId}>
                                <strong>{payment.destinationLabel ?? payment.destinationWallet ?? 'Unknown destination'}</strong>
                                <small>
                                  {payment.recipientRole
                                    ? payment.recipientRole.replaceAll('_', ' ')
                                    : 'destination'}
                                </small>
                                <p>{formatRawUsdc(payment.netDestinationAmountRaw)} USDC</p>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}

                    </InspectorAccordion>

                    {selectedReconciliationDetail.exceptions.length ? (
                      <InspectorAccordion
                        defaultOpen
                        status={String(selectedReconciliationDetail.exceptions.length)}
                        title="Exceptions"
                      >
                          <div className="empty-box compact request-section-card">
                            {selectedReconciliationDetail.exceptionExplanation ??
                              'Exceptions are preventing this request from being treated as fully settled.'}
                          </div>
                          <div className="stack-list">
                            {selectedReconciliationDetail.exceptions.map((exception) => (
                              <ExceptionCard
                                exception={exception}
                                key={exception.exceptionId}
                                onAddNote={onAddExceptionNote}
                                onApplyAction={onApplyExceptionAction}
                              />
                            ))}
                          </div>
                      </InspectorAccordion>
                    ) : null}

                    <InspectorAccordion
                      status={String(selectedReconciliationDetail.timeline.length)}
                      title="Timeline"
                    >
                        <div className="detail-section request-section-card request-timeline-section">
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
                    </InspectorAccordion>

                    <InspectorAccordion
                      status={String(selectedReconciliationDetail.notes.length)}
                      title="Request notes"
                    >
                        <div className="detail-section request-section-card">
                          <div className="detail-section-head">
                            <strong>Notes</strong>
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
                    </InspectorAccordion>
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
        </div>
      ) : null}
    </div>
  );
}

export function WorkspaceRegistryPage({
  addresses,
  canManage,
  counterparties,
  currentWorkspace,
  destinations,
  onCreateAddress,
  onCreateCounterparty,
  onCreateDestination,
  onUpdateAddress,
  onUpdateCounterparty,
  onUpdateDestination,
}: {
  addresses: WorkspaceAddress[];
  canManage: boolean;
  counterparties: Counterparty[];
  currentWorkspace: Workspace;
  destinations: Destination[];
  onCreateAddress: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onCreateCounterparty: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onCreateDestination: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onUpdateAddress: (workspaceAddressId: string, event: FormEvent<HTMLFormElement>) => Promise<void>;
  onUpdateCounterparty: (counterpartyId: string, event: FormEvent<HTMLFormElement>) => Promise<void>;
  onUpdateDestination: (destinationId: string, event: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [trustFilter, setTrustFilter] = useState<'all' | Destination['trustState']>('all');
  const [scopeFilter, setScopeFilter] = useState<'all' | 'internal' | 'external'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [copiedWalletId, setCopiedWalletId] = useState<string | null>(null);
  const [modalState, setModalState] = useState<
    | { type: 'create-wallet' }
    | { type: 'edit-wallet'; workspaceAddressId: string }
    | { type: 'create-counterparty' }
    | { type: 'edit-counterparty'; counterpartyId: string }
    | { type: 'create-destination'; linkedWorkspaceAddressId?: string }
    | { type: 'edit-destination'; destinationId: string }
    | { type: 'view-destination'; destinationId: string }
    | null
  >(null);

  const selectedDestination =
    modalState?.type === 'view-destination'
      ? destinations.find((item) => item.destinationId === modalState.destinationId) ?? null
      : null;
  const selectedDestinationWallet = selectedDestination?.linkedWorkspaceAddress ?? null;
  const selectedDestinationCounterparty = selectedDestination?.counterparty ?? null;

  const editingAddress =
    modalState?.type === 'edit-wallet'
      ? addresses.find((item) => item.workspaceAddressId === modalState.workspaceAddressId) ?? null
      : null;
  const editingCounterparty =
    modalState?.type === 'edit-counterparty'
      ? counterparties.find((item) => item.counterpartyId === modalState.counterpartyId) ?? null
      : null;
  const editingDestination =
    modalState?.type === 'edit-destination'
      ? destinations.find((item) => item.destinationId === modalState.destinationId) ?? null
      : null;

  useEffect(() => {
    if (modalState?.type === 'edit-wallet' && !editingAddress) {
      setModalState(null);
    }
    if (modalState?.type === 'edit-counterparty' && !editingCounterparty) {
      setModalState(null);
    }
    if (modalState?.type === 'edit-destination' && !editingDestination) {
      setModalState(null);
    }
  }, [editingAddress, editingCounterparty, editingDestination, modalState]);

  const filteredDestinations = destinations.filter((item) => {
    const matchesSearch = !searchQuery.trim()
      || [
        item.label,
        item.walletAddress,
        item.destinationType,
        item.counterparty?.displayName ?? '',
        item.linkedWorkspaceAddress?.displayName ?? '',
        item.linkedWorkspaceAddress?.address ?? '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(searchQuery.trim().toLowerCase());
    const matchesTrust = trustFilter === 'all' || item.trustState === trustFilter;
    const matchesScope =
      scopeFilter === 'all'
      || (scopeFilter === 'internal' ? item.isInternal : !item.isInternal);
    const matchesStatus =
      statusFilter === 'all'
      || (statusFilter === 'active' ? item.isActive : !item.isActive);

    return matchesSearch && matchesTrust && matchesScope && matchesStatus;
  });

  const linkedWalletIds = new Set(destinations.map((item) => item.linkedWorkspaceAddressId).filter(Boolean));
  const destinationsByWalletId = new Map<string, Destination[]>();
  for (const destination of destinations) {
    if (!destination.linkedWorkspaceAddressId) {
      continue;
    }
    const existing = destinationsByWalletId.get(destination.linkedWorkspaceAddressId) ?? [];
    existing.push(destination);
    destinationsByWalletId.set(destination.linkedWorkspaceAddressId, existing);
  }
  const counterpartyWalletCount = new Map<string, number>();
  for (const counterparty of counterparties) {
    const walletIds = new Set(
      destinations
        .filter((item) => item.counterpartyId === counterparty.counterpartyId && item.linkedWorkspaceAddressId)
        .map((item) => item.linkedWorkspaceAddressId as string),
    );
    counterpartyWalletCount.set(counterparty.counterpartyId, walletIds.size);
  }

  useEffect(() => {
    if (!copiedWalletId) {
      return;
    }

    const timeout = window.setTimeout(() => setCopiedWalletId(null), 1200);
    return () => window.clearTimeout(timeout);
  }, [copiedWalletId]);

  async function handleAddressSubmit(event: FormEvent<HTMLFormElement>) {
    if (editingAddress) {
      await onUpdateAddress(editingAddress.workspaceAddressId, event);
    } else {
      await onCreateAddress(event);
    }
    setModalState(null);
  }

  async function handleCounterpartySubmit(event: FormEvent<HTMLFormElement>) {
    if (editingCounterparty) {
      await onUpdateCounterparty(editingCounterparty.counterpartyId, event);
    } else {
      await onCreateCounterparty(event);
    }
    setModalState(null);
  }

  async function handleDestinationSubmit(event: FormEvent<HTMLFormElement>) {
    if (editingDestination) {
      await onUpdateDestination(editingDestination.destinationId, event);
    } else {
      await onCreateDestination(event);
    }
    setModalState(null);
  }

  async function handleCopyWalletAddress(workspaceAddressId: string, address: string) {
    try {
      await navigator.clipboard.writeText(address);
      setCopiedWalletId(workspaceAddressId);
    } catch {
      setCopiedWalletId(null);
    }
  }

  return (
    <div className="page-stack page-stack-tight">
      <section className="section-headline section-headline-compact">
        <div className="section-headline-copy">
          <p className="eyebrow">Address Book</p>
          <h1>{currentWorkspace.workspaceName}</h1>
          <p className="section-copy">
            Save raw wallets, optionally define business owners, and name the payment destinations operators should use elsewhere in the product.
          </p>
        </div>
      </section>

      {!canManage ? (
        <div className="notice-banner">
          <div>
            <strong>Read only.</strong>
            <p>Only organization admins can change wallets, destinations, and planned transfers in this workspace.</p>
          </div>
        </div>
      ) : null}

      <section className="registry-shell">
        <div className="content-panel content-panel-strong registry-main-panel">
          <TableSurfaceHeader
            actionDisabled={!canManage || addresses.length === 0}
            actionLabel="New destination"
            count={destinations.length}
            onAction={() => setModalState({ type: 'create-destination' })}
            onSearchChange={setSearchQuery}
            searchPlaceholder="Search destination, wallet, or counterparty"
            searchValue={searchQuery}
            title="Destinations"
          />

          <div className="registry-table">
            <div className="registry-table-head">
              <span className="registry-head-cell">Destination</span>
              <span className="registry-head-cell">Wallet</span>
              <span className="registry-head-cell">Owner</span>
              <label className="registry-head-filter">
                <span>Trust</span>
                <select value={trustFilter} onChange={(event) => setTrustFilter(event.target.value as typeof trustFilter)}>
                  <option value="all">all</option>
                  <option value="trusted">trusted</option>
                  <option value="unreviewed">unreviewed</option>
                  <option value="restricted">restricted</option>
                  <option value="blocked">blocked</option>
                </select>
              </label>
              <label className="registry-head-filter">
                <span>Scope</span>
                <select value={scopeFilter} onChange={(event) => setScopeFilter(event.target.value as typeof scopeFilter)}>
                  <option value="all">all</option>
                  <option value="external">external</option>
                  <option value="internal">internal</option>
                </select>
              </label>
              <label className="registry-head-filter">
                <span>Status</span>
                <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
                  <option value="all">all</option>
                  <option value="active">active</option>
                  <option value="inactive">inactive</option>
                </select>
              </label>
            </div>
            {filteredDestinations.length ? (
              filteredDestinations.map((item) => (
                <div
                  key={item.destinationId}
                  className="registry-table-row"
                >
                  <button
                    className="registry-row-button"
                    onClick={() => setModalState({ type: 'view-destination', destinationId: item.destinationId })}
                    type="button"
                  >
                    <span className="registry-cell-primary">
                      <strong>{item.label}</strong>
                    </span>
                    <span className="registry-cell-mono" title={item.linkedWorkspaceAddress?.address ?? item.walletAddress}>
                      {getWalletNameLite(item.linkedWorkspaceAddress)}
                    </span>
                    <span>{item.counterparty?.displayName ?? 'Unassigned'}</span>
                    <span><span className={`tone-pill tone-pill-${mapDestinationTone(item.trustState)}`}>{item.trustState}</span></span>
                    <span>{item.isInternal ? 'internal' : 'external'}</span>
                    <span>{item.isActive ? 'active' : 'inactive'}</span>
                  </button>
                </div>
              ))
            ) : destinations.length ? (
              <div className="empty-box compact">No destinations match the current search or filters.</div>
            ) : (
              <div className="empty-box compact">
                <strong>No destinations yet.</strong>
                <p>Start by turning one of the saved wallets into a named destination. That is the object operators will actually use in requests.</p>
                {canManage && addresses.length ? (
                  <button className="primary-button" onClick={() => setModalState({ type: 'create-destination' })} type="button">
                    Create first destination
                  </button>
                ) : null}
              </div>
            )}
          </div>
        </div>

        <div className="registry-sidecar">
          <div className="content-panel content-panel-soft">
            <div className="panel-header">
              <div>
                <h2 className="registry-section-title">
                  Wallets <span className="registry-count-inline">[{addresses.length}]</span>
                </h2>
              </div>
              <div className="panel-header-actions">
                {canManage ? (
                  <button className="primary-button compact-button" onClick={() => setModalState({ type: 'create-wallet' })} type="button">
                    Add wallet
                  </button>
                ) : null}
              </div>
            </div>
            <div className="wallet-table">
              <div className="wallet-table-head">
                <span>Name</span>
                <span>Address</span>
                <span>Destination</span>
                <span>Status</span>
              </div>
              {addresses.length ? (
                addresses.map((item) => {
                  const linkedDestinations = destinationsByWalletId.get(item.workspaceAddressId) ?? [];
                  const primaryDestination = linkedDestinations[0] ?? null;
                  return (
                    <div key={item.workspaceAddressId} className="wallet-table-row">
                      <span className="wallet-table-name">{getWalletName(item)}</span>
                      <span>
                        <button
                          className="wallet-address-button"
                          onClick={() => void handleCopyWalletAddress(item.workspaceAddressId, item.address)}
                          title={copiedWalletId === item.workspaceAddressId ? 'Copied' : item.address}
                          type="button"
                        >
                          {shortenAddress(item.address)}
                        </button>
                      </span>
                      <span>
                        {primaryDestination ? (
                          <button
                            className="wallet-link-button"
                            onClick={() => setModalState({ type: 'view-destination', destinationId: primaryDestination.destinationId })}
                            type="button"
                          >
                            {primaryDestination.label}
                            {linkedDestinations.length > 1 ? ` +${linkedDestinations.length - 1}` : ''}
                          </button>
                        ) : (
                          'unlinked'
                        )}
                      </span>
                      <span>{item.isActive ? 'active' : 'inactive'}</span>
                    </div>
                  );
                })
              ) : (
                <div className="empty-box compact">No wallets saved yet.</div>
              )}
            </div>
          </div>

          <div className="content-panel content-panel-soft">
            <div className="panel-header">
              <div>
                <h2 className="registry-section-title">
                  Counterparties <span className="registry-count-inline">[{counterparties.length}]</span>
                </h2>
              </div>
              <div className="panel-header-actions">
                {canManage ? (
                  <button className="primary-button compact-button" onClick={() => setModalState({ type: 'create-counterparty' })} type="button">
                    Add counterparty
                  </button>
                ) : null}
              </div>
            </div>
            <div className="counterparty-table">
              <div className="counterparty-table-head">
                <span>Name</span>
                <span>Wallets</span>
              </div>
              {counterparties.length ? (
                counterparties.map((item) => (
                  <div key={item.counterpartyId} className="counterparty-table-row">
                    <span className="counterparty-table-name">{item.displayName}</span>
                    <span>{counterpartyWalletCount.get(item.counterpartyId) ?? 0}</span>
                  </div>
                ))
              ) : (
                <div className="empty-box compact">No counterparties saved yet.</div>
              )}
            </div>
          </div>
        </div>
      </section>

      {modalState ? (
        <div className="registry-modal-backdrop" onClick={() => setModalState(null)} role="presentation">
          <div
            className={
              modalState.type === 'create-destination' || modalState.type === 'edit-destination'
                ? 'registry-modal registry-modal-wide'
                : 'registry-modal'
            }
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            {modalState.type === 'create-wallet' || modalState.type === 'edit-wallet' ? (
              <>
                <div className="panel-header panel-header-stack">
                  <div>
                    <p className="eyebrow">Wallet</p>
                    <h2>{editingAddress ? 'Edit wallet' : 'Add wallet'}</h2>
                    <p className="compact-copy">Save the raw onchain address first. Destinations can be created from it later.</p>
                  </div>
                  <button className="ghost-button compact-button danger-button" onClick={() => setModalState(null)} type="button">
                    close
                  </button>
                </div>
                <form key={`wallet-form-${editingAddress?.workspaceAddressId ?? 'new'}`} className="form-stack" onSubmit={(event) => void handleAddressSubmit(event)}>
                  <label className="field">
                    <span>Wallet address</span>
                    <input defaultValue={editingAddress?.address ?? ''} name="address" placeholder="Solana wallet address" required />
                  </label>
                  <label className="field">
                    <span>Wallet name</span>
                    <input defaultValue={editingAddress?.displayName ?? ''} name="displayName" placeholder="Treasury wallet, hot wallet, vendor wallet..." required />
                  </label>
                  <label className="field">
                    <span>Notes</span>
                    <input defaultValue={editingAddress?.notes ?? ''} name="notes" placeholder="Optional context" />
                  </label>
                  <label className="field">
                    <span>Status</span>
                    <select defaultValue={editingAddress?.isActive === false ? 'false' : 'true'} name="isActive">
                      <option value="true">active</option>
                      <option value="false">inactive</option>
                    </select>
                  </label>
                  <div className="exception-actions">
                    <button className="primary-button" disabled={!canManage} type="submit">
                      {editingAddress ? 'Update wallet' : 'Save wallet'}
                    </button>
                  </div>
                </form>
              </>
            ) : null}

            {modalState.type === 'create-counterparty' || modalState.type === 'edit-counterparty' ? (
              <>
                <div className="panel-header panel-header-stack">
                  <div>
                    <p className="eyebrow">Counterparty</p>
                    <h2>{editingCounterparty ? 'Edit counterparty' : 'Add counterparty'}</h2>
                    <p className="compact-copy">Counterparties are optional business owners for one or more destinations.</p>
                  </div>
                  <button className="ghost-button compact-button danger-button" onClick={() => setModalState(null)} type="button">
                    close
                  </button>
                </div>
                <form key={`counterparty-form-${editingCounterparty?.counterpartyId ?? 'new'}`} className="form-stack" onSubmit={(event) => void handleCounterpartySubmit(event)}>
                  <label className="field">
                    <span>Business entity name</span>
                    <input defaultValue={editingCounterparty?.displayName ?? ''} name="displayName" placeholder="Acme Vendor, Coinbase Prime, Treasury Ops..." required />
                  </label>
                  <label className="field">
                    <span>Category</span>
                    <input defaultValue={editingCounterparty?.category ?? ''} name="category" placeholder="vendor" />
                  </label>
                  <label className="field">
                    <span>Reference</span>
                    <input defaultValue={editingCounterparty?.externalReference ?? ''} name="externalReference" placeholder="Optional external id" />
                  </label>
                  <label className="field">
                    <span>Status</span>
                    <select defaultValue={editingCounterparty?.status ?? 'active'} name="status">
                      <option value="active">active</option>
                      <option value="inactive">inactive</option>
                    </select>
                  </label>
                  <div className="exception-actions">
                    <button className="primary-button" disabled={!canManage} type="submit">
                      {editingCounterparty ? 'Update counterparty' : 'Create counterparty'}
                    </button>
                  </div>
                </form>
              </>
            ) : null}

            {modalState.type === 'create-destination' || modalState.type === 'edit-destination' ? (
              <>
                <div className="panel-header panel-header-stack">
                  <div>
                    <p className="eyebrow">Destination</p>
                    <h2>{editingDestination ? 'Edit destination' : 'New destination'}</h2>
                    <p className="compact-copy">This is the operator-facing payment endpoint that will appear in expected transfers, approvals, and reconciliation.</p>
                  </div>
                  <button className="ghost-button compact-button danger-button" onClick={() => setModalState(null)} type="button">
                    close
                  </button>
                </div>
                <form
                  key={`destination-form-${editingDestination?.destinationId ?? 'new'}`}
                  className="form-stack modal-form-grid"
                  onSubmit={(event) => void handleDestinationSubmit(event)}
                >
                  <label className="field">
                    <span>Linked wallet</span>
                    <select defaultValue={editingDestination?.linkedWorkspaceAddressId ?? (modalState.type === 'create-destination' ? modalState.linkedWorkspaceAddressId ?? '' : '')} name="linkedWorkspaceAddressId" required>
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
                    <span>Counterparty</span>
                    <select name="counterpartyId" defaultValue={editingDestination?.counterpartyId ?? ''}>
                      <option value="">Optional</option>
                      {counterparties.map((item) => (
                        <option key={item.counterpartyId} value={item.counterpartyId}>
                          {item.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Destination label</span>
                    <input defaultValue={editingDestination?.label ?? ''} name="label" placeholder="Acme payout wallet" required />
                  </label>
                  <label className="field">
                    <span>Destination type</span>
                    <input defaultValue={editingDestination?.destinationType ?? ''} name="destinationType" placeholder="vendor_wallet" />
                  </label>
                  <label className="field">
                    <span>Trust state</span>
                    <select name="trustState" defaultValue={editingDestination?.trustState ?? 'unreviewed'}>
                      <option value="unreviewed">unreviewed</option>
                      <option value="trusted">trusted</option>
                      <option value="restricted">restricted</option>
                      <option value="blocked">blocked</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Scope</span>
                    <select name="isInternal" defaultValue={editingDestination?.isInternal ? 'true' : 'false'}>
                      <option value="false">external</option>
                      <option value="true">internal</option>
                    </select>
                  </label>
                  <label className="field modal-span-full">
                    <span>Notes</span>
                    <input defaultValue={editingDestination?.notes ?? ''} name="notes" placeholder="Optional context" />
                  </label>
                  <label className="field">
                    <span>Status</span>
                    <select defaultValue={editingDestination?.isActive === false ? 'false' : 'true'} name="isActive">
                      <option value="true">active</option>
                      <option value="false">inactive</option>
                    </select>
                  </label>
                  <div className="exception-actions modal-span-full">
                    <button className="primary-button" disabled={!canManage || addresses.length === 0} type="submit">
                      {editingDestination ? 'Update destination' : 'Create destination'}
                    </button>
                  </div>
                </form>
              </>
            ) : null}

            {modalState.type === 'view-destination' && selectedDestination ? (
              <>
                <div className="registry-modal-hero">
                  <div className="registry-modal-hero-copy">
                    <h2>{selectedDestination.label}</h2>
                    <span className={`tone-pill tone-pill-${mapDestinationTone(selectedDestination.trustState)}`}>
                      {selectedDestination.trustState}
                    </span>
                  </div>
                  <button className="ghost-button compact-button danger-button" onClick={() => setModalState(null)} type="button">
                    close
                  </button>
                </div>

                <div className="info-grid-tight">
                  <InfoLine label="Scope" value={selectedDestination.isInternal ? 'internal' : 'external'} />
                  <InfoLine label="Status" value={selectedDestination.isActive ? 'active' : 'inactive'} />
                  <InfoLine label="Destination type" value={selectedDestination.destinationType || 'destination'} />
                </div>

                <div className="registry-detail-group">
                  <div className="registry-detail-head">
                    <strong>Linked wallet</strong>
                    {selectedDestinationWallet && canManage ? (
                      <button className="ghost-button compact-button" onClick={() => setModalState({ type: 'edit-wallet', workspaceAddressId: selectedDestinationWallet.workspaceAddressId })} type="button">
                        Edit wallet
                      </button>
                    ) : null}
                  </div>
                  {selectedDestinationWallet ? (
                    <div className="registry-detail-box">
                      <strong>{getWalletNameLite(selectedDestinationWallet)}</strong>
                      <small>{selectedDestinationWallet.address}</small>
                      {selectedDestinationWallet.notes ? <p>{selectedDestinationWallet.notes}</p> : null}
                    </div>
                  ) : (
                    <div className="empty-box compact">No linked wallet found.</div>
                  )}
                </div>

                <div className="registry-detail-group">
                  <div className="registry-detail-head">
                    <strong>Counterparty</strong>
                    {selectedDestinationCounterparty && canManage ? (
                      <button className="ghost-button compact-button" onClick={() => setModalState({ type: 'edit-counterparty', counterpartyId: selectedDestinationCounterparty.counterpartyId })} type="button">
                        Edit counterparty
                      </button>
                    ) : null}
                  </div>
                  {selectedDestinationCounterparty ? (
                    <div className="registry-detail-box">
                      <strong>{selectedDestinationCounterparty.displayName}</strong>
                      <small>{selectedDestinationCounterparty.category || 'uncategorized'} // {selectedDestinationCounterparty.status}</small>
                    </div>
                  ) : (
                    <div className="empty-box compact">No counterparty linked. This is fine for purely operational or still-unclassified destinations.</div>
                  )}
                </div>

                {selectedDestination.notes ? (
                  <div className="registry-detail-group">
                    <div className="registry-detail-head">
                      <strong>Notes</strong>
                    </div>
                    <div className="registry-detail-box">
                      <p>{selectedDestination.notes}</p>
                    </div>
                  </div>
                ) : null}

                {canManage ? (
                  <div className="exception-actions">
                    <button className="primary-button" onClick={() => setModalState({ type: 'edit-destination', destinationId: selectedDestination.destinationId })} type="button">
                      Edit destination
                    </button>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function WorkspacePolicyPage({
  approvalPolicy,
  canManage,
  currentWorkspace,
  onUpdateApprovalPolicy,
}: {
  approvalPolicy: ApprovalPolicy | null;
  canManage: boolean;
  currentWorkspace: Workspace;
  onUpdateApprovalPolicy: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  const [modalState, setModalState] = useState<{ type: 'internal' | 'external' } | null>(null);

  return (
    <div className="page-stack page-stack-tight">
      <section className="section-headline section-headline-compact">
        <div className="section-headline-copy">
          <p className="eyebrow">Approval Policy</p>
          <h1>{currentWorkspace.workspaceName}</h1>
          <p className="section-copy">
            Control how internal and external requests become live.
          </p>
        </div>
      </section>

      {!canManage ? (
        <div className="notice-banner">
          <div>
            <strong>Read only.</strong>
            <p>Only organization admins can change approval policy for this workspace.</p>
          </div>
        </div>
      ) : null}

      <section className="content-grid content-grid-single">
        <div className="content-panel content-panel-strong">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Policy</p>
              <h2>Approval strategies</h2>
            </div>
          </div>
          {approvalPolicy ? (
            <div className="policy-stack">
              <div className="setup-hint-card policy-inline-note">
                <strong>Shared guardrails</strong>
                <p>
                  Policy is {approvalPolicy.isActive ? 'active' : 'inactive'}.
                  {' '}
                  {approvalPolicy.ruleJson.requireTrustedDestination
                    ? 'Only trusted destinations can skip approval.'
                    : 'Untrusted destinations can still be evaluated by the thresholds below.'}
                </p>
              </div>

              <div className="policy-strategy-grid">
                <div className="policy-strategy-card">
                  <div className="policy-strategy-head">
                    <div className="policy-strategy-copy">
                      <span className="eyebrow">External</span>
                      <strong>{approvalPolicy.ruleJson.requireApprovalForExternal ? 'Always require approval' : 'Threshold based'}</strong>
                      <p>Controls vendor, exchange, and other non-internal destinations.</p>
                    </div>
                    {canManage ? (
                      <button className="primary-button compact-button" onClick={() => setModalState({ type: 'external' })} type="button">
                        Edit external
                      </button>
                    ) : null}
                  </div>
                  <div className="policy-strategy-list">
                    <div className="policy-strategy-row">
                      <span>Threshold</span>
                      <strong>{formatRawUsdc(approvalPolicy.ruleJson.externalApprovalThresholdRaw)} USDC</strong>
                    </div>
                    <div className="policy-strategy-row">
                      <span>Behavior</span>
                      <strong>
                        {approvalPolicy.ruleJson.requireApprovalForExternal
                          ? 'Every trusted external request goes to approval'
                          : `Trusted external requests below ${formatRawUsdc(approvalPolicy.ruleJson.externalApprovalThresholdRaw)} USDC can go live`}
                      </strong>
                    </div>
                  </div>
                </div>

                <div className="policy-strategy-card">
                  <div className="policy-strategy-head">
                    <div className="policy-strategy-copy">
                      <span className="eyebrow">Internal</span>
                      <strong>{approvalPolicy.ruleJson.requireApprovalForInternal ? 'Always require approval' : 'Threshold based'}</strong>
                      <p>Controls treasury-owned or otherwise internal destinations.</p>
                    </div>
                    {canManage ? (
                      <button className="primary-button compact-button" onClick={() => setModalState({ type: 'internal' })} type="button">
                        Edit internal
                      </button>
                    ) : null}
                  </div>
                  <div className="policy-strategy-list">
                    <div className="policy-strategy-row">
                      <span>Threshold</span>
                      <strong>{formatRawUsdc(approvalPolicy.ruleJson.internalApprovalThresholdRaw)} USDC</strong>
                    </div>
                    <div className="policy-strategy-row">
                      <span>Behavior</span>
                      <strong>
                        {approvalPolicy.ruleJson.requireApprovalForInternal
                          ? 'Every trusted internal request goes to approval'
                          : `Trusted internal requests below ${formatRawUsdc(approvalPolicy.ruleJson.internalApprovalThresholdRaw)} USDC can go live`}
                      </strong>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="empty-box compact">Approval policy unavailable.</div>
          )}
        </div>
      </section>

      {modalState && approvalPolicy ? (
        <div className="registry-modal-backdrop" onClick={() => setModalState(null)} role="presentation">
          <div className="registry-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
            <div className="panel-header panel-header-stack">
              <div>
                <p className="eyebrow">Approval strategy</p>
                <h2>{modalState.type === 'external' ? 'Edit external strategy' : 'Edit internal strategy'}</h2>
                <p className="compact-copy">
                  {modalState.type === 'external'
                    ? 'Define when trusted external requests should pause in approval.'
                    : 'Define when trusted internal requests should pause in approval.'}
                </p>
              </div>
              <button className="ghost-button compact-button danger-button" onClick={() => setModalState(null)} type="button">
                close
              </button>
            </div>

            <form
              className="form-stack modal-form-grid"
              onSubmit={async (event) => {
                await onUpdateApprovalPolicy(event);
                setModalState(null);
              }}
            >
              <input name="policyName" type="hidden" value={approvalPolicy.policyName} />
              <input name="isActive" type="hidden" value={approvalPolicy.isActive ? 'true' : 'false'} />
              <input
                name="requireTrustedDestination"
                type="hidden"
                value={approvalPolicy.ruleJson.requireTrustedDestination ? 'true' : 'false'}
              />
              <input
                name={modalState.type === 'external' ? 'requireApprovalForInternal' : 'requireApprovalForExternal'}
                type="hidden"
                value={
                  modalState.type === 'external'
                    ? (approvalPolicy.ruleJson.requireApprovalForInternal ? 'true' : 'false')
                    : (approvalPolicy.ruleJson.requireApprovalForExternal ? 'true' : 'false')
                }
              />
              <input
                name={modalState.type === 'external' ? 'internalApprovalThresholdRaw' : 'externalApprovalThresholdRaw'}
                type="hidden"
                value={
                  modalState.type === 'external'
                    ? approvalPolicy.ruleJson.internalApprovalThresholdRaw
                    : approvalPolicy.ruleJson.externalApprovalThresholdRaw
                }
              />

              <label className="field">
                <span>Strategy</span>
                <select
                  defaultValue={
                    modalState.type === 'external'
                      ? (approvalPolicy.ruleJson.requireApprovalForExternal ? 'true' : 'false')
                      : (approvalPolicy.ruleJson.requireApprovalForInternal ? 'true' : 'false')
                  }
                  name={modalState.type === 'external' ? 'requireApprovalForExternal' : 'requireApprovalForInternal'}
                >
                  <option value="false">threshold based</option>
                  <option value="true">always require approval</option>
                </select>
              </label>

              <label className="field">
                <span>Approval threshold</span>
                <input
                  defaultValue={
                    modalState.type === 'external'
                      ? approvalPolicy.ruleJson.externalApprovalThresholdRaw
                      : approvalPolicy.ruleJson.internalApprovalThresholdRaw
                  }
                  name={modalState.type === 'external' ? 'externalApprovalThresholdRaw' : 'internalApprovalThresholdRaw'}
                  required
                />
                <small className="field-note">
                  {modalState.type === 'external'
                    ? `Trusted external requests at or above ${formatRawUsdc(approvalPolicy.ruleJson.externalApprovalThresholdRaw)} USDC currently require approval.`
                    : `Trusted internal requests at or above ${formatRawUsdc(approvalPolicy.ruleJson.internalApprovalThresholdRaw)} USDC currently require approval.`}
                </small>
              </label>

              <div className="exception-actions modal-span-full">
                <button className="primary-button" disabled={!canManage} type="submit">
                  Save strategy
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function WorkspaceRequestsPage({
  addresses,
  canManage,
  currentWorkspace,
  destinations,
  onCreateTransferRequest,
  reconciliationRows,
  transferRequests,
}: {
  addresses: WorkspaceAddress[];
  canManage: boolean;
  currentWorkspace: Workspace;
  destinations: Destination[];
  onCreateTransferRequest: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  reconciliationRows: ReconciliationRow[];
  transferRequests: TransferRequest[];
}) {
  const [modalState, setModalState] = useState<{ type: 'create' } | { type: 'view'; transferRequestId: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRequestDestinationId, setSelectedRequestDestinationId] = useState('');
  const [requestCreateStatus, setRequestCreateStatus] = useState<'draft' | 'submitted'>('submitted');
  const selectedRequestDestination =
    destinations.find((item) => item.destinationId === selectedRequestDestinationId) ?? null;
  const reconciliationByRequestId = new Map(reconciliationRows.map((row) => [row.transferRequestId, row] as const));
  const requestRows = [...transferRequests]
    .sort((left, right) => new Date(right.requestedAt).getTime() - new Date(left.requestedAt).getTime())
    .filter((item) => {
      if (!searchQuery.trim()) {
        return true;
      }
      const query = searchQuery.trim().toLowerCase();
      const row = reconciliationByRequestId.get(item.transferRequestId);
      return [
        getTransferLabel(item),
        getDestinationLabel(item.destination, item.destinationWorkspaceAddress),
        item.destination?.counterparty?.displayName ?? '',
        item.requestType,
        item.reason ?? '',
        item.externalReference ?? '',
        row?.approvalState ?? '',
        row?.executionState ?? '',
        row?.requestDisplayState ?? '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
  const selectedRequest =
    modalState?.type === 'view'
      ? transferRequests.find((item) => item.transferRequestId === modalState.transferRequestId) ?? null
      : null;
  const selectedRequestRow = selectedRequest
    ? reconciliationByRequestId.get(selectedRequest.transferRequestId) ?? null
    : null;

  useEffect(() => {
    if (!selectedRequestDestination) {
      setRequestCreateStatus('submitted');
      return;
    }

    if (
      !selectedRequestDestination.isActive
      || selectedRequestDestination.trustState === 'blocked'
      || selectedRequestDestination.trustState === 'restricted'
      || selectedRequestDestination.trustState === 'unreviewed'
    ) {
      setRequestCreateStatus('draft');
      return;
    }

    setRequestCreateStatus('submitted');
  }, [selectedRequestDestination]);

  return (
    <div className="page-stack page-stack-tight">
      <section className="section-headline section-headline-compact">
        <div className="section-headline-copy">
          <p className="eyebrow">Expected Transfers</p>
          <h1>{currentWorkspace.workspaceName}</h1>
          <p className="section-copy">
            Create live requests against trusted destinations so approvals, execution, and reconciliation all start from the same object.
          </p>
        </div>
      </section>

      {!canManage ? (
        <div className="notice-banner">
          <div>
            <strong>Read only.</strong>
            <p>Only organization admins can create or change planned transfers in this workspace.</p>
          </div>
        </div>
      ) : null}

      <section className="request-shell">
        <div className="content-panel content-panel-strong request-main-panel">
          <TableSurfaceHeader
            actionDisabled={!canManage || destinations.length === 0}
            actionLabel="New expected transfer"
            count={transferRequests.length}
            onAction={() => setModalState({ type: 'create' })}
            onSearchChange={setSearchQuery}
            searchPlaceholder="Search request, destination, type, or state"
            searchValue={searchQuery}
            title="Expected transfers"
          />

          <div className="request-table compact-request-table">
            <div className="request-table-head">
              <span>Request ID</span>
              <span>Source</span>
              <span>Destination</span>
              <span>Amount</span>
              <span>Approval</span>
              <span>Execution</span>
              <span>Settlement</span>
              <span>Requested</span>
            </div>
            {requestRows.length ? (
              requestRows.map((item) => {
                const row = reconciliationByRequestId.get(item.transferRequestId) ?? null;
                const approvalState = row?.approvalState ?? inferApprovalStateFromRequestStatus(item.status);
                const executionState = row?.executionState ?? inferExecutionStateFromRequestStatus(item.status);
                const settlementState = row?.requestDisplayState ?? 'pending';

                return (
                  <div key={item.transferRequestId} className="request-table-row">
                    <button
                      className="request-row-button"
                      onClick={() => setModalState({ type: 'view', transferRequestId: item.transferRequestId })}
                      title={`${item.transferRequestId} // ${getTransferLabel(item)}`}
                      type="button"
                    >
                      <span className="request-cell-primary">
                        <strong>{shortenAddress(item.transferRequestId, 8, 6)}</strong>
                      </span>
                      <span className="request-cell-single">
                        <strong>{item.sourceWorkspaceAddress ? getWalletNameLite(item.sourceWorkspaceAddress) : 'Not set'}</strong>
                      </span>
                      <span className="request-cell-single">
                        <strong>{getDestinationLabel(item.destination, item.destinationWorkspaceAddress)}</strong>
                      </span>
                      <span className="request-cell-amount request-cell-single">
                        <strong>{formatRawUsdc(item.amountRaw)}</strong>
                      </span>
                      <span className="request-cell-single"><span className={`tone-pill tone-pill-${mapApprovalTone(approvalState)}`}>{getApprovalStateLabel(approvalState)}</span></span>
                      <span className="request-cell-single"><span className={`tone-pill tone-pill-${mapExecutionTone(executionState)}`}>{getExecutionStateLabel(executionState, row ?? undefined)}</span></span>
                      <span className="request-cell-single"><span className={`tone-pill tone-pill-${row ? getSettlementTone(row) : settlementState}`}>{row ? getDisplayStateLabel(row) : getDisplayStateLabelFromState(settlementState)}</span></span>
                      <span className="request-cell-single">{formatTimestampCompact(item.requestedAt)}</span>
                    </button>
                  </div>
                );
              })
            ) : transferRequests.length ? (
              <div className="empty-box compact">No expected transfers match the current search.</div>
            ) : (
              <div className="empty-box compact">
                <strong>No expected transfers yet.</strong>
                <p>Create the first live or draft request here after you set up destinations in the address book.</p>
              </div>
            )}
          </div>
        </div>
      </section>

      {modalState ? (
        <div className="registry-modal-backdrop" onClick={() => setModalState(null)} role="presentation">
          <div className="registry-modal request-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
            {modalState.type === 'create' ? (
              <>
                <div className="panel-header panel-header-stack">
                  <div>
                    <p className="eyebrow">Expected transfer</p>
                    <h2>New expected transfer</h2>
                    <p className="compact-copy">Pick a destination first. Its trust and scope determine whether the request stays draft, enters approval, or can go live immediately.</p>
                  </div>
                  <button className="ghost-button compact-button danger-button" onClick={() => setModalState(null)} type="button">
                    close
                  </button>
                </div>
                <form
                  className="form-stack modal-form-grid"
                  onSubmit={async (event) => {
                    await onCreateTransferRequest(event);
                    setModalState(null);
                  }}
                >
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
                    <span>Destination</span>
                    <select
                      name="destinationId"
                      onChange={(event) => setSelectedRequestDestinationId(event.target.value)}
                      value={selectedRequestDestinationId}
                      required
                    >
                      <option value="" disabled>
                        Select destination
                      </option>
                      {destinations.filter((item) => item.isActive).map((destination) => (
                        <option key={destination.destinationId} value={destination.destinationId}>
                          {destination.label} // {destination.trustState}
                        </option>
                      ))}
                    </select>
                  </label>
                  {selectedRequestDestination ? (
                    <div className="setup-hint-card modal-span-full">
                      <strong>
                        {selectedRequestDestination.label} // {selectedRequestDestination.trustState} // {selectedRequestDestination.isInternal ? 'internal' : 'external'}
                      </strong>
                      <p>{getDestinationTrustCopy(selectedRequestDestination)}</p>
                    </div>
                  ) : (
                    <div className="setup-hint-card modal-span-full">
                      <strong>Before you create requests</strong>
                      <p>Use the Address book page to save the wallet and create the destination first.</p>
                    </div>
                  )}
                  <label className="field">
                    <span>Transfer type</span>
                    <input name="requestType" placeholder="wallet_transfer" required />
                  </label>
                  <label className="field">
                    <span>Initial request state</span>
                    <select
                      name="status"
                      onChange={(event) => setRequestCreateStatus(event.target.value as 'draft' | 'submitted')}
                      value={requestCreateStatus}
                    >
                      <option value="draft">save as draft</option>
                      {selectedRequestDestination?.isActive !== false && selectedRequestDestination?.trustState === 'trusted' ? (
                        <option value="submitted">make live request</option>
                      ) : null}
                    </select>
                  </label>
                  <label className="field modal-span-full">
                    <span>Amount (raw units)</span>
                    <input name="amountRaw" placeholder="10000 for 0.01 USDC" required />
                    <small className="field-note">USDC uses 6 decimals. Example: 10000 = 0.01 USDC.</small>
                  </label>
                  <label className="field">
                    <span>Reference</span>
                    <input name="externalReference" placeholder="Optional" />
                  </label>
                  <label className="field">
                    <span>Reason</span>
                    <input name="reason" placeholder="Optional" />
                  </label>
                  <div className="exception-actions modal-span-full">
                    <button
                      className="primary-button"
                      disabled={
                        !canManage
                        || destinations.length === 0
                        || !selectedRequestDestination
                        || !selectedRequestDestination.isActive
                        || selectedRequestDestination.trustState === 'blocked'
                      }
                      type="submit"
                    >
                      Create expected transfer
                    </button>
                  </div>
                </form>
              </>
            ) : null}

            {modalState.type === 'view' && selectedRequest ? (
              <>
                <div className="registry-modal-hero request-modal-hero">
                  <div className="registry-modal-hero-copy">
                    <h2>{getTransferLabel(selectedRequest)}</h2>
                    <span className={`tone-pill tone-pill-${selectedRequestRow ? getSettlementTone(selectedRequestRow) : 'pending'}`}>
                      {getDisplayStateLabel(selectedRequestRow ?? { requestDisplayState: 'pending', match: null, exceptions: [] } as Pick<ReconciliationRow, 'requestDisplayState' | 'match' | 'exceptions'>)}
                    </span>
                  </div>
                  <button className="ghost-button compact-button danger-button" onClick={() => setModalState(null)} type="button">
                    close
                  </button>
                </div>

                <div className="info-grid-tight">
                  <InfoLine label="Destination" value={getDestinationLabel(selectedRequest.destination, selectedRequest.destinationWorkspaceAddress)} />
                  <InfoLine label="Amount" value={`${formatRawUsdc(selectedRequest.amountRaw)} USDC`} />
                  <InfoLine label="Requested" value={formatTimestamp(selectedRequest.requestedAt)} />
                  <InfoLine label="Type" value={formatLabel(selectedRequest.requestType)} />
                </div>

                <div className="state-summary-grid request-state-grid">
                  <div className="state-summary-card">
                    <span>Approval</span>
                  <strong>{getApprovalStateLabel(selectedRequestRow?.approvalState ?? inferApprovalStateFromRequestStatus(selectedRequest.status))}</strong>
                  </div>
                  <div className="state-summary-card">
                    <span>Execution</span>
                    <strong>{getExecutionStateLabel(
                      selectedRequestRow?.executionState ?? inferExecutionStateFromRequestStatus(selectedRequest.status),
                      selectedRequestRow ?? undefined,
                    )}</strong>
                  </div>
                  <div className="state-summary-card">
                    <span>Settlement</span>
                    <strong>{selectedRequestRow ? getDisplayStateLabel(selectedRequestRow) : getDisplayStateLabelFromState('pending')}</strong>
                  </div>
                </div>

                {selectedRequest.destination ? (
                  <div className="registry-detail-group">
                    <div className="registry-detail-head">
                      <strong>Destination context</strong>
                    </div>
                    <div className="registry-detail-box">
                      <strong>{selectedRequest.destination.label}</strong>
                      <small>
                        {selectedRequest.destination.trustState} // {selectedRequest.destination.isInternal ? 'internal' : 'external'}
                        {selectedRequest.destination.counterparty ? ` // ${selectedRequest.destination.counterparty.displayName}` : ''}
                      </small>
                    </div>
                  </div>
                ) : null}

                {selectedRequestRow?.latestExecution ? (
                  <div className="registry-detail-group">
                    <div className="registry-detail-head">
                      <strong>Latest execution</strong>
                    </div>
                    <div className="registry-detail-box">
                      <strong>{getExecutionStateLabel(selectedRequestRow.latestExecution.state)}</strong>
                      <small>
                        {selectedRequestRow.latestExecution.submittedSignature
                          ? shortenAddress(selectedRequestRow.latestExecution.submittedSignature, 8, 8)
                          : 'No submitted signature yet'}
                      </small>
                    </div>
                  </div>
                ) : null}

                {selectedRequestRow?.matchExplanation ? (
                  <div className="registry-detail-group">
                    <div className="registry-detail-head">
                      <strong>Settlement result</strong>
                    </div>
                    <div className="registry-detail-box">
                      <p>{selectedRequestRow.matchExplanation}</p>
                    </div>
                  </div>
                ) : null}

                {selectedRequest.reason || selectedRequest.externalReference ? (
                  <div className="info-grid-tight">
                    {selectedRequest.externalReference ? (
                      <InfoLine label="Reference" value={selectedRequest.externalReference} />
                    ) : null}
                    {selectedRequest.reason ? (
                      <InfoLine label="Reason" value={selectedRequest.reason} />
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function WorkspaceExceptionsPage({
  currentWorkspace,
  exceptions,
  members,
  reconciliationRows,
  onApplyExceptionAction,
  onAddExceptionNote,
  onUpdateExceptionMetadata,
  onDownloadExceptionsExport,
}: {
  currentWorkspace: Workspace;
  exceptions: ExceptionItem[];
  members: WorkspaceMember[];
  reconciliationRows: ReconciliationRow[];
  onApplyExceptionAction: (
    exceptionId: string,
    action: 'reviewed' | 'expected' | 'dismissed' | 'reopen',
    transferRequestId?: string | null,
    note?: string,
  ) => Promise<void>;
  onAddExceptionNote: (exceptionId: string, body: string, transferRequestId?: string | null) => Promise<void>;
  onUpdateExceptionMetadata: (
    exceptionId: string,
    input: {
      assignedToUserId?: string | null;
      resolutionCode?: string | null;
      severity?: 'info' | 'warning' | 'critical' | null;
      note?: string;
    },
    transferRequestId?: string | null,
  ) => Promise<void>;
  onDownloadExceptionsExport: () => Promise<void>;
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'reviewed' | 'expected' | 'dismissed' | 'reopened'>('all');
  const [severityFilter, setSeverityFilter] = useState<'all' | 'info' | 'warning' | 'critical'>('all');
  const [assigneeFilter, setAssigneeFilter] = useState<'all' | 'unassigned' | string>('all');
  const [selectedExceptionId, setSelectedExceptionId] = useState<string | null>(null);

  const reconciliationById = new Map(reconciliationRows.map((row) => [row.transferRequestId, row] as const));
  const selectedException = exceptions.find((item) => item.exceptionId === selectedExceptionId) ?? null;
  const selectedLinkedRequest = selectedException?.transferRequestId
    ? reconciliationById.get(selectedException.transferRequestId) ?? null
    : null;

  const filteredExceptions = exceptions.filter((item) => {
    const linkedRequest = item.transferRequestId
      ? reconciliationById.get(item.transferRequestId) ?? null
      : null;
    if (statusFilter !== 'all' && item.status !== statusFilter) return false;
    if (severityFilter !== 'all' && item.severity !== severityFilter) return false;
    if (assigneeFilter === 'unassigned' && item.assignedToUserId) return false;
    if (assigneeFilter !== 'all' && assigneeFilter !== 'unassigned' && item.assignedToUserId !== assigneeFilter) return false;
    if (!searchQuery.trim()) return true;
    const query = searchQuery.trim().toLowerCase();
    return [
      getExceptionReasonLabel(item.reasonCode),
      item.explanation,
      item.status,
      item.severity,
      item.assignedToUser?.displayName ?? '',
      item.assignedToUser?.email ?? '',
      linkedRequest?.destination?.label ?? '',
    ].join(' ').toLowerCase().includes(query);
  });

  return (
    <div className="page-stack page-stack-tight">
      <section className="section-headline section-headline-compact">
        <div className="section-headline-copy">
          <p className="eyebrow">Exceptions</p>
          <h1>{currentWorkspace.workspaceName}</h1>
          <p className="section-copy">Work the exception queue, assign ownership, capture resolution, and keep the reconciliation loop moving.</p>
        </div>
      </section>

      <section className="request-shell">
        <div className="content-panel content-panel-strong request-main-panel">
          <TableSurfaceHeader
            actionLabel="Export exceptions"
            count={exceptions.length}
            onAction={() => void onDownloadExceptionsExport()}
            onSearchChange={setSearchQuery}
            searchPlaceholder="Search reason, assignee, explanation, or status"
            searchValue={searchQuery}
            title="Exception queue"
          />

          <div className="filter-row filter-row-compact">
            <label className="queue-select">
              <span>Status</span>
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
                <option value="all">all statuses</option>
                <option value="open">open</option>
                <option value="reviewed">reviewed</option>
                <option value="expected">expected</option>
                <option value="dismissed">dismissed</option>
                <option value="reopened">reopened</option>
              </select>
            </label>
            <label className="queue-select">
              <span>Severity</span>
              <select value={severityFilter} onChange={(event) => setSeverityFilter(event.target.value as typeof severityFilter)}>
                <option value="all">all severities</option>
                <option value="info">info</option>
                <option value="warning">warning</option>
                <option value="critical">critical</option>
              </select>
            </label>
            <label className="queue-select">
              <span>Assignee</span>
              <select value={assigneeFilter} onChange={(event) => setAssigneeFilter(event.target.value)}>
                <option value="all">all owners</option>
                <option value="unassigned">unassigned</option>
                {members.map((member) => (
                  <option key={member.user.userId} value={member.user.userId}>
                    {member.user.displayName || member.user.email}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="request-table compact-request-table exception-queue-table">
            <div className="request-table-head">
              <span>Reason</span>
              <span>Severity</span>
              <span>Status</span>
              <span>Assignee</span>
              <span>Request</span>
              <span>Updated</span>
            </div>
            {filteredExceptions.length ? (
              filteredExceptions.map((item) => {
                const linkedRequest = item.transferRequestId
                  ? reconciliationById.get(item.transferRequestId) ?? null
                  : null;
                return (
                  <div key={item.exceptionId} className="request-table-row">
                    <button
                      className="request-row-button"
                      onClick={() => setSelectedExceptionId(item.exceptionId)}
                      type="button"
                    >
                      <span className="request-cell-single"><strong>{getExceptionReasonLabel(item.reasonCode)}</strong></span>
                      <span className="request-cell-single"><span className={`tone-pill tone-pill-${mapExceptionSeverityTone(item.severity)}`}>{item.severity}</span></span>
                      <span className="request-cell-single"><span className={`tone-pill tone-pill-${mapExceptionStatusTone(item.status)}`}>{formatLabel(item.status)}</span></span>
                      <span className="request-cell-single">{item.assignedToUser?.displayName || item.assignedToUser?.email || 'unassigned'}</span>
                      <span className="request-cell-single">{linkedRequest ? shortenAddress(linkedRequest.transferRequestId, 8, 6) : 'unlinked'}</span>
                      <span className="request-cell-single">{formatTimestampCompact(item.updatedAt)}</span>
                    </button>
                  </div>
                );
              })
            ) : (
              <div className="empty-box compact">No exceptions match the current filters.</div>
            )}
          </div>
        </div>
      </section>

      {selectedException ? (
        <div className="registry-modal-backdrop" onClick={() => setSelectedExceptionId(null)} role="presentation">
          <div className="registry-modal request-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
            <div className="registry-modal-hero request-modal-hero">
              <div className="registry-modal-hero-copy">
                <h2>{getExceptionReasonLabel(selectedException.reasonCode)}</h2>
                <span className={`tone-pill tone-pill-${mapExceptionSeverityTone(selectedException.severity)}`}>{selectedException.severity}</span>
              </div>
              <button className="ghost-button compact-button danger-button" onClick={() => setSelectedExceptionId(null)} type="button">
                close
              </button>
            </div>

            <div className="info-grid-tight">
              <InfoLine label="Status" value={formatLabel(selectedException.status)} />
              <InfoLine label="Resolution" value={selectedException.resolutionCode ?? 'none'} />
              <InfoLine label="Assignee" value={selectedException.assignedToUser?.displayName || selectedException.assignedToUser?.email || 'unassigned'} />
              <InfoLine label="Updated" value={formatTimestamp(selectedException.updatedAt)} />
            </div>

            <div className="registry-detail-group">
              <div className="registry-detail-head">
                <strong>Exception detail</strong>
              </div>
              <div className="registry-detail-box">
                <p>{selectedException.explanation}</p>
              </div>
            </div>

            {selectedLinkedRequest ? (
              <div className="registry-detail-group">
                <div className="registry-detail-head">
                  <strong>Linked request</strong>
                </div>
                <div className="registry-detail-box">
                  <strong>{getDestinationLabel(selectedLinkedRequest.destination, selectedLinkedRequest.destinationWorkspaceAddress)}</strong>
                      <small>
                    {formatRawUsdc(selectedLinkedRequest.amountRaw)} USDC // {getApprovalStateLabel(selectedLinkedRequest.approvalState)} // {getDisplayStateLabel(selectedLinkedRequest)}
                      </small>
                </div>
              </div>
            ) : null}

            <form
              className="form-stack modal-form-grid"
              onSubmit={(event) =>
                void handleMetadataSubmit(event, async (input) => {
                  await onUpdateExceptionMetadata(
                    selectedException.exceptionId,
                    input,
                    selectedException.transferRequestId,
                  );
                  setSelectedExceptionId(null);
                })
              }
            >
              <label className="field">
                <span>Assignee</span>
                <select name="assignedToUserId" defaultValue={selectedException.assignedToUserId ?? ''}>
                  <option value="">unassigned</option>
                  {members.map((member) => (
                    <option key={member.user.userId} value={member.user.userId}>
                      {member.user.displayName || member.user.email}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Severity</span>
                <select name="severity" defaultValue={selectedException.severity}>
                  <option value="info">info</option>
                  <option value="warning">warning</option>
                  <option value="critical">critical</option>
                </select>
              </label>
              <label className="field">
                <span>Resolution code</span>
                <input defaultValue={selectedException.resolutionCode ?? ''} name="resolutionCode" placeholder="vendor_confirmed, false_positive..." />
              </label>
              <label className="field modal-span-full">
                <span>Operator note</span>
                <textarea name="note" placeholder="Capture what changed and why." rows={3} />
              </label>
              <div className="exception-actions modal-span-full">
                <button className="primary-button" type="submit">Save exception metadata</button>
              </div>
            </form>

            {selectedException.availableActions?.length ? (
              <div className="detail-section">
                <div className="detail-section-head">
                  <strong>Resolve or reopen</strong>
                </div>
                <div className="exception-actions">
                  {selectedException.availableActions.map((action) => (
                    <button
                      key={action}
                      className="ghost-button compact-button"
                      onClick={() => void onApplyExceptionAction(selectedException.exceptionId, action, selectedException.transferRequestId)}
                      type="button"
                    >
                      {getExceptionActionLabel(action)}
                    </button>
                  ))}
                </div>
                <p className="compact-copy">
                  Use <strong>Dismiss</strong> when the exception is resolved or no longer needs attention.
                  Use <strong>Expected</strong> when the condition is unusual but acceptable. Use <strong>Reviewed</strong> to mark triage without closing it.
                </p>
              </div>
            ) : null}

            <div className="detail-section">
              <div className="detail-section-head">
                <strong>Notes</strong>
                <span>{selectedException.notes?.length ?? 0}</span>
              </div>
              <div className="stack-list">
                {selectedException.notes?.length ? (
                  selectedException.notes.map((note) => (
                    <div key={note.exceptionNoteId} className="note-card">
                      <strong>{note.authorUser?.displayName || note.authorUser?.email || 'Operator'}</strong>
                      <small>{formatTimestamp(note.createdAt)}</small>
                      <p>{note.body}</p>
                    </div>
                  ))
                ) : (
                  <div className="empty-box compact">No notes yet.</div>
                )}
                <form
                  className="inline-note-form"
                  onSubmit={(event) =>
                    void handleNoteSubmit(event, (body) =>
                      onAddExceptionNote(selectedException.exceptionId, body, selectedException.transferRequestId),
                    )
                  }
                >
                  <label className="field">
                    <span>Add note</span>
                    <textarea name="body" placeholder="Explain the exception handling decision." rows={3} />
                  </label>
                  <button className="ghost-button compact-button" type="submit">save note</button>
                </form>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function WorkspaceOpsPage({
  currentWorkspace,
  opsHealth,
  exportJobs,
  onDownloadReconciliationExport,
  onDownloadExceptionsExport,
}: {
  currentWorkspace: Workspace;
  opsHealth: OpsHealth | null;
  exportJobs: ExportJob[];
  onDownloadReconciliationExport: () => Promise<void>;
  onDownloadExceptionsExport: () => Promise<void>;
}) {
  return (
    <div className="page-stack page-stack-tight">
      <section className="section-headline section-headline-compact">
        <div className="section-headline-copy">
          <p className="eyebrow">Ops</p>
          <h1>{currentWorkspace.workspaceName}</h1>
          <p className="section-copy">Check pipeline health, watch latency, and export records for operators and finance.</p>
        </div>
      </section>

      <section className="content-grid content-grid-two">
        <div className="content-panel content-panel-strong">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Health</p>
              <h2>Ingest and match status</h2>
            </div>
            <span className={`status-chip status-chip-${opsHealth?.workerStatus ?? 'offline'}`}>
              {opsHealth?.workerStatus ?? 'loading'}
            </span>
          </div>
          {opsHealth ? (
            <div className="health-grid">
              <div className="state-summary-card">
                <span>Latest slot</span>
                <strong>{opsHealth.latestSlot ?? 'n/a'}</strong>
              </div>
              <div className="state-summary-card">
                <span>Open exceptions</span>
                <strong>{opsHealth.openExceptionCount}</strong>
              </div>
              <div className="state-summary-card">
                <span>Observed txs</span>
                <strong>{opsHealth.observedTransactionCount}</strong>
              </div>
              <div className="state-summary-card">
                <span>Matches</span>
                <strong>{opsHealth.matchCount}</strong>
              </div>
              <div className="empty-box compact">
                <strong>Yellowstone to worker</strong>
                <div className="detail-grid">
                  <span>P50</span>
                  <span>{formatLatency(opsHealth.latencies.yellowstoneToWorkerMs.p50)}</span>
                  <span>P95</span>
                  <span>{formatLatency(opsHealth.latencies.yellowstoneToWorkerMs.p95)}</span>
                </div>
              </div>
              <div className="empty-box compact">
                <strong>Chain to write</strong>
                <div className="detail-grid">
                  <span>P50</span>
                  <span>{formatLatency(opsHealth.latencies.chainToWriteMs.p50)}</span>
                  <span>P95</span>
                  <span>{formatLatency(opsHealth.latencies.chainToWriteMs.p95)}</span>
                </div>
              </div>
              <div className="empty-box compact">
                <strong>Chain to match</strong>
                <div className="detail-grid">
                  <span>P50</span>
                  <span>{formatLatency(opsHealth.latencies.chainToMatchMs.p50)}</span>
                  <span>P95</span>
                  <span>{formatLatency(opsHealth.latencies.chainToMatchMs.p95)}</span>
                </div>
              </div>
              <div className="empty-box compact">
                <strong>Freshness</strong>
                <p>{opsHealth.workerFreshnessMs === null ? 'No recent worker signal.' : `${Math.round(opsHealth.workerFreshnessMs / 1000)}s since latest worker receive.`}</p>
              </div>
            </div>
          ) : (
            <div className="empty-box compact">Loading ops health…</div>
          )}
        </div>

        <div className="content-panel content-panel-soft">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Export</p>
              <h2>Record export center</h2>
            </div>
          </div>

          <div className="exception-actions">
            <button className="primary-button" onClick={() => void onDownloadReconciliationExport()} type="button">
              Export reconciliation
            </button>
            <button className="primary-button" onClick={() => void onDownloadExceptionsExport()} type="button">
              Export exceptions
            </button>
          </div>

          <div className="counterparty-table export-history-table">
            <div className="counterparty-table-head">
              <span>Kind</span>
              <span>Format</span>
              <span>Rows</span>
              <span>Requested</span>
            </div>
            {exportJobs.length ? (
              exportJobs.map((job) => (
                <div key={job.exportJobId} className="counterparty-table-row">
                  <span>{formatLabel(job.exportKind)}</span>
                  <span>{job.format}</span>
                  <span>{job.rowCount}</span>
                  <span>{formatTimestampCompact(job.createdAt)}</span>
                </div>
              ))
            ) : (
              <div className="empty-box compact">No exports recorded yet.</div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function getWalletName(address: WorkspaceAddress) {
  return address.displayName?.trim() || address.address;
}

function getWalletNameLite(address: WorkspaceAddressLite | null) {
  return address?.displayName?.trim() || address?.address || 'Not set';
}

function mapDestinationTone(trustState: Destination['trustState']) {
  switch (trustState) {
    case 'trusted':
      return 'matched';
    case 'restricted':
      return 'partial';
    case 'blocked':
      return 'exception';
    case 'unreviewed':
    default:
      return 'pending';
  }
}

function mapExceptionSeverityTone(severity: string) {
  switch (severity) {
    case 'critical':
      return 'exception';
    case 'warning':
      return 'partial';
    case 'info':
    default:
      return 'pending';
  }
}

function mapExceptionStatusTone(status: string) {
  switch (status) {
    case 'dismissed':
      return 'matched';
    case 'reviewed':
    case 'expected':
      return 'partial';
    case 'reopened':
    case 'open':
    default:
      return 'exception';
  }
}

function getExceptionReasonLabel(reasonCode: string) {
  return reasonCode.replaceAll('_', ' ');
}

function formatLabel(value: string) {
  return value.replaceAll('_', ' ');
}

function getApprovalActionLabel(action: string) {
  switch (action) {
    case 'routed_for_approval':
      return 'routed for approval';
    case 'auto_approved':
      return 'auto approved';
    default:
      return formatLabel(action);
  }
}

function getApprovalDecisionSummary(action: string) {
  switch (action) {
    case 'routed_for_approval':
      return 'System decision recorded before the request became active.';
    case 'auto_approved':
      return 'Policy allowed the request to become active without manual review.';
    case 'approve':
      return 'Operator approved the request and cleared it for execution.';
    case 'reject':
      return 'Operator rejected the request.';
    case 'escalate':
      return 'Operator escalated the request for higher-touch review.';
    default:
      return formatLabel(action);
  }
}

function getApprovalStateLabel(state: string) {
  switch (state) {
    case 'pending_approval':
      return 'waiting for approval';
    case 'escalated':
      return 'escalated';
    case 'approved':
      return 'approved';
    case 'rejected':
      return 'rejected';
    case 'closed':
      return 'closed';
    case 'draft':
      return 'draft';
    case 'submitted':
    default:
      return 'submitted';
  }
}

function inferApprovalStateFromRequestStatus(
  status: string,
): ReconciliationRow['approvalState'] {
  switch (status) {
    case 'draft':
      return 'draft';
    case 'pending_approval':
      return 'pending_approval';
    case 'escalated':
      return 'escalated';
    case 'rejected':
      return 'rejected';
    case 'closed':
      return 'closed';
    case 'approved':
    case 'ready_for_execution':
    case 'submitted_onchain':
    case 'observed':
    case 'matched':
    case 'partially_matched':
    case 'exception':
      return 'approved';
    case 'submitted':
    default:
      return 'submitted';
  }
}

function mapApprovalTone(state: ReconciliationRow['approvalState']) {
  switch (state) {
    case 'approved':
    case 'closed':
      return 'matched';
    case 'rejected':
      return 'exception';
    case 'pending_approval':
    case 'escalated':
      return 'partial';
    case 'draft':
    case 'submitted':
    default:
      return 'pending';
  }
}

function getExecutionStateForRow(row: ReconciliationRow) {
  if (row.requestDisplayState === 'exception' && row.exceptions.some((item) => item.reasonCode === 'partial_settlement')) {
    return 'settled';
  }

  return row.executionState;
}

function getExecutionStateLabel(state: string, row?: Pick<ReconciliationRow, 'requestDisplayState' | 'exceptions'>) {
  switch (state) {
    case 'not_started':
      return 'not started';
    case 'ready_for_execution':
      return 'ready to send';
    case 'submitted_onchain':
      return 'submitted onchain';
    case 'broadcast_failed':
      return 'broadcast failed';
    case 'observed':
      return 'observed onchain';
    case 'settled':
      if (row?.requestDisplayState === 'exception' && row.exceptions.some((item) => item.reasonCode === 'partial_settlement')) {
        return 'partially settled';
      }
      return 'settled';
    case 'execution_exception':
      return 'needs execution review';
    case 'closed':
      return 'closed';
    case 'rejected':
      return 'rejected';
    default:
      return formatLabel(state);
  }
}

function inferExecutionStateFromRequestStatus(
  status: string,
): ReconciliationRow['executionState'] {
  switch (status) {
    case 'rejected':
      return 'rejected';
    case 'closed':
      return 'closed';
    case 'submitted_onchain':
      return 'submitted_onchain';
    case 'observed':
      return 'observed';
    case 'matched':
    case 'partially_matched':
      return 'settled';
    case 'exception':
      return 'execution_exception';
    case 'approved':
    case 'ready_for_execution':
      return 'ready_for_execution';
    case 'draft':
    case 'submitted':
    case 'pending_approval':
    case 'escalated':
    default:
      return 'not_started';
  }
}

function mapExecutionTone(state: ReconciliationRow['executionState']) {
  switch (state) {
    case 'settled':
    case 'closed':
      return 'matched';
    case 'broadcast_failed':
    case 'execution_exception':
    case 'rejected':
      return 'exception';
    case 'submitted_onchain':
    case 'observed':
      return 'partial';
    case 'ready_for_execution':
      return 'pending';
    case 'not_started':
    default:
      return 'pending';
  }
}

function getSettlementTone(row: Pick<ReconciliationRow, 'requestDisplayState' | 'match' | 'exceptions'>) {
  if (row.exceptions.some((item) => item.reasonCode === 'partial_settlement' && item.status !== 'dismissed')) {
    return 'partial';
  }
  return row.requestDisplayState;
}

function getApprovalReasonLabel(code: string) {
  switch (code) {
    case 'destination_not_trusted':
      return 'destination not trusted';
    case 'external_transfer_requires_approval':
      return 'external transfer policy';
    case 'internal_transfer_requires_approval':
      return 'internal transfer policy';
    case 'external_amount_threshold_exceeded':
      return 'external threshold exceeded';
    case 'internal_amount_threshold_exceeded':
      return 'internal threshold exceeded';
    default:
      return formatLabel(code);
  }
}

function getDestinationTrustLabel(trustState: string) {
  switch (trustState) {
    case 'trusted':
      return 'trusted';
    case 'restricted':
      return 'restricted';
    case 'blocked':
      return 'blocked';
    case 'unreviewed':
    default:
      return 'unreviewed';
  }
}

function ExceptionCard({
  exception,
  onAddNote,
  onApplyAction,
}: {
  exception: ExceptionItem;
  onAddNote: (exceptionId: string, body: string, transferRequestId?: string | null) => Promise<void>;
  onApplyAction: (
    exceptionId: string,
    action: 'reviewed' | 'expected' | 'dismissed' | 'reopen',
    transferRequestId?: string | null,
    note?: string,
  ) => Promise<void>;
}) {
  return (
    <div className="exception-card">
      <div className="exception-card-head">
        <div>
          <strong>{getExceptionReasonLabel(exception.reasonCode)}</strong>
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
              onClick={() => void onApplyAction(exception.exceptionId, action, exception.transferRequestId)}
              type="button"
            >
              {getExceptionActionLabel(action)}
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
          void handleNoteSubmit(event, (body) => onAddNote(exception.exceptionId, body, exception.transferRequestId))
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

function ChainSummaryBlock({
  copyTitle,
  label,
  onCopy,
  title,
  value,
}: {
  copyTitle?: string;
  label: string;
  onCopy?: () => void;
  title?: string;
  value: string;
}) {
  return (
    <div className="chain-summary-field">
      <span className="chain-summary-label">{label}</span>
      <div className="chain-summary-value-row">
        <strong className="chain-summary-value" title={title}>
          {value}
        </strong>
        {onCopy ? (
          <div className="chain-summary-actions">
            <button
              className="ghost-button compact-button chain-summary-icon"
              onClick={onCopy}
              title={copyTitle ?? `Copy ${label.toLowerCase()}`}
              type="button"
            >
              ⧉
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function InspectorAccordion({
  children,
  defaultOpen = false,
  status,
  title,
}: {
  children: ReactNode;
  defaultOpen?: boolean;
  status?: string;
  title: string;
}) {
  return (
    <details className="inspector-accordion" open={defaultOpen}>
      <summary className="inspector-accordion-summary">
        <strong>{title}</strong>
        <span>{status ?? ''}</span>
      </summary>
      <div className="inspector-accordion-body">{children}</div>
    </details>
  );
}

function getTransferLabel(
  row:
    | Pick<ReconciliationRow, 'sourceWorkspaceAddress' | 'destinationWorkspaceAddress' | 'destination'>
    | Pick<TransferRequest, 'sourceWorkspaceAddress' | 'destinationWorkspaceAddress' | 'destination'>,
) {
  const source = row.sourceWorkspaceAddress?.address ?? row.sourceWorkspaceAddress?.displayName ?? 'Source not set';
  const destination = getDestinationLabel(row.destination, row.destinationWorkspaceAddress);
  return `${source} -> ${destination}`;
}

function getDestinationLabel(destination: Destination | null, fallback: WorkspaceAddressLite | null) {
  return destination?.label ?? fallback?.displayName?.trim() ?? fallback?.address ?? 'Unknown';
}

function getDestinationTrustCopy(destination: Destination) {
  if (!destination.isActive) {
    return 'This destination is inactive. New requests are blocked until it is reactivated.';
  }

  switch (destination.trustState) {
    case 'trusted':
      return 'Trusted destinations can be submitted directly. Workspace approval policy then decides whether the request auto-clears or enters the approval inbox.';
    case 'restricted':
      return 'Restricted destinations can still be modeled, but every new request must stay as a draft until someone changes the destination trust.';
    case 'blocked':
      return 'Blocked destinations cannot be used for new requests.';
    case 'unreviewed':
    default:
      return 'Unreviewed destinations can be recorded, but requests must stay as drafts until the destination is trusted.';
  }
}

function findWorkspaceAddressByChainValue(addresses: WorkspaceAddress[], value: string | null | undefined) {
  if (!value) {
    return null;
  }

  return addresses.find((item) => item.address === value || item.usdcAtaAddress === value) ?? null;
}

function getPrimarySettlementSignature(detail: ReconciliationDetail) {
  return detail.linkedSignature
    ?? detail.match?.signature
    ?? detail.observedExecutionTransaction?.signature
    ?? detail.latestExecution?.submittedSignature
    ?? detail.linkedObservedTransfers[0]?.signature
    ?? null;
}

function getPrimarySourceAddress(detail: ReconciliationDetail) {
  return detail.linkedObservedPayment?.sourceWallet
    ?? detail.linkedObservedTransfers.find((item) => item.sourceWallet)?.sourceWallet
    ?? detail.sourceWorkspaceAddress?.address
    ?? null;
}

function getPrimaryDestinationAddress(detail: ReconciliationDetail) {
  return detail.linkedObservedPayment?.destinationWallet
    ?? detail.linkedObservedTransfers.find((item) => item.destinationWallet)?.destinationWallet
    ?? detail.destination?.walletAddress
    ?? detail.destinationWorkspaceAddress?.address
    ?? null;
}

function getPrimarySettlementTime(detail: ReconciliationDetail) {
  return detail.match?.matchedAt
    ?? detail.linkedObservedPayment?.eventTime
    ?? detail.observedExecutionTransaction?.eventTime
    ?? detail.linkedObservedTransfers[0]?.eventTime
    ?? detail.requestedAt;
}

function formatUsdcUsdBadge(amountRaw: string) {
  const decimal = Number(formatRawUsdc(amountRaw));
  if (!Number.isFinite(decimal)) {
    return '$0.00';
  }

  return `$${decimal.toFixed(2)}`;
}

function getCompletionHeadline(detail: ReconciliationDetail) {
  if (detail.exceptions.some((item) => item.reasonCode === 'partial_settlement' && item.status !== 'dismissed')) {
    return 'Partial settlement';
  }

  switch (detail.requestDisplayState) {
    case 'matched':
      return 'Completed';
    case 'exception':
      return 'Needs review';
    case 'partial':
      return 'Partial match';
    case 'pending':
    default:
      return 'Waiting for settlement';
  }
}

function getCompletionSubtext(detail: ReconciliationDetail) {
  const parts: string[] = [];

  if (detail.approvalState === 'approved') {
    parts.push('Auto-approved');
  } else {
    parts.push(getApprovalStateLabel(detail.approvalState));
  }

  if (detail.match?.chainToMatchMs !== null && detail.match?.chainToMatchMs !== undefined) {
    parts.push(`matched onchain in ${detail.match.chainToMatchMs} ms`);
  } else if (detail.match) {
    parts.push('matched onchain');
  } else if (detail.requestDisplayState === 'pending') {
    parts.push('not settled yet');
  } else if (detail.requestDisplayState === 'exception') {
    parts.push('operator review needed');
  }

  return parts.join(' // ');
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

function getObservedTransferTypeLabel(legRole: string) {
  switch (legRole) {
    case 'direct_settlement':
      return 'direct settlement';
    case 'other_destination':
      return 'other route';
    case 'self_change':
      return 'self change';
    case 'unknown':
      return 'unclassified';
    default:
      return legRole.replaceAll('_', ' ');
  }
}

function getObservedPaymentKindLabel(paymentKind: string) {
  switch (paymentKind) {
    case 'direct':
      return 'direct';
    case 'multi_leg_settlement':
      return 'multi-leg settlement';
    case 'multi_destination_route':
      return 'multi-destination route';
    case 'routed_with_fee':
      return 'multi-destination route';
    default:
      return paymentKind.replaceAll('_', ' ');
  }
}

function getDisplayStateLabel(
  row: Pick<ReconciliationRow, 'requestDisplayState' | 'match' | 'exceptions'>,
) {
  if (row.exceptions.some((item) => item.reasonCode === 'partial_settlement' && item.status !== 'dismissed')) {
    return 'partial settlement';
  }

  switch (row.requestDisplayState) {
    case 'matched':
      return 'matched';
    case 'partial':
      return 'partial match';
    case 'exception':
      return 'needs review';
    case 'pending':
    default:
      return 'waiting for settlement';
  }
}

function getDisplayStateLabelFromState(state: ReconciliationRow['requestDisplayState']) {
  switch (state) {
    case 'matched':
      return 'matched';
    case 'partial':
      return 'partial match';
    case 'exception':
      return 'needs review';
    case 'pending':
    default:
      return 'waiting for settlement';
  }
}

function getExceptionActionLabel(action: string) {
  switch (action) {
    case 'dismissed':
      return 'dismiss exception';
    case 'expected':
      return 'mark expected';
    case 'reviewed':
      return 'mark reviewed';
    case 'reopen':
      return 'reopen exception';
    default:
      return formatLabel(action);
  }
}

function getTimelineTitle(item: ReconciliationDetail['timeline'][number]) {
  switch (item.timelineType) {
    case 'request_event':
      if (item.eventType === 'execution_created') {
        return 'execution created';
      }
      if (item.eventType === 'execution_signature_attached') {
        return 'signature attached';
      }
      if (item.eventType === 'execution_state_changed') {
        return 'execution state changed';
      }
      return formatLabel(item.eventType);
    case 'request_note':
      return 'request note';
    case 'approval_decision':
      return getApprovalActionLabel(item.action);
    case 'execution_record':
      return getExecutionStateLabel(item.state);
    case 'observed_execution':
      return 'observed execution';
    case 'match_result':
      return formatLabel(item.matchStatus);
    case 'exception':
      return getExceptionReasonLabel(item.reasonCode);
  }
}

function getTimelineBody(item: ReconciliationDetail['timeline'][number]) {
  switch (item.timelineType) {
    case 'request_event':
      if (item.eventType === 'execution_signature_attached') {
        return item.linkedSignature
          ? `Attached submitted signature ${shortenAddress(item.linkedSignature, 8, 8)}`
          : 'Attached a submitted signature.';
      }
      if (item.eventType === 'execution_created' || item.eventType === 'execution_state_changed') {
        return item.beforeState && item.afterState
          ? `${formatLabel(item.beforeState)} -> ${formatLabel(item.afterState)}`
          : formatLabel(item.eventType);
      }
      return item.beforeState && item.afterState
        ? `${formatLabel(item.beforeState)} -> ${formatLabel(item.afterState)}`
        : item.eventSource;
    case 'request_note':
      return item.body;
    case 'approval_decision':
      return item.comment ?? getApprovalDecisionSummary(item.action);
    case 'execution_record':
      return item.submittedSignature
        ? `${getExecutionStateLabel(item.state)} // ${shortenAddress(item.submittedSignature, 8, 8)}`
        : `${getExecutionStateLabel(item.state)} // ${formatLabel(item.executionSource)}`;
    case 'observed_execution':
      return `${shortenAddress(item.signature, 8, 8)} // slot ${item.slot} // ${formatLabel(item.status)}`;
    case 'match_result':
      return item.explanation;
    case 'exception':
      return item.explanation;
  }
}

function formatLatency(value: number | null) {
  return value === null ? 'n/a' : `${Math.round(value)} ms`;
}

async function handleMetadataSubmit(
  event: FormEvent<HTMLFormElement>,
  onSubmit: (input: {
    assignedToUserId?: string | null;
    resolutionCode?: string | null;
    severity?: 'info' | 'warning' | 'critical' | null;
    note?: string;
  }) => Promise<void>,
) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const assignedToUserId = String(formData.get('assignedToUserId') ?? '').trim();
  const resolutionCode = String(formData.get('resolutionCode') ?? '').trim();
  const severity = String(formData.get('severity') ?? '').trim();
  const note = String(formData.get('note') ?? '').trim();

  await onSubmit({
    assignedToUserId: assignedToUserId || null,
    resolutionCode: resolutionCode || null,
    severity: (severity || null) as 'info' | 'warning' | 'critical' | null,
    note: note || undefined,
  });
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
