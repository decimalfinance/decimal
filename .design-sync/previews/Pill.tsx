import React from 'react';
import { Pill } from 'decimal-frontend';

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div className="dec" style={{ padding: 20, background: '#fff', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>{children}</div>
);

export const Tones = () => (
  <Frame>
    <Pill tone="success">Settled</Pill>
    <Pill tone="warning">Needs review</Pill>
    <Pill tone="danger">Exception</Pill>
    <Pill tone="info">Signing</Pill>
    <Pill tone="neutral">Draft</Pill>
  </Frame>
);

export const PaymentStatuses = () => (
  <Frame>
    <Pill status="Received" />
    <Pill status="Reviewed" />
    <Pill status="Signing" />
    <Pill status="Settled" />
    <Pill status="Exception" />
  </Frame>
);

export const DarkTheme = () => (
  <div className="dec" data-theme="dark" style={{ padding: 20, background: '#0e0d0c', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
    <Pill tone="success">Settled</Pill>
    <Pill tone="warning">Needs review</Pill>
    <Pill tone="danger">Exception</Pill>
    <Pill tone="info">Signing</Pill>
    <Pill tone="neutral">Draft</Pill>
  </div>
);
