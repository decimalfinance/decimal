// Collections — coming soon. Per the design handoff, this lives as a
// single placeholder until the receivable side of the product ships.
// The previous functional implementation (single + run intake, CSV
// preview, status pills) is preserved in git history; bring it back
// when collections becomes a wedge.

import type { AuthenticatedSession } from '../types';
import { PageHead } from '../dec/primitives';
import { Ico } from '../dec/icons';

export function CollectionsPage({ session: _session }: { session: AuthenticatedSession }) {
  return (
    <div className="page">
      <div className="stack stack-24">
        <PageHead
          eyebrow="OPERATIONS"
          title="Collections"
          desc="Invoice your customers and get paid — settling to your treasury the same day."
        />
        <div className="tbl-card">
          <div className="coming">
            <div className="cm-icon"><Ico.collections w={28} /></div>
            <div className="cm-tag">Coming soon</div>
            <h2>Get paid, not just pay</h2>
            <p>
              Collections brings the other half of the ledger into Decimal — send invoices to your
              customers and watch funds settle straight into your treasury. We're building it now.
            </p>
            <div className="cm-note">
              <Ico.bolt w={14} fill="currentColor" sw={0} />
              We'll let you know the moment it's ready.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

