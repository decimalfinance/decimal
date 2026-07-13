import React from 'react';
import { PageHead } from 'decimal-frontend';

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div className="dec" style={{ padding: 24, background: '#fff', minWidth: 640 }}>{children}</div>
);

export const Standard = () => (
  <Frame>
    <PageHead title="Payments" desc="Every bill in one place — from capture to settled." />
  </Frame>
);

export const WithEyebrowAndAction = () => (
  <Frame>
    <PageHead
      eyebrow="Governance"
      title="Approvals"
      desc="Bills waiting on your sign-off, and how approvals work in this organization."
      actions={<button className="btn btn-primary">New payment</button>}
    />
  </Frame>
);
