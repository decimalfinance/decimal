import React from 'react';
import { PaymentTracker } from 'decimal-frontend';

// Payment tracker: progress rail, record sheet with FX line, timeline.
export const Screen = () => (
  <div className="dec" style={{ background: 'var(--bg-surface-2)', padding: 24 }}>
    <PaymentTracker />
  </div>
);
