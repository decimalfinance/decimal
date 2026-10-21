// A row of a table laid out on a subgrid whose even tracks are gaps: each
// cell after the first gets an empty gap cell before it.
import { Fragment, type ReactNode } from 'react';

export function Cells({ children }: { children: ReactNode[] }) {
  return (
    <>
      {children.map((cell, i) => (
        <Fragment key={i}>
          {i > 0 ? <span aria-hidden /> : null}
          {cell}
        </Fragment>
      ))}
    </>
  );
}
