import type { DecimalProposal } from '../types';
import { readSettlementVerificationStatus } from '../lib/settlement';

// Renders a yellow "verification pending" or red "settlement mismatch" banner
// once a payment proposal has been executed on-chain. Hidden for non-payment
// proposals, for proposals that haven't been executed yet, and for proposals
// already verified as settled. Returns null in those cases so the caller can
// drop it in unconditionally.
export function SettlementBanner({ proposal }: { proposal: DecimalProposal | null | undefined }) {
  if (!proposal) return null;
  const isPayment = proposal.semanticType === 'send_payment' || proposal.semanticType === 'send_payment_run';
  if (!isPayment) return null;
  if (!proposal.executedSignature) return null;
  const status = readSettlementVerificationStatus(proposal);
  if (status === 'settled' || status === 'not_applicable' || status === null) return null;

  if (status === 'pending') {
    return (
      <section
        className="rd-section settlement-banner settlement-banner-pending"
        style={{
          marginTop: 16,
          padding: 14,
          border: '1px solid rgba(220, 180, 80, 0.45)',
          background: 'rgba(220, 180, 80, 0.08)',
          borderRadius: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <span
          aria-hidden
          style={{
            display: 'inline-block',
            width: 10,
            height: 10,
            borderRadius: 999,
            background: 'rgb(220, 180, 80)',
          }}
        />
        <div>
          <strong style={{ fontSize: 13 }}>Settlement verification pending</strong>
          <div style={{ fontSize: 12, color: 'var(--ax-text-muted)', marginTop: 4 }}>
            On-chain execution landed but RPC hasn't returned the parsed transaction yet. Verifying USDC deltas will retry automatically.
          </div>
        </div>
      </section>
    );
  }

  // status === 'mismatch'
  return (
    <section
      className="rd-section settlement-banner settlement-banner-mismatch"
      style={{
        marginTop: 16,
        padding: 14,
        border: '1px solid rgba(220, 80, 80, 0.45)',
        background: 'rgba(220, 80, 80, 0.08)',
        borderRadius: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-block',
          width: 10,
          height: 10,
          borderRadius: 999,
          background: 'rgb(240, 90, 90)',
        }}
      />
      <div>
        <strong style={{ fontSize: 13 }}>Settlement deltas did not match</strong>
        <div style={{ fontSize: 12, color: 'var(--ax-text-muted)', marginTop: 4 }}>
          The execution transaction landed but the observed USDC transfers don't match what this proposal expected. Investigate before treating these payments as settled.
        </div>
      </div>
    </section>
  );
}
