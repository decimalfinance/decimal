export type StageState = 'complete' | 'current' | 'pending' | 'blocked';

export type LifecycleStage = {
  // The id is only used as a React key — pages can keep narrower string-
  // literal unions internally if they want type safety, but the rail
  // accepts any string.
  id: string;
  label: string;
  sub: string;
  state: StageState;
};

// Renders a horizontal lifecycle rail of stage dots + labels. Used on
// payment, payment-run, and collection detail pages — same shape, same
// styling. The aria-label is configurable so screen readers can identify
// which lifecycle is being rendered.
export function LifecycleRail({
  stages,
  ariaLabel = 'Lifecycle',
}: {
  stages: LifecycleStage[];
  ariaLabel?: string;
}) {
  return (
    <div
      className="rd-rail"
      role="list"
      aria-label={ariaLabel}
      style={{ gridTemplateColumns: `repeat(${stages.length}, 1fr)` }}
    >
      {stages.map((stage) => (
        <div key={stage.id} className="rd-rail-step" data-state={stage.state} role="listitem">
          <div className="rd-rail-marker-row">
            <span className="rd-rail-dot" aria-hidden />
            <span className="rd-rail-line" aria-hidden />
          </div>
          <span className="rd-rail-label">{stage.label}</span>
          <span className="rd-rail-sub">{stage.sub}</span>
        </div>
      ))}
    </div>
  );
}
