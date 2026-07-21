import type { ReactNode } from 'react';
import { IconArrowRight, IconCheck, IconDownload } from './Icons';

type RailStep = { key: string; label: string; meta: string };

const RAIL_STEPS: RailStep[] = [
  { key: 'imported', label: 'Imported', meta: '7 payments' },
  { key: 'reviewed', label: 'Reviewed', meta: 'All reviewed' },
  { key: 'approved', label: 'Approved', meta: '7 of 7' },
  { key: 'executed', label: 'Executed', meta: 'On-chain' },
  { key: 'settled', label: 'Settled', meta: '7 of 7 matched' },
  { key: 'proven', label: 'Proven', meta: 'Ready to export' },
];

const ACTIVE_META: Record<string, string> = {
  imported: '7 payments',
  reviewed: 'All reviewed',
  approved: '7 awaiting',
  executed: 'Ready to sign',
  settled: '0 of 7 matched',
  proven: 'Pending settlement',
};

const IDLE_META: Record<string, string> = {
  reviewed: 'Pending',
  approved: 'Pending',
  executed: 'Pending',
  settled: 'Pending',
  proven: 'Pending',
};

export function LifecycleRail({
  active = 5,
  pulse = false,
  compact = false,
}: {
  active?: number;
  pulse?: boolean;
  compact?: boolean;
}) {
  return (
    <div className={`lp-rail${compact ? ' lp-rail-compact' : ''}`}>
      {RAIL_STEPS.map((s, i) => {
        const state = i < active ? 'done' : i === active ? 'active' : 'idle';
        const meta =
          state === 'done'
            ? s.meta
            : state === 'active'
              ? ACTIVE_META[s.key] ?? s.meta
              : IDLE_META[s.key] ?? 'Pending';
        return (
          <div key={s.key} className={`lp-rail-step lp-rail-${state}`}>
            <div className="lp-rail-top">
              <span className="lp-rail-dot">
                {state === 'done' ? <IconCheck size={7} /> : null}
                {state === 'active' && pulse ? <span className="lp-rail-dot-pulse" /> : null}
              </span>
              {i < RAIL_STEPS.length - 1 ? <span className="lp-rail-line" /> : null}
            </div>
            <div className="lp-rail-label">{s.label}</div>
            <div className="lp-rail-meta">{meta}</div>
          </div>
        );
      })}
    </div>
  );
}

export function ProductCard({
  children,
  title = 'payouts',
  status,
}: {
  children: ReactNode;
  title?: string;
  status?: { label: string; tone: 'approval' | 'ready' | 'completed' };
}) {
  return (
    <div className="lp-product-card">
      <div className="lp-pc-topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            className="mono"
            style={{
              fontSize: 10,
              color: 'var(--ax-text-faint)',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
            }}
          >
            Payment run
          </span>
        </div>
        {status ? (
          <span className={`lp-pc-status lp-pc-status-${status.tone}`}>
            <span className="lp-pc-status-dot" />
            {status.label}
          </span>
        ) : null}
      </div>
      <div className="lp-pc-title-row">
        <h3 className="lp-pc-title">{title}</h3>
        <div className="lp-pc-sub mono">10,100.00 USDC · 7 payments · hello@gmail.com</div>
      </div>
      {children}
    </div>
  );
}

