import React from 'react';
import { Ico } from 'decimal-frontend';

const names = ['grid','payments','treasury','members','address','proposals','shield','search','check','plus','upload','download','doc','bolt','inbox','link','book','vault','users','key'] as const;

export const IconSet = () => (
  <div className="dec" style={{ padding: 20, background: '#fff', display: 'grid', gridTemplateColumns: 'repeat(5, 110px)', gap: 14 }}>
    {names.map((n) => {
      const C = (Ico as Record<string, any>)[n];
      return C ? (
        <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#0A0A0A', fontFamily: 'ui-sans-serif, system-ui', fontSize: 12 }}>
          <C w={16} /> {n}
        </div>
      ) : null;
    })}
  </div>
);
