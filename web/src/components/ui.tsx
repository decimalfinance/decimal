export function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <small>{label}</small>
    </div>
  );
}

export function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-line">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function GridBackdrop() {
  return <div className="grid-backdrop" aria-hidden="true" />;
}

export function CenteredState({ body, title }: { body: string; title: string }) {
  return (
    <div className="centered-state">
      <p className="eyebrow">USDC//OPS</p>
      <h1>{title}</h1>
      <p>{body}</p>
    </div>
  );
}
