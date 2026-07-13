import React from 'react';
import { OriginPill } from 'decimal-frontend';

export const Origins = () => (
  <div className="dec" style={{ padding: 20, background: '#fff', display: 'flex', gap: 8, alignItems: 'center' }}>
    <OriginPill>Single</OriginPill>
    <OriginPill>Apr cloud</OriginPill>
    <OriginPill>CSV batch</OriginPill>
  </div>
);