export function NextStepCard(props: {
  stage: string;
  title: string;
  body?: string;
  cta?: string;
  ctaSecondary?: string;
  secondary?: ReactNode;
}) {
  const { stage, title, body, cta, ctaSecondary, secondary } = props;
  return (
    <div className="lp-nxt-card">
      <div className="lp-nxt-eyebrow mono">Next step · {stage}</div>
      <div className="lp-nxt-title">{title}</div>
      {body ? <div className="lp-nxt-body">{body}</div> : null}
      {secondary}
      {cta ? (
        <div className="lp-nxt-actions">
          <span className="lp-nxt-btn lp-nxt-btn-primary">
            {cta} <IconArrowRight size={10} />
          </span>
          {ctaSecondary ? (
            <span className="lp-nxt-btn lp-nxt-btn-ghost">{ctaSecondary}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function CsvImportMockup() {
  return (
    <div className="lp-mock-frame">
      <div style={{ fontSize: 18, fontWeight: 500, letterSpacing: '-0.015em' }}>
        Import CSV batch
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 20 }}>
        <div>
          <div className="lp-fld-label">BATCH NAME</div>
          <div className="lp-fld-input lp-fld-focus">payouts</div>
        </div>
        <div>
          <div className="lp-fld-label">SOURCE WALLET</div>
          <div className="lp-fld-input lp-fld-select">fuyo's thicc wallet</div>
        </div>
      </div>
      <div className="lp-csv-wrap">
        <div className="lp-fld-label">CSV</div>
        <div className="lp-fld-textarea mono">
          counterparty,destination,amount,reference,due_date
          <br />
          Acme Corp,8cZ65A8ERdVsXq3YnEdMNimwG7DhGe1tPszysJwh43Zx,1000.00,INV-1001,2026-05-20
          <br />
          Beta Supplies,33yL624hoHqChSDR2y8L2cBjYRGEgQ9QSqcuKFfm1BnP,1500.00,INV-1002,2026-05-20
          <br />
          Gamma Studio,PGm4Wf2xRzK8cNv9LhBdEyTpQj6YmAsCr5nX3uFwoFMW,750.00,INV-1003,2026-05-21
          <br />
          Delta Labs,9aQrB5wT2pKsZxYvNcHdMeJgLiRfO3EhUuXkPoIyVbQs,2200.00,INV-1004,2026-05-22
          <br />
          Epsilon Inc,Tm7KqE4rYvWzLp2NcBhDfJgXsOiPaAlR5uMeQoZvFuT8,500.00,INV-1005,2026-05-23
          <br />
          Fuyo LLC,WqA1xZ9cP8nM7bV6kH5jG4fD3sE2yU0tY1rQ2wE3rT4y,3250.00,INV-1006,2026-05-24
          <br />
          Hex Foundation,Hx9VbN3mL7pKqR5tY8wZ2cD4fG1hJ6sE0aP9oQ3uIkX,900.00,INV-1007,2026-05-25
        </div>
      </div>
      <div className="lp-mock-actions">
        <span className="lp-nxt-btn lp-nxt-btn-ghost">Cancel</span>
        <span className="lp-nxt-btn lp-nxt-btn-primary">Review</span>
      </div>
    </div>
  );
}

export function ReviewMockup() {
  return (
    <div className="lp-mock-frame">
      <div style={{ fontSize: 18, fontWeight: 500, letterSpacing: '-0.015em' }}>
        Import CSV batch
      </div>
      <div
        className="mono"
        style={{
          fontSize: 11,
          color: 'var(--ax-text-muted)',
          marginTop: 14,
          marginBottom: 10,
        }}
      >
        7 rows · showing all · payouts
      </div>
      <div className="lp-rev-table">
        <div className="lp-rev-head">
          <div>COUNTERPARTY</div>
          <div>DESTINATION</div>
          <div style={{ textAlign: 'right' }}>AMOUNT</div>
          <div>REFERENCE</div>
          <div>DUE_DATE</div>
        </div>
        {[
          ['Acme Corp', '8cZ65…h43Zx', '1000.00', 'INV-1001', '2026-05-20'],
          ['Beta Supplies', '33yL6…m1BnP', '1500.00', 'INV-1002', '2026-05-20'],
          ['Gamma Studio', 'PGm4W…oFMW', '750.00', 'INV-1003', '2026-05-21'],
          ['Delta Labs', '9aQrB…IyVbQs', '2200.00', 'INV-1004', '2026-05-22'],
          ['Epsilon Inc', 'Tm7Kq…ZvFuT8', '500.00', 'INV-1005', '2026-05-23'],
          ['Fuyo LLC', 'WqA1x…wE3rT4y', '3250.00', 'INV-1006', '2026-05-24'],
          ['Hex Foundation', 'Hx9Vb…3uIkX', '900.00', 'INV-1007', '2026-05-25'],
        ].map((r, i) => (
          <div key={i} className="lp-rev-row">
            <div style={{ fontSize: 12 }}>{r[0]}</div>
            <div
              className="mono"
              style={{
                fontSize: 11,
                color: 'var(--ax-text-secondary)',
              }}
            >
              {r[1]}
            </div>
            <div className="mono" style={{ fontSize: 11, textAlign: 'right' }}>
              {r[2]}
            </div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--ax-text-secondary)' }}>
              {r[3]}
            </div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--ax-text-secondary)' }}>
              {r[4]}
            </div>
          </div>
        ))}
      </div>
      <div className="lp-mock-actions">
        <span className="lp-nxt-btn lp-nxt-btn-ghost">Back</span>
        <span className="lp-nxt-btn lp-nxt-btn-primary">Confirm import</span>
      </div>
    </div>
  );
}

export function ProofJsonMockup() {
  const isDark =
    typeof document !== 'undefined' &&
    document.documentElement.getAttribute('data-theme') === 'dark';
  const frameBg = isDark ? '#17171B' : '#E7E2D5';
  const digestBg = isDark ? '#2A1F08' : '#E8CF7A';
  const digestBorder = isDark ? '#6B4D12' : '#B68A1C';

  return (
    <div className="lp-proof-frame" style={{ backgroundColor: frameBg }}>
      <div className="lp-proof-topbar">
        <div>
          <div
            className="mono"
            style={{
              fontSize: 10,
              color: 'var(--ax-text-muted)',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
            }}
          >
            payment run proof
          </div>
          <div
            style={{
              fontSize: 15,
              fontWeight: 500,
              color: 'var(--ax-text)',
              marginTop: 3,
              letterSpacing: '-0.01em',
            }}
          >
            payouts — proof packet
          </div>
        </div>
        <span className="lp-proof-download">
          <IconDownload size={12} /> Download JSON
        </span>
      </div>

      <div
        className="lp-proof-digest"
        style={{ backgroundColor: digestBg, borderColor: digestBorder }}
      >
        <span className="lp-proof-digest-label mono">Proof digest · sha-256 canonical</span>
        <span className="lp-proof-digest-value mono">
          6e4f15f3·168546ec·7ea80328·eda76d82
          <br />
          5c6b39ea·8ca2e8f8·70842951·709ebf13
        </span>
      </div>

      <pre className="lp-proof-json mono">
{`{
  "proofId": "decimal_payment_run_proof_6ec01ec8aefb3c71d0b4f892",
  "canonicalDigest": "6e4f15f3168546ec7ea80328eda76d82 \\
                      5c6b39ea8ca2e8f870842951709ebf13",
  "canonicalDigestAlgorithm": "sha256:stable-json-v1",
  "generatedAt": "2026-05-20T14:32:18.901Z",
  "packetType": "stablecoin_payment_run_proof",
  "version": 1,
  "detailLevel": "summary",
  "organizationId": "1d1e901f-ba1b-4d8f-8640-ee3b2e54519c",
  "paymentRunId": "6ec01ec8-aefb-3c71-d0b4-f89234a128fb",
  "runName": "payouts",
  "status": "settled",
  "readiness": {
    "status": "complete",
    "counts": {
      "total": 7,
      "complete": 7,
      "in_progress": 0,
      "needs_review": 0,
      "blocked": 0
    },
    "recommendedAction": "archive_or_share_run_proof"
  },
  "totals": {
    "orderCount": 7,
    "actionableCount": 7,
    "cancelledCount": 0,
    "totalAmountRaw": "10100000000",
    "settledCount": 7,
    "exceptionCount": 0,
    "pendingApprovalCount": 0,
    "approvedCount": 7,
    "readyCount": 0
  },
  "reconciliationSummary": {
    "requestedAmountRaw": "10100000000",
    "matchedAmountRaw": "10100000000",
    "varianceAmountRaw": "0",
    "settlementCounts": {
      "pending": 0, "matched": 7, "partial": 0,
      "exception": 0, "closed": 0, "none": 0
    },
    "openExceptionCount": 0,
    "completedCount": 7,
    "completionRatio": 1,
    "needsReview": false
  },
  "orders": [
    {
      "paymentOrderId": "a1b2c3d4-e5f6-4789-abcd-ef1234567890",
      "paymentRequestId": "11111111-2222-4333-a444-555555555555",
      "transferRequestId": "66666666-7777-4888-a999-aaaaaaaaaaaa",
      "reference": "INV-1001",
      "destination": {
        "label": "Acme Corp",
        "walletAddress": "8cZ65A8ERdVsXq3YnEdMNimwG7DhGe1tPszysJwh43Zx",
        "trustState": "trusted"
      },
      "amountRaw": "1000000000",
      "asset": "usdc",
      "approvals": [
        { "action": "approved", "actor": "hello@gmail.com",
          "at": "2026-05-20T14:28:02.412Z" }
      ],
      "execution": {
        "submittedSignature": "2KzShEABc3QyLg5pR8mW7vK1nTj9bXcZ4FxDhYsV6PiHu",
        "submittedAt": "2026-05-20T14:30:44.115Z"
      },
      "settlement": {
        "state": "matched",
        "matchedAmountRaw": "1000000000",
        "settledAt": "2026-05-20T14:31:03.889Z"
      },
      "proofReady": true
    },
    {
      "paymentOrderId": "b2c3d4e5-f6a7-4901-bcde-f23456789012",
      "reference": "INV-1002",
      "destination": {
        "label": "Beta Supplies",
        "walletAddress": "33yL624hoHqChSDR2y8L2cBjYRGEgQ9QSqcuKFfm1BnP",
        "trustState": "trusted"
      },
      "amountRaw": "1500000000",
      "asset": "usdc",
      "execution": {
        "submittedSignature": "2KzShEABc3QyLg5pR8mW7vK1nTj9bXcZ4FxDhYsV6PiHu",
        "submittedAt": "2026-05-20T14:30:44.115Z"
      },
      "settlement": {
        "state": "matched",
        "matchedAmountRaw": "1500000000",
        "settledAt": "2026-05-20T14:31:03.889Z"
      },
      "proofReady": true
    },
    {
      "paymentOrderId": "c3d4e5f6-a7b8-4012-cdef-345678901234",
      "reference": "INV-1003",
      "destination": {
        "label": "Gamma Studio",
        "walletAddress": "PGm4Wf2xRzK8cNv9LhBdEyTpQj6YmAsCr5nX3uFwoFMW",
        "trustState": "unreviewed"
      },
      "amountRaw": "750000000",
      "asset": "usdc",
      "approvals": [
        { "action": "approved", "actor": "hello@gmail.com",
          "at": "2026-05-20T14:29:11.203Z" }
      ],
      "execution": {
        "submittedSignature": "2KzShEABc3QyLg5pR8mW7vK1nTj9bXcZ4FxDhYsV6PiHu",
        "submittedAt": "2026-05-20T14:30:44.115Z"
      },
      "settlement": {
        "state": "matched",
        "matchedAmountRaw": "750000000",
        "settledAt": "2026-05-20T14:31:03.889Z"
      },
      "proofReady": true
    },
    {
      "paymentOrderId": "d4e5f6a7-b8c9-4123-defa-456789012345",
      "reference": "INV-1004",
      "destination": {
        "label": "Delta Labs",
        "walletAddress": "9aQrB5wT2pKsZxYvNcHdMeJgLiRfO3EhUuXkPoIyVbQs",
        "trustState": "trusted"
      },
      "amountRaw": "2200000000",
      "asset": "usdc",
      "execution": {
        "submittedSignature": "2KzShEABc3QyLg5pR8mW7vK1nTj9bXcZ4FxDhYsV6PiHu",
        "submittedAt": "2026-05-20T14:30:44.115Z"
      },
      "settlement": {
        "state": "matched",
        "matchedAmountRaw": "2200000000",
        "settledAt": "2026-05-20T14:31:03.889Z"
      },
      "proofReady": true
    },
    {
      "paymentOrderId": "e5f6a7b8-c9d0-4234-efab-567890123456",
      "reference": "INV-1005",
      "destination": {
        "label": "Epsilon Inc",
        "walletAddress": "Tm7KqE4rYvWzLp2NcBhDfJgXsOiPaAlR5uMeQoZvFuT8",
        "trustState": "trusted"
      },
      "amountRaw": "500000000",
      "asset": "usdc",
      "execution": {
        "submittedSignature": "2KzShEABc3QyLg5pR8mW7vK1nTj9bXcZ4FxDhYsV6PiHu",
        "submittedAt": "2026-05-20T14:30:44.115Z"
      },
      "settlement": {
        "state": "matched",
        "matchedAmountRaw": "500000000",
        "settledAt": "2026-05-20T14:31:03.889Z"
      },
      "proofReady": true
    },
    {
      "paymentOrderId": "f6a7b8c9-d0e1-4345-fabc-678901234567",
      "reference": "INV-1006",
      "destination": {
        "label": "Fuyo LLC",
        "walletAddress": "WqA1xZ9cP8nM7bV6kH5jG4fD3sE2yU0tY1rQ2wE3rT4y",
        "trustState": "trusted"
      },
      "amountRaw": "3250000000",
      "asset": "usdc",
      "execution": {
        "submittedSignature": "2KzShEABc3QyLg5pR8mW7vK1nTj9bXcZ4FxDhYsV6PiHu",
        "submittedAt": "2026-05-20T14:30:44.115Z"
      },
      "settlement": {
        "state": "matched",
        "matchedAmountRaw": "3250000000",
        "settledAt": "2026-05-20T14:31:03.889Z"
      },
      "proofReady": true
    },
    {
      "paymentOrderId": "a7b8c9d0-e1f2-4456-abcd-789012345678",
      "reference": "INV-1007",
      "destination": {
        "label": "Hex Foundation",
        "walletAddress": "Hx9VbN3mL7pKqR5tY8wZ2cD4fG1hJ6sE0aP9oQ3uIkX",
        "trustState": "unreviewed"
      },
      "amountRaw": "900000000",
      "asset": "usdc",
      "approvals": [
        { "action": "approved", "actor": "hello@gmail.com",
          "at": "2026-05-20T14:29:41.007Z" }
      ],
      "execution": {
        "submittedSignature": "2KzShEABc3QyLg5pR8mW7vK1nTj9bXcZ4FxDhYsV6PiHu",
        "submittedAt": "2026-05-20T14:30:44.115Z"
      },
      "settlement": {
        "state": "matched",
        "matchedAmountRaw": "900000000",
        "settledAt": "2026-05-20T14:31:03.889Z"
      },
      "proofReady": true
    }
  ]
}`}
      </pre>
    </div>
  );
}
