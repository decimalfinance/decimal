import React from 'react';
import { SLPill, Pill } from 'decimal-frontend';

export const NextToAStatus = () => (
  <div className="dec" style={{ padding: 20, background: '#fff', display: 'flex', gap: 8, alignItems: 'center' }}>
    <Pill tone="success">Settled</Pill>
    <SLPill />
  </div>
);
