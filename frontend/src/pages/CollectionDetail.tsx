import type { ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type { CollectionRequest, CollectionRequestEvent } from '../types';
import {
  assetSymbol,
  formatRawUsdcCompact,
  formatRelativeTime,
  formatTimestamp,
  orbAccountUrl,
  orbTransactionUrl,
  shortenAddress,
} from '../domain';
import {
  collectionSourceTrustTone,
  displayCollectionSourceName,
  displayCollectionSourceTrust,
  displayCollectionStatus,
  statusToneForCollection,
} from '../status-labels';
import { useToast } from '../ui/Toast';
import { DetailEntry } from '../ui-primitives';
import { LifecycleRail, type LifecycleStage, type StageState } from '../ui/LifecycleRail';

function toneToPill(
  tone: 'success' | 'warning' | 'danger' | 'neutral',
): 'success' | 'warning' | 'danger' | 'info' {
  return tone === 'success'
    ? 'success'
    : tone === 'danger'
      ? 'danger'
      : tone === 'warning'
        ? 'warning'
        : 'info';
}

function buildLifecycle(collection: CollectionRequest): LifecycleStage[] {
  const s = collection.derivedState;
  const settled = s === 'collected' || s === 'closed';
  const exception = s === 'exception' || s === 'partially_collected';
  const cancelled = s === 'cancelled';
  const awaiting = s === 'open';

  return [
    {
      id: 'request',
      label: 'Requested',
      sub: formatTimestamp(collection.createdAt),
      state: 'complete',
    },
    {
      id: 'awaiting',
      label: 'Awaiting payer',
      sub: cancelled
        ? 'Cancelled'
        : awaiting
          ? 'Waiting for transfer on-chain'
          : 'Transfer observed',
      state: cancelled ? 'blocked' : awaiting ? 'current' : 'complete',
    },
    {
      id: 'settlement',
      label: 'Settlement',
      sub: settled
        ? 'Matched on-chain'
        : exception
          ? 'Partial or variance'
          : cancelled
            ? '—'
            : 'Not yet received',
      state: settled
        ? 'complete'
        : exception
          ? 'blocked'
          : cancelled
            ? 'blocked'
            : 'pending',
    },
  ];
}

export function CollectionDetailPage() {
  const { organizationId, collectionRequestId } = useParams<{
    organizationId: string;
    collectionRequestId: string;
  }>();
  const _navigate = useNavigate();
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();

  const collectionQuery = useQuery({
    queryKey: ['collection', organizationId, collectionRequestId] as const,
    queryFn: () => api.getCollection(organizationId!, collectionRequestId!),
    enabled: Boolean(organizationId && collectionRequestId),
    refetchInterval: (query) => {
      if (typeof document !== 'undefined' && document.hidden) return false;
      const s = query.state.data?.derivedState;
      if (s === 'collected' || s === 'closed' || s === 'cancelled') return false;
      return 5_000;
    },
  });

  const proofQuery = useQuery({
    queryKey: ['collection-proof', organizationId, collectionRequestId] as const,
    queryFn: () => api.getCollectionProof(organizationId!, collectionRequestId!),
    enabled: Boolean(organizationId && collectionRequestId),
    refetchInterval: (query) => {
      if (typeof document !== 'undefined' && document.hidden) return false;
      const status = query.state.data?.status;
      if (status === 'complete' || status === 'closed' || status === 'cancelled') return false;
      return 10_000;
    },
  });

  const proofDownloadMutation = useMutation({
    mutationFn: () => api.downloadCollectionProofJson(organizationId!, collectionRequestId!),
    onError: (err) =>
      toastError(err instanceof Error ? err.message : 'Could not export collection proof.'),
  });

  const cancelMutation = useMutation({
    mutationFn: () => api.cancelCollection(organizationId!, collectionRequestId!),
    onSuccess: async () => {
      success('Collection cancelled.');
      await queryClient.invalidateQueries({
        queryKey: ['collection', organizationId, collectionRequestId],
      });
      await queryClient.invalidateQueries({ queryKey: ['collections', organizationId] });
    },
    onError: (err) =>
      toastError(err instanceof Error ? err.message : 'Could not cancel collection.'),
  });

  if (!organizationId || !collectionRequestId) {
    return (
      <main className="page-frame" data-layout="rd">
        <div className="rd-page-container">
          <div className="rd-state">
            <h2 className="rd-state-title">Not found</h2>
            <p className="rd-state-body">This collection does not exist.</p>
          </div>
        </div>
      </main>
    );
  }

  if (collectionQuery.isLoading) {
    return (
      <main className="page-frame" data-layout="rd">
        <div className="rd-page-container">
          <div className="rd-skeleton rd-skeleton-block" style={{ height: 260 }} />
        </div>
      </main>
    );
  }

  if (collectionQuery.isError || !collectionQuery.data) {
    return (
      <main className="page-frame" data-layout="rd">
        <div className="rd-page-container">
          <Link to={`/organizations/${organizationId}/collections`} className="rd-back">
            <span className="rd-back-arrow" aria-hidden>
              ←
            </span>
            <span>Collections</span>
          </Link>
          <div className="rd-state">
            <h2 className="rd-state-title">Couldn&apos;t load this collection</h2>
            <p className="rd-state-body">
              {collectionQuery.error instanceof Error
                ? collectionQuery.error.message
                : 'Something went wrong.'}
            </p>
            <button
              type="button"
              className="rd-btn rd-btn-secondary"
              onClick={() => void collectionQuery.refetch()}
            >
              Try again
            </button>
          </div>
        </div>
      </main>
    );
  }

  const collection = collectionQuery.data;
  const lifecycle = buildLifecycle(collection);
  const statusTone = statusToneForCollection(collection.derivedState);
  const amountLabel = `${formatRawUsdcCompact(collection.amountRaw)} ${assetSymbol(collection.asset)}`;
  const payerName = collection.collectionSource
    ? displayCollectionSourceName(
        collection.collectionSource.label,
        collection.collectionSource.walletAddress,
      )
    : collection.payerWalletAddress
      ? shortenAddress(collection.payerWalletAddress, 4, 4)
      : 'Any payer';
  const receiverWallet = collection.receivingTreasuryWallet;
  const settledSignature =
    collection.reconciliationDetail?.match?.signature ??
    collection.reconciliationDetail?.latestExecution?.submittedSignature ??
    null;
  const matchedAt = collection.reconciliationDetail?.match?.matchedAt ?? null;
  const canCancel = collection.derivedState === 'open';
  const isSettled =
    collection.derivedState === 'collected' || collection.derivedState === 'closed';

  return (
    <main className="page-frame" data-layout="rd">
      <div className="rd-page-container">
        <Link to={`/organizations/${organizationId}/collections`} className="rd-back">
          <span className="rd-back-arrow" aria-hidden>
            ←
          </span>
          <span>Collections</span>
        </Link>

        <header className="rd-header">
          <div>
            <p className="rd-eyebrow">Collection</p>
            <h1 className="rd-title">{payerName}</h1>
            <p className="rd-meta">
              <span className="rd-mono">{amountLabel}</span>
              {collection.externalReference ? (
                <>
                  <span className="rd-meta-sep">·</span>
                  <span className="rd-mono">{collection.externalReference}</span>
                </>
              ) : null}
              <span className="rd-meta-sep">·</span>
              <span>Created {formatRelativeTime(collection.createdAt)}</span>
            </p>
          </div>
          <div className="rd-header-side">
            <span className="rd-pill" data-tone={toneToPill(statusTone)}>
              <span className="rd-pill-dot" aria-hidden />
              {displayCollectionStatus(collection.derivedState)}
            </span>
            <button
              type="button"
              className="rd-btn rd-btn-secondary"
              onClick={() => proofDownloadMutation.mutate()}
              disabled={!isSettled || proofDownloadMutation.isPending}
              aria-busy={proofDownloadMutation.isPending}
              title={
                isSettled
                  ? undefined
                  : 'Proof is available once the collection is settled on-chain.'
              }
            >
              {proofDownloadMutation.isPending ? 'Exporting…' : 'Export proof'}
            </button>
          </div>
        </header>

        <LifecycleRail stages={lifecycle} ariaLabel="Collection lifecycle" />

        <PrimaryAction
          collection={collection}
          amountLabel={amountLabel}
          canCancel={canCancel}
          cancelling={cancelMutation.isPending}
          onCancel={() => {
            if (
              window.confirm(
                'Cancel this collection? Any future matching transfer will not be tied to it.',
              )
            ) {
              cancelMutation.mutate();
            }
          }}
        />

        <section className="rd-section">
          <div className="rd-section-head">
            <div>
              <h2 className="rd-section-title">Details</h2>
              <p className="rd-section-sub">Who&apos;s paying, where it lands, and what it&apos;s for.</p>
            </div>
          </div>
          <div className="rd-card">
            <dl
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: 20,
                margin: 0,
              }}
            >
              <DetailEntry label="Payer">
                {collection.collectionSource ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <Link
                      to={`/organizations/${organizationId}/payers`}
                      className="rd-addr-link"
                      style={{ fontSize: 13 }}
                    >
                      <span>{payerName}</span>
                    </Link>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span
                        className="rd-pill"
                        data-tone={toneToPill(
                          collectionSourceTrustTone(collection.collectionSource.trustState),
                        )}
                        style={{ fontSize: 11 }}
                      >
                        <span className="rd-pill-dot" aria-hidden />
                        {displayCollectionSourceTrust(collection.collectionSource.trustState)}
                      </span>
                      <a
                        href={orbAccountUrl(collection.collectionSource.walletAddress)}
                        target="_blank"
                        rel="noreferrer"
                        className="rd-mono"
                        style={{ fontSize: 11, color: 'var(--ax-text-muted)' }}
                      >
                        {shortenAddress(collection.collectionSource.walletAddress, 4, 4)}
                      </a>
                    </div>
                  </div>
                ) : collection.payerWalletAddress ? (
                  <a
                    href={orbAccountUrl(collection.payerWalletAddress)}
                    target="_blank"
                    rel="noreferrer"
                    className="rd-addr-link"
                  >
                    <span>{shortenAddress(collection.payerWalletAddress, 4, 4)}</span>
                  </a>
                ) : (
                  <span style={{ color: 'var(--ax-text-muted)' }}>Any payer</span>
                )}
              </DetailEntry>
              <DetailEntry label="Counterparty">
                {collection.counterparty?.displayName ? (
                  <Link
                    to={`/organizations/${organizationId}/counterparties`}
                    className="rd-addr-link"
                  >
                    <span>{collection.counterparty.displayName}</span>
                  </Link>
                ) : (
                  <span style={{ color: 'var(--ax-text-muted)' }}>—</span>
                )}
              </DetailEntry>
              <DetailEntry label="Receiver">
                <a
                  href={orbAccountUrl(receiverWallet.address)}
                  target="_blank"
                  rel="noreferrer"
                  className="rd-addr-link"
                >
                  <span>
                    {receiverWallet.displayName
                      ? `${receiverWallet.displayName} · ${shortenAddress(receiverWallet.address, 4, 4)}`
                      : shortenAddress(receiverWallet.address, 4, 4)}
                  </span>
                </a>
              </DetailEntry>
              <DetailEntry label="Amount">
                <span className="rd-mono">{amountLabel}</span>
              </DetailEntry>
              <DetailEntry label="Reference">
                {collection.externalReference ? (
                  <span className="rd-mono">{collection.externalReference}</span>
                ) : (
                  <span style={{ color: 'var(--ax-text-muted)' }}>—</span>
                )}
              </DetailEntry>
              <DetailEntry label="Due">
                {collection.dueAt ? (
                  <span>{formatTimestamp(collection.dueAt)}</span>
                ) : (
                  <span style={{ color: 'var(--ax-text-muted)' }}>—</span>
                )}
              </DetailEntry>
              {collection.collectionRun ? (
                <DetailEntry label="Batch">
                  <Link
                    to={`/organizations/${organizationId}/collection-runs/${collection.collectionRun.collectionRunId}`}
                    className="rd-addr-link"
                  >
                    <span>{collection.collectionRun.runName}</span>
                  </Link>
                </DetailEntry>
              ) : null}
              {settledSignature ? (
                <DetailEntry label="Settlement signature">
                  <a
                    href={orbTransactionUrl(settledSignature)}
                    target="_blank"
                    rel="noreferrer"
                    className="rd-tx-link"
                  >
                    <span>{shortenAddress(settledSignature, 6, 6)}</span>
                  </a>
                </DetailEntry>
              ) : null}
            </dl>
          </div>
        </section>

        {proofQuery.data ? (
          <section className="rd-section">
            <div className="rd-section-head">
              <div>
                <h2 className="rd-section-title">Proof readiness</h2>
                <p className="rd-section-sub">
                  Source review, reconciliation state, and verifier digest for this collection.
                </p>
              </div>
            </div>
            <div className="rd-card">
              <dl
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                  gap: 20,
                  margin: 0,
                }}
              >
                <DetailEntry label="Proof state">
                  <span className="rd-mono">{proofQuery.data.status}</span>
                </DetailEntry>
                <DetailEntry label="Readiness">
                  <span className="rd-mono">{proofQuery.data.readiness.status}</span>
                </DetailEntry>
                <DetailEntry label="Source review">
                  <span className="rd-mono">{proofQuery.data.collectionSourceReview.status}</span>
                </DetailEntry>
                <DetailEntry label="Digest">
                  <span className="rd-mono">{shortenAddress(proofQuery.data.canonicalDigest, 10, 10)}</span>
                </DetailEntry>
              </dl>
              <div style={{ marginTop: 18 }}>
                <p className="rd-primary-body" style={{ margin: 0 }}>
                  {proofQuery.data.collectionSourceReview.message}
                </p>
              </div>
            </div>
          </section>
        ) : null}

        <section className="rd-section">
          <div className="rd-section-head">
            <div>
              <h2 className="rd-section-title">Timeline</h2>
              <p className="rd-section-sub">Every recorded event for this collection.</p>
            </div>
          </div>
          <div className="rd-card">
            <div className="rd-timeline-shared">
              <TimelineRow
                title="Collection requested"
                meta={formatTimestamp(collection.createdAt)}
                body={`Created by ${collection.createdByUser?.email ?? 'System'}.`}
                state="complete"
              />
              {(collection.events ?? [])
                .slice()
                .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
                .filter(
                  (e) =>
                    e.eventType !== 'collection_created' &&
                    e.eventType !== 'collection.created',
                )
                .map((e) => (
                  <TimelineRow
                    key={e.collectionRequestEventId}
                    title={eventTitle(e)}
                    meta={formatTimestamp(e.createdAt)}
                    body={eventBody(e)}
                    state="complete"
                  />
                ))}
              {settledSignature ? (
                <TimelineRow
                  title="Settlement observed"
                  meta={matchedAt ? formatTimestamp(matchedAt) : formatRelativeTime(collection.updatedAt)}
                  body={
                    <a
                      href={orbTransactionUrl(settledSignature)}
                      target="_blank"
                      rel="noreferrer"
                      className="rd-tx-link"
                    >
                      <span>{shortenAddress(settledSignature, 8, 8)}</span>
                    </a>
                  }
                  state={['collected', 'closed'].includes(collection.derivedState) ? 'complete' : 'pending'}
                />
              ) : null}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function PrimaryAction({
  collection,
  amountLabel,
  canCancel,
  cancelling,
  onCancel,
}: {
  collection: CollectionRequest;
  amountLabel: string;
  canCancel: boolean;
  cancelling: boolean;
  onCancel: () => void;
}) {
  const s = collection.derivedState;
  const receiver = collection.receivingTreasuryWallet;
  const receiverLine = receiver.displayName
    ? `${receiver.displayName} · ${shortenAddress(receiver.address, 4, 4)}`
    : shortenAddress(receiver.address, 4, 4);

  if (s === 'open') {
    return (
      <div className="rd-primary" data-emphasis="waiting">
        <p className="rd-primary-eyebrow">Awaiting payment</p>
        <h2 className="rd-primary-title">
          Watching for <span className="rd-mono">{amountLabel}</span>
        </h2>
        <p className="rd-primary-body">
          Share the receiver ({receiverLine}) with the payer. Decimal matches the transfer the
          moment it lands on-chain — typically within seconds of inclusion.
        </p>
        {canCancel ? (
          <div className="rd-actions">
            <button
              type="button"
              className="rd-btn rd-btn-secondary"
              onClick={onCancel}
              disabled={cancelling}
              aria-busy={cancelling}
            >
              {cancelling ? 'Cancelling…' : 'Cancel collection'}
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  if (s === 'partially_collected') {
    return (
      <div className="rd-primary" data-emphasis="warning">
        <p className="rd-primary-eyebrow">Partial settlement</p>
        <h2 className="rd-primary-title">Some of the expected amount arrived</h2>
        <p className="rd-primary-body">
          A transfer landed on the receiver wallet but the amount didn&apos;t match the expected
          total. Review the timeline to reconcile.
        </p>
      </div>
    );
  }

  if (s === 'exception') {
    return (
      <div className="rd-primary" data-emphasis="warning">
        <p className="rd-primary-eyebrow">Needs review</p>
        <h2 className="rd-primary-title">Exception raised</h2>
        <p className="rd-primary-body">
          Something doesn&apos;t add up — variance, duplicate, or late settlement. Check the
          exceptions queue for details.
        </p>
      </div>
    );
  }

  if (s === 'collected' || s === 'closed') {
    return (
      <div className="rd-primary" data-emphasis="success">
        <p className="rd-primary-eyebrow">Collected</p>
        <h2 className="rd-primary-title">
          <span className="rd-mono">{amountLabel}</span> received
        </h2>
        <p className="rd-primary-body">
          Transfer observed on-chain and matched to this collection.
        </p>
      </div>
    );
  }

  if (s === 'cancelled') {
    return (
      <div className="rd-primary" data-emphasis="muted">
        <p className="rd-primary-eyebrow">Cancelled</p>
        <h2 className="rd-primary-title">This collection was cancelled</h2>
        <p className="rd-primary-body">
          Any transfer arriving now is no longer tied to this expectation.
        </p>
      </div>
    );
  }

  return null;
}


function TimelineRow({
  title,
  meta,
  body,
  state,
}: {
  title: string;
  meta: string;
  body: ReactNode;
  state: StageState;
}) {
  return (
    <div className="rd-timeline-row" data-state={state}>
      <div className="rd-timeline-head-row">
        <strong>{title}</strong>
        <span className="rd-timeline-meta">{meta}</span>
      </div>
      <p className="rd-timeline-sub">{body}</p>
    </div>
  );
}

function eventTitle(e: CollectionRequestEvent): string {
  const base = e.eventType.replaceAll(/[_.]/g, ' ');
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function eventBody(e: CollectionRequestEvent): string {
  if (e.beforeState && e.afterState) {
    return `${e.beforeState} → ${e.afterState}`;
  }
  if (e.afterState) return `State → ${e.afterState}`;
  return '—';
}
