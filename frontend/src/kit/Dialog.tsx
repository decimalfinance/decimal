import { useEffect, useId, useRef, type HTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * The one dialog (4b): 400px (560 with a list or a drop zone), one white
 * surface, the title, a line under it, then the actions at the bottom right.
 * The scrim covers the whole page, sidebar included. Esc and the scrim cancel;
 * Enter confirms. Whatever carries `data-autofocus` takes focus on open,
 * without scrolling the page.
 */
export function Dialog({
  title,
  line,
  children,
  actions,
  wide,
  boxProps,
  onCancel,
  onConfirm,
}: {
  title: ReactNode;
  line?: ReactNode;
  children?: ReactNode;
  actions: ReactNode;
  wide?: boolean;
  /** Handlers on the dialog's surface, such as taking a dropped file anywhere on it. */
  boxProps?: HTMLAttributes<HTMLDivElement>;
  onCancel: () => void;
  /** Enter does this. Leave it out when Enter should do nothing. */
  onConfirm?: () => void;
}) {
  const titleId = useId();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef(onCancel);
  const confirmRef = useRef(onConfirm);
  cancelRef.current = onCancel;
  confirmRef.current = onConfirm;

  useEffect(() => {
    const box = boxRef.current;
    const first = box?.querySelector<HTMLElement>('[data-autofocus]');
    first?.focus({ preventScroll: true });
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelRef.current();
      } else if (e.key === 'Enter' && confirmRef.current) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON')) return;
        e.preventDefault();
        confirmRef.current();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return createPortal(
    <div
      className="ui dlg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        {...boxProps}
        ref={boxRef}
        className={`dlg${wide ? ' is-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-dlg
      >
        <div id={titleId} className="dlg-title">{title}</div>
        {line ? <div className="dlg-line">{line}</div> : null}
        {children ? <div className="dlg-body">{children}</div> : null}
        <div className="dlg-actions">{actions}</div>
      </div>
    </div>,
    document.body,
  );
}

/** Asking first, before anything that can't be undone or is easy to hit by mistake. */
export function ConfirmDialog({
  title,
  line,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'primary',
  busy,
  onConfirm,
  onCancel,
}: {
  title: ReactNode;
  line?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** `remove` is the red tint, for anything that takes something away. */
  tone?: 'primary' | 'remove';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      title={title}
      line={line}
      onCancel={onCancel}
      onConfirm={busy ? undefined : onConfirm}
      actions={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${tone === 'remove' ? 'is-remove' : 'is-primary'}`}
            onClick={onConfirm}
            disabled={busy}
            data-autofocus
          >
            {confirmLabel}
          </button>
        </>
      }
    />
  );
}
