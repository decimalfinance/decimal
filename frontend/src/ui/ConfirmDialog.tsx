/**
 * A last look before an act that commits you.
 *
 * Two places need it and both are the same shape: sending a bill for approval,
 * and approving one. Neither is undoable in the way a person expects — a
 * confirmed bill goes to real colleagues' queues, and an approval is a recorded
 * consent with your name on it. A click that reaches either from a single
 * mouse-down is a click too cheap for what it does.
 *
 * Deliberately plain: a title, one sentence saying what happens next, and the
 * action named on its own button rather than "OK". Nobody should have to
 * reconstruct what they are agreeing to from the heading.
 */
type Props = {
  title: string;
  body: string;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  tone?: 'primary' | 'danger';
  onConfirm: () => void;
  onClose: () => void;
  /**
   * A third answer, for when leaving without doing it is itself a choice rather
   * than a cancellation. "Save and leave / Discard and leave / Cancel" needs
   * all three: Cancel keeps you on the page, Discard takes you off it, and
   * collapsing them would make one of those unreachable.
   */
  secondaryLabel?: string;
  onSecondary?: () => void;
};

export function ConfirmDialog({ title, body, confirmLabel, busyLabel, busy, tone, onConfirm, onClose, secondaryLabel, onSecondary }: Props) {
  return (
    <div
      className="overlay"
      style={{ position: 'fixed', inset: 0, zIndex: 70 }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div className="dialog" role="dialog" aria-modal="true" style={{ maxWidth: 420 }}>
        <div className="dialog-head">
          <div>
            <h2>{title}</h2>
            <p>{body}</p>
          </div>
          <button type="button" className="drawer-x" onClick={onClose} disabled={busy} aria-label="Close">×</button>
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          {secondaryLabel && onSecondary ? (
            <button type="button" className="btn btn-ghost" onClick={onSecondary} disabled={busy}>
              {secondaryLabel}
            </button>
          ) : null}
          <button
            type="button"
            className={`btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? (busyLabel ?? 'Working…') : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
