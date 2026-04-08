import { useEffect, useState, type FormEvent } from 'react';
import type {
  ApprovalInboxItem,
  ApprovalPolicy,
  Counterparty,
  Destination,
  ExceptionItem,
  ObservedTransfer,
  ReconciliationDetail,
  ReconciliationRow,
  TransferRequest,
  Workspace,
  WorkspaceAddress,
  WorkspaceAddressLite,
} from '../types';
import { formatRawUsdc, formatTimestamp, orbTransactionUrl, shortenAddress } from '../lib/app';
import { InfoLine, Metric } from '../components/ui';

export function WorkspaceHomePage({
  approvalInbox,
  addresses,
  currentRole,
  currentWorkspace,
  isLoading,
  observedTransfers,
  onOpenSetup,
  onAddExceptionNote,
  onAddRequestNote,
  onApplyExceptionAction,
  onApplyApprovalDecision,
  onCreateExecutionRecord,
  onChangeReconciliationFilter,
  onRefresh,
  onSelectObservedTransfer,
  onSelectReconciliation,
  onTransitionRequest,
  onUpdateExecutionRecord,
  onBackToDashboard,
  reconciliationFilter,
  reconciliationRows,
  selectedObservedTransfer,
  selectedReconciliationDetail,
  transferRequests,
  isLoadingReconciliationDetail,
}: {
  approvalInbox: ApprovalInboxItem[];
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
  onApplyApprovalDecision: (
    transferRequestId: string,
    action: 'approve' | 'reject' | 'escalate',
    comment?: string,
  ) => Promise<void>;
  onCreateExecutionRecord: (transferRequestId: string) => Promise<void>;
  onChangeReconciliationFilter: (filter: ReconciliationRow['requestDisplayState'] | 'all') => void;
  onRefresh: () => Promise<void>;
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
  const [inspectorTab, setInspectorTab] = useState<'overview' | 'exceptions'>('overview');
  const [approvalComment, setApprovalComment] = useState('');
  const [executionSignature, setExecutionSignature] = useState('');

  useEffect(() => {
    if (
      selectedReconciliationDetail?.requestDisplayState === 'exception' &&
      selectedReconciliationDetail.exceptions.length
    ) {
      setInspectorTab('exceptions');
      return;
    }

    setInspectorTab('overview');
    setApprovalComment('');
    setExecutionSignature('');
  }, [selectedReconciliationDetail?.transferRequestId]);

  useEffect(() => {
    if (selectedReconciliationDetail?.latestExecution?.submittedSignature) {
      setExecutionSignature('');
    }
  }, [selectedReconciliationDetail?.latestExecution?.submittedSignature]);

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

      <section className="workspace-home-grid">
        <div className="workspace-home-primary">
          <div className="content-panel content-panel-strong">
            <div className="panel-header panel-header-stack">
              <div>
                <p className="eyebrow">Planned transfers</p>
                <h2>Requests and matches</h2>
                <p className="compact-copy">
                  The operator queue lives here. Watch the outcome first, then inspect settlement and execution context in the rail.
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

            <div className="stack-list">
              {reconciliationRows.length ? (
                reconciliationRows.map((row) => (
                  <div
                    key={row.transferRequestId}
                    className={
                      selectedReconciliationDetail?.transferRequestId === row.transferRequestId
                        ? 'feed-row is-active'
                        : 'feed-row'
                    }
                    data-tone={row.requestDisplayState}
                  >
                    <button className="feed-row-main request-card-main" onClick={() => onSelectReconciliation(row)} type="button">
                      <div className="request-card-copy">
                        <div className="request-card-title">
                          <strong>{getTransferLabel(row)}</strong>
                          <span className={`tone-pill tone-pill-${row.requestDisplayState}`}>
                            {getDisplayStateLabel(row.requestDisplayState)}
                          </span>
                        </div>
                        <div className="request-card-meta">
                          <span className="meta-pill">to {getDestinationLabel(row.destination, row.destinationWorkspaceAddress)}</span>
                          {row.destination?.counterparty ? (
                            <span className="meta-pill">{row.destination.counterparty.displayName}</span>
                          ) : null}
                          {row.destination ? (
                            <span className="meta-pill">
                              {row.destination.trustState} // {row.destination.isInternal ? 'internal' : 'external'}
                            </span>
                          ) : null}
                          <span className="meta-pill">{formatTimestamp(row.requestedAt)}</span>
                          <span className="meta-pill">{formatLabel(row.requestType)}</span>
                          {row.exceptions[0] ? (
                            <span className="meta-pill meta-pill-danger">
                              {getExceptionReasonLabel(row.exceptions[0].reasonCode)}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <div className="request-card-amount">
                        <strong>{formatRawUsdc(row.amountRaw)}</strong>
                        <small>USDC</small>
                      </div>
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
        </div>

        <aside className="workspace-home-secondary">
          <div className="content-panel content-panel-soft">
            <div className="panel-header panel-header-stack">
              <div>
                <p className="eyebrow">Approval inbox</p>
                <h2>Requests needing review</h2>
                <p className="compact-copy">
                  Policy-routed requests wait here until an operator approves, rejects, or escalates them.
                </p>
              </div>
              <span className="status-chip">{approvalInbox.length}</span>
            </div>
            <div className="stack-list">
              {approvalInbox.length ? (
                approvalInbox.map((item) => (
                  <button
                    key={item.transferRequestId}
                    className={
                      selectedReconciliationDetail?.transferRequestId === item.transferRequestId
                        ? 'feed-row is-active'
                        : 'feed-row'
                    }
                    data-tone="pending"
                    onClick={() => onSelectReconciliation(item)}
                    type="button"
                  >
                    <div className="request-card-copy">
                      <div className="request-card-title">
                        <strong>{getTransferLabel(item)}</strong>
                        <span className="meta-pill meta-pill-danger">{getApprovalStateLabel(item.approvalState)}</span>
                      </div>
                      <div className="request-card-meta">
                        <span className="meta-pill">{formatRawUsdc(item.amountRaw)} USDC</span>
                        <span className="meta-pill">{getDestinationLabel(item.destination, item.destinationWorkspaceAddress)}</span>
                        {item.approvalEvaluation.reasons.map((reason) => (
                          <span className="meta-pill meta-pill-danger" key={reason.code}>
                            {getApprovalReasonLabel(reason.code)}
                          </span>
                        ))}
                      </div>
                    </div>
                  </button>
                ))
              ) : (
                <div className="empty-box compact">No requests currently require approval.</div>
              )}
            </div>
          </div>

          {selectedReconciliationDetail ? (
            <div className="content-panel content-panel-strong workspace-inspector-panel">
              <div className="transfer-inspector-drawer transfer-inspector-sticky">
                <div className="panel-header panel-header-stack">
                  <div>
                    <p className="eyebrow">Request inspector</p>
                    <h2>Request and match</h2>
                  </div>
                </div>

                <div className="stack-list">
                  <InfoLine label="Transfer" value={getTransferLabel(selectedReconciliationDetail)} />
                  <InfoLine label="Requested amount" value={formatRawUsdc(selectedReconciliationDetail.amountRaw)} />
                  <InfoLine
                    label="Destination"
                    value={getDestinationLabel(
                      selectedReconciliationDetail.destination,
                      selectedReconciliationDetail.destinationWorkspaceAddress,
                    )}
                  />
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
                      selectedReconciliationDetail.destination?.walletAddress
                      ?? selectedReconciliationDetail.destinationWorkspaceAddress?.address
                      ?? 'Unknown'
                    }
                  />
                  <InfoLine
                    label="Receiving USDC ATA"
                    value={
                      selectedReconciliationDetail.destination?.tokenAccountAddress
                      ?? selectedReconciliationDetail.destinationWorkspaceAddress?.usdcAtaAddress
                      ?? 'Unknown'
                    }
                  />
                  <InfoLine label="Requested at" value={formatTimestamp(selectedReconciliationDetail.requestedAt)} />

                  <div className="state-summary-grid">
                    <div className="state-summary-card">
                      <span className="eyebrow">Approval</span>
                      <strong>{getApprovalStateLabel(selectedReconciliationDetail.approvalState)}</strong>
                      <small>Can this request become active yet?</small>
                    </div>
                    <div className="state-summary-card">
                      <span className="eyebrow">Execution</span>
                      <strong>{getExecutionStateLabel(selectedReconciliationDetail.executionState)}</strong>
                      <small>Has anything actually been sent or observed onchain?</small>
                    </div>
                    <div className="state-summary-card">
                      <span className="eyebrow">Reconciliation</span>
                      <strong>{getDisplayStateLabel(selectedReconciliationDetail.requestDisplayState)}</strong>
                      <small>How does observed settlement compare to the request?</small>
                    </div>
                  </div>

                  <div className="detail-section">
                    <div className="detail-section-head">
                      <strong>Execution tracking</strong>
                      <span>{selectedReconciliationDetail.latestExecution ? 'active attempt' : 'no attempt yet'}</span>
                    </div>

                    {selectedReconciliationDetail.latestExecution ? (
                      <div className="stack-list">
                        <InfoLine
                          label="Execution state"
                          value={getExecutionStateLabel(selectedReconciliationDetail.executionState)}
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
                          <div className="detail-section">
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
                          <div className="detail-section">
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
                  </div>

                  <div className="detail-section">
                    <div className="detail-section-head">
                      <strong>Approval check</strong>
                      <span>
                        {selectedReconciliationDetail.approvalEvaluation.requiresApproval
                          ? 'manual review needed'
                          : 'auto-cleared'}
                      </span>
                    </div>
                    {selectedReconciliationDetail.approvalEvaluation.requiresApproval ? (
                      <div className="detail-section stack-list">
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
                        Auto-cleared by {selectedReconciliationDetail.approvalEvaluation.policyName}. No approval reasons were triggered.
                      </div>
                    )}
                  </div>

                  {(selectedReconciliationDetail.approvalState === 'pending_approval'
                    || selectedReconciliationDetail.approvalState === 'escalated') ? (
                    <div className="detail-section">
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

                  {selectedReconciliationDetail.approvalDecisions.length ? (
                    <div className="detail-section">
                      <div className="detail-section-head">
                        <strong>Approval history</strong>
                        <span>{selectedReconciliationDetail.approvalDecisions.length}</span>
                      </div>
                      <div className="stack-list">
                        {selectedReconciliationDetail.approvalDecisions.map((decision) => (
                          <div className="note-card" key={decision.approvalDecisionId}>
                            <strong>{getApprovalActionLabel(decision.action)}</strong>
                            <small>
                              {decision.actorUser?.displayName ?? decision.actorUser?.email ?? decision.actorType} //{' '}
                              {formatTimestamp(decision.createdAt)}
                            </small>
                            {decision.payloadJson && 'reasons' in decision.payloadJson ? (
                              <p>{getApprovalDecisionSummary(decision.action)}</p>
                            ) : null}
                            {decision.comment ? <p>{decision.comment}</p> : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

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

                  {selectedReconciliationDetail.exceptions.length ? (
                    <div className="filter-row filter-row-compact">
                      {(['overview', 'exceptions'] as const).map((tab) => (
                        <button
                          className={inspectorTab === tab ? 'filter-chip is-active' : 'filter-chip'}
                          key={tab}
                          onClick={() => setInspectorTab(tab)}
                          type="button"
                        >
                          {tab === 'overview'
                            ? 'overview'
                            : `exceptions (${selectedReconciliationDetail.exceptions.length})`}
                        </button>
                      ))}
                    </div>
                  ) : null}

                  {inspectorTab === 'overview' ? (
                    <>
                      {selectedReconciliationDetail.linkedSignature ? (
                        <div className="inspector-callout">
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
                        <>
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

                      {selectedReconciliationDetail.relatedObservedPayments.length > 1 ? (
                        <div className="detail-section">
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
                    </>
                  ) : (
                    <>
                      <div className="empty-box compact">
                        {selectedReconciliationDetail.exceptionExplanation ??
                          'Exceptions are preventing this request from being treated as fully settled.'}
                      </div>
                      <div className="detail-section">
                        <div className="detail-section-head">
                          <strong>Exceptions</strong>
                          <span>{selectedReconciliationDetail.exceptions.length}</span>
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
                      </div>
                    </>
                  )}

                  <div className="detail-section">
                    <div className="detail-section-head">
                      <strong>{inspectorTab === 'exceptions' ? 'Exception timeline' : 'Timeline'}</strong>
                      <span>
                        {
                          selectedReconciliationDetail.timeline.filter((item) =>
                            inspectorTab === 'exceptions' ? item.timelineType === 'exception' : true,
                          ).length
                        }
                      </span>
                    </div>
                    <div className="timeline-list">
                      {selectedReconciliationDetail.timeline
                        .filter((item) => (inspectorTab === 'exceptions' ? item.timelineType === 'exception' : true))
                        .map((item, index) => (
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
            </div>
          ) : isLoadingReconciliationDetail ? (
            <div className="empty-box compact transfer-empty-state">Loading request detail…</div>
          ) : (
            <div className="empty-box compact transfer-empty-state">
              Select a request to inspect the settlement timeline, exceptions, and notes.
            </div>
          )}
        </aside>
      </section>
    </div>
  );
}

export function WorkspaceSetupPage({
  approvalPolicy,
  addresses,
  canManage,
  counterparties,
  currentWorkspace,
  destinations,
  onBackToDashboard,
  onBackToWatchSystem,
  onCreateAddress,
  onCreateCounterparty,
  onCreateDestination,
  onCreateTransferRequest,
  onUpdateApprovalPolicy,
  onUpdateAddress,
  onUpdateCounterparty,
  onUpdateDestination,
  transferRequests,
}: {
  approvalPolicy: ApprovalPolicy | null;
  addresses: WorkspaceAddress[];
  canManage: boolean;
  counterparties: Counterparty[];
  currentWorkspace: Workspace;
  destinations: Destination[];
  onBackToDashboard: () => void;
  onBackToWatchSystem: () => void;
  onCreateAddress: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onCreateCounterparty: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onCreateDestination: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onCreateTransferRequest: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onUpdateApprovalPolicy: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onUpdateAddress: (workspaceAddressId: string, event: FormEvent<HTMLFormElement>) => Promise<void>;
  onUpdateCounterparty: (counterpartyId: string, event: FormEvent<HTMLFormElement>) => Promise<void>;
  onUpdateDestination: (destinationId: string, event: FormEvent<HTMLFormElement>) => Promise<void>;
  transferRequests: TransferRequest[];
}) {
  const [editingAddressId, setEditingAddressId] = useState<string | null>(null);
  const [editingCounterpartyId, setEditingCounterpartyId] = useState<string | null>(null);
  const [editingDestinationId, setEditingDestinationId] = useState<string | null>(null);
  const [selectedRequestDestinationId, setSelectedRequestDestinationId] = useState('');
  const [requestCreateStatus, setRequestCreateStatus] = useState<'draft' | 'submitted'>('submitted');
  const editingAddress = addresses.find((item) => item.workspaceAddressId === editingAddressId) ?? null;
  const editingCounterparty = counterparties.find((item) => item.counterpartyId === editingCounterpartyId) ?? null;
  const editingDestination = destinations.find((item) => item.destinationId === editingDestinationId) ?? null;
  const selectedRequestDestination =
    destinations.find((item) => item.destinationId === selectedRequestDestinationId) ?? null;

  useEffect(() => {
    if (editingAddressId && !editingAddress) {
      setEditingAddressId(null);
    }
  }, [editingAddress, editingAddressId]);

  useEffect(() => {
    if (editingCounterpartyId && !editingCounterparty) {
      setEditingCounterpartyId(null);
    }
  }, [editingCounterparty, editingCounterpartyId]);

  useEffect(() => {
    if (editingDestinationId && !editingDestination) {
      setEditingDestinationId(null);
    }
  }, [editingDestination, editingDestinationId]);

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
  }, [selectedRequestDestinationId]);

  return (
    <div className="page-stack">
      <section className="section-headline">
        <div>
          <p className="eyebrow">Setup</p>
          <h1>{currentWorkspace.workspaceName}</h1>
          <p className="section-copy">
            Save wallets, define business destinations, then create planned transfers against those destinations.
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
            <p>Only organization admins can change wallets, destinations, and planned transfers in this workspace.</p>
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
          <form
            key={`wallet-form-${editingAddress?.workspaceAddressId ?? 'new'}`}
            className="form-stack"
            onSubmit={(event) =>
              editingAddress
                ? void onUpdateAddress(editingAddress.workspaceAddressId, event).then(() => setEditingAddressId(null))
                : void onCreateAddress(event)
            }
          >
            <label className="field">
              <span>Wallet address</span>
              <input
                defaultValue={editingAddress?.address ?? ''}
                name="address"
                placeholder="Solana wallet address"
                required
              />
            </label>
            <label className="field">
              <span>Wallet registry name</span>
              <input
                defaultValue={editingAddress?.displayName ?? ''}
                name="displayName"
                placeholder="Treasury wallet, hot wallet, vendor wallet..."
                required
              />
              <small className="field-note">Short technical name for this saved address row.</small>
            </label>
            <label className="field">
              <span>Notes</span>
              <input defaultValue={editingAddress?.notes ?? ''} name="notes" placeholder="Optional" />
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
              {editingAddress ? (
                <button
                  className="ghost-button"
                  onClick={() => setEditingAddressId(null)}
                  type="button"
                >
                  cancel
                </button>
              ) : null}
            </div>
          </form>

          <div className="stack-list">
            {addresses.length ? (
              addresses.map((address) => (
              <div key={address.workspaceAddressId} className="workspace-row static-row">
                  <div>
                    <strong>{getWalletName(address)}</strong>
                    <small>{address.address}</small>
                  </div>
                  <div className="workspace-row-actions">
                    <span className="status-chip">{address.isActive ? 'active' : 'inactive'}</span>
                    <button
                      className="ghost-button compact-button"
                      onClick={() => setEditingAddressId(address.workspaceAddressId)}
                      type="button"
                    >
                      edit
                    </button>
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
              <h2>Counterparties</h2>
              <p className="compact-copy">Capture who this wallet belongs to so reconciliation has business identity, not just an address.</p>
            </div>
          </div>
          <form
            key={`counterparty-form-${editingCounterparty?.counterpartyId ?? 'new'}`}
            className="form-stack"
            onSubmit={(event) =>
              editingCounterparty
                ? void onUpdateCounterparty(editingCounterparty.counterpartyId, event).then(() => setEditingCounterpartyId(null))
                : void onCreateCounterparty(event)
            }
          >
            <label className="field">
              <span>Business entity name</span>
              <input
                defaultValue={editingCounterparty?.displayName ?? ''}
                name="displayName"
                placeholder="Acme Vendor, Coinbase Prime, Treasury Ops..."
                required
              />
              <small className="field-note">The company, team, or business entity behind one or more destinations.</small>
            </label>
            <label className="field">
              <span>Category</span>
              <input defaultValue={editingCounterparty?.category ?? ''} name="category" placeholder="vendor" />
            </label>
            <label className="field">
              <span>Reference</span>
              <input
                defaultValue={editingCounterparty?.externalReference ?? ''}
                name="externalReference"
                placeholder="Optional external id"
              />
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
              {editingCounterparty ? (
                <button className="ghost-button" onClick={() => setEditingCounterpartyId(null)} type="button">
                  cancel
                </button>
              ) : null}
            </div>
          </form>

          <div className="stack-list">
            {counterparties.length ? (
              counterparties.map((item) => (
                <div key={item.counterpartyId} className="workspace-row static-row">
                  <div>
                    <strong>{item.displayName}</strong>
                    <small>{item.category} // {item.status}</small>
                  </div>
                  <div className="workspace-row-actions">
                    <button
                      className="ghost-button compact-button"
                      onClick={() => setEditingCounterpartyId(item.counterpartyId)}
                      type="button"
                    >
                      edit
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className="empty-box compact">No counterparties yet.</div>
            )}
          </div>
        </div>

        <div className="content-panel content-panel-strong" id="destinations-section">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Step 3</p>
              <h2>Destinations</h2>
              <p className="compact-copy">Link each wallet to a named destination with trust and internal or external context.</p>
            </div>
          </div>
          <form
            key={`destination-form-${editingDestination?.destinationId ?? 'new'}`}
            className="form-stack"
            onSubmit={(event) =>
              editingDestination
                ? void onUpdateDestination(editingDestination.destinationId, event).then(() => setEditingDestinationId(null))
                : void onCreateDestination(event)
            }
          >
            <label className="field">
              <span>Linked wallet</span>
              <select
                defaultValue={editingDestination?.linkedWorkspaceAddressId ?? ''}
                name="linkedWorkspaceAddressId"
                required
              >
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
              <span>Payment endpoint label</span>
              <input
                defaultValue={editingDestination?.label ?? ''}
                name="label"
                placeholder="Acme payout wallet"
                required
              />
              <small className="field-note">
                Operator-facing name for this specific payment endpoint. This can differ from both the wallet name and the counterparty name.
              </small>
            </label>
            <label className="field">
              <span>Destination type</span>
              <input
                defaultValue={editingDestination?.destinationType ?? ''}
                name="destinationType"
                placeholder="vendor_wallet"
              />
              <small className="field-note">Use this to distinguish payout, refund, treasury, or exchange destinations.</small>
            </label>
            <label className="field">
              <span>Trust state</span>
              <select name="trustState" defaultValue={editingDestination?.trustState ?? 'unreviewed'}>
                <option value="unreviewed">unreviewed</option>
                <option value="trusted">trusted</option>
                <option value="restricted">restricted</option>
                <option value="blocked">blocked</option>
              </select>
              <small className="field-note">Trust controls whether new requests can go live immediately, must stay in draft, or are blocked entirely.</small>
            </label>
            <label className="field">
              <span>Scope</span>
              <select name="isInternal" defaultValue={editingDestination?.isInternal ? 'true' : 'false'}>
                <option value="false">external</option>
                <option value="true">internal</option>
              </select>
            </label>
            <label className="field">
              <span>Notes</span>
              <input defaultValue={editingDestination?.notes ?? ''} name="notes" placeholder="Optional" />
            </label>
            <label className="field">
              <span>Status</span>
              <select defaultValue={editingDestination?.isActive === false ? 'false' : 'true'} name="isActive">
                <option value="true">active</option>
                <option value="false">inactive</option>
              </select>
            </label>
            <div className="exception-actions">
              <button className="primary-button" disabled={!canManage || addresses.length === 0} type="submit">
                {editingDestination ? 'Update destination' : 'Create destination'}
              </button>
              {editingDestination ? (
                <button
                  className="ghost-button"
                  onClick={() => setEditingDestinationId(null)}
                  type="button"
                >
                  cancel
                </button>
              ) : null}
            </div>
          </form>

          <div className="stack-list">
            {destinations.length ? (
              destinations.map((item) => (
                <div key={item.destinationId} className="workspace-row static-row">
                  <div>
                    <strong>{item.label}</strong>
                    <small>
                      {item.counterparty?.displayName ?? 'No counterparty'} // {item.trustState} // {item.isInternal ? 'internal' : 'external'}
                    </small>
                  </div>
                  <div className="workspace-row-actions">
                    <span className="status-chip">{item.isActive ? 'active' : 'inactive'}</span>
                    <button
                      className="ghost-button compact-button"
                      onClick={() => setEditingDestinationId(item.destinationId)}
                      type="button"
                    >
                      edit
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className="empty-box compact">No destinations yet.</div>
            )}
          </div>
        </div>

        <div className="content-panel content-panel-strong">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Step 4</p>
              <h2>Approval policy</h2>
              <p className="compact-copy">Control which requests auto-clear and which must enter the approval inbox.</p>
            </div>
          </div>
          {approvalPolicy ? (
            <form className="form-stack" onSubmit={onUpdateApprovalPolicy}>
              <label className="field">
                <span>Policy name</span>
                <input defaultValue={approvalPolicy.policyName} name="policyName" required />
              </label>
              <label className="field">
                <span>Policy status</span>
                <select defaultValue={approvalPolicy.isActive ? 'true' : 'false'} name="isActive">
                  <option value="true">active</option>
                  <option value="false">inactive</option>
                </select>
              </label>
              <label className="field">
                <span>Trusted destination required</span>
                <select
                  defaultValue={approvalPolicy.ruleJson.requireTrustedDestination ? 'true' : 'false'}
                  name="requireTrustedDestination"
                >
                  <option value="true">yes</option>
                  <option value="false">no</option>
                </select>
              </label>
              <label className="field">
                <span>Always require approval for external</span>
                <select
                  defaultValue={approvalPolicy.ruleJson.requireApprovalForExternal ? 'true' : 'false'}
                  name="requireApprovalForExternal"
                >
                  <option value="false">no</option>
                  <option value="true">yes</option>
                </select>
              </label>
              <label className="field">
                <span>Always require approval for internal</span>
                <select
                  defaultValue={approvalPolicy.ruleJson.requireApprovalForInternal ? 'true' : 'false'}
                  name="requireApprovalForInternal"
                >
                  <option value="false">no</option>
                  <option value="true">yes</option>
                </select>
              </label>
              <label className="field">
                <span>External approval threshold</span>
                <input
                  defaultValue={approvalPolicy.ruleJson.externalApprovalThresholdRaw}
                  name="externalApprovalThresholdRaw"
                  placeholder="50000000"
                  required
                />
                <small className="field-note">Trusted external destinations at or above {formatRawUsdc(approvalPolicy.ruleJson.externalApprovalThresholdRaw)} USDC require approval.</small>
              </label>
              <label className="field">
                <span>Internal approval threshold</span>
                <input
                  defaultValue={approvalPolicy.ruleJson.internalApprovalThresholdRaw}
                  name="internalApprovalThresholdRaw"
                  placeholder="250000000"
                  required
                />
                <small className="field-note">Trusted internal destinations at or above {formatRawUsdc(approvalPolicy.ruleJson.internalApprovalThresholdRaw)} USDC require approval.</small>
              </label>
              <button className="primary-button" disabled={!canManage} type="submit">
                Update approval policy
              </button>
            </form>
          ) : (
            <div className="empty-box compact">Approval policy unavailable.</div>
          )}
        </div>

        <div className="content-panel content-panel-strong" id="planned-transfers-section">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Step 5</p>
              <h2>Planned transfers</h2>
              <p className="compact-copy">Create requests against destination objects so matching and review carry business context.</p>
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
              <small className="field-note">
                Requests now target a destination object, not a bare wallet, so trust and business identity carry through to reconciliation.
              </small>
            </label>
            {selectedRequestDestination ? (
              <div className="notice-banner compact-notice">
                <div>
                  <strong>
                    {selectedRequestDestination.label} // {selectedRequestDestination.trustState} // {selectedRequestDestination.isInternal ? 'internal' : 'external'}
                  </strong>
                  <p>
                    {getDestinationTrustCopy(selectedRequestDestination)}
                  </p>
                </div>
              </div>
            ) : null}
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
                {selectedRequestDestination?.isActive !== false
                && selectedRequestDestination?.trustState === 'trusted' ? (
                  <option value="submitted">make live request</option>
                ) : null}
              </select>
              <small className="field-note">
                Draft means “record it, but do not treat it as active yet.” Live request means the policy engine will immediately decide whether it auto-clears or enters the approval inbox.
              </small>
            </label>
            <label className="field">
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
              Create planned transfer
            </button>
          </form>

          <div className="stack-list">
            {transferRequests.length ? (
              transferRequests.map((item) => (
                <div key={item.transferRequestId} className="workspace-row static-row">
                  <div>
                    <strong>{getTransferLabel(item)}</strong>
                    <small>
                      {item.destination?.label ?? getWalletNameLite(item.destinationWorkspaceAddress)} // {item.requestType.replaceAll('_', ' ')} // {formatRawUsdc(item.amountRaw)}
                    </small>
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
            Phase B keeps the worker wallet-compatible, but new requests now point at named destinations. That means queue rows and request detail can show trust, counterparty, and internal or external context while matching still uses the linked receiving wallet underneath.
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
  return address?.displayName?.trim() || address?.address || 'Unknown';
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

function getExecutionStateLabel(state: string) {
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
    | Pick<ReconciliationRow, 'sourceWorkspaceAddress' | 'destinationWorkspaceAddress' | 'destination'>
    | Pick<TransferRequest, 'sourceWorkspaceAddress' | 'destinationWorkspaceAddress' | 'destination'>,
) {
  const source = row.sourceWorkspaceAddress?.displayName ?? row.sourceWorkspaceAddress?.address ?? 'Unknown';
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
      return 'partial match';
    case 'exception':
      return 'needs review';
    case 'pending':
    default:
      return 'waiting for settlement';
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
