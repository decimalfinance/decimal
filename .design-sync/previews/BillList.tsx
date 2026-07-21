import React from 'react';
import { BillList } from 'decimal-frontend';

// Full Bills workbench screen. Wrap in .dec so the vocabulary is styled.
export const Screen = () => (
  <div className="dec" style={{ background: 'var(--bg-surface-2)' }}>
    <BillList />
  </div>
);
