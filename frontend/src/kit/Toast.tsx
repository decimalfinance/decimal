import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * The dark toast: what just happened, in one line, with Undo when it can be
 * taken back. Five seconds, one at a time, at the bottom of the page area.
 * `wide` is for the odd sentence that needs two lines; it stays eight.
 */
type ToastOptions = { undo?: () => void; wide?: boolean };
type Toast = { id: number; text: ReactNode } & ToastOptions;
type Toaster = { show: (text: ReactNode, options?: ToastOptions) => void };

const ToasterContext = createContext<{ toaster: Toaster; current: Toast | null; dismiss: () => void } | null>(null);

export function ToasterProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<Toast | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const seq = useRef(0);

  const dismiss = useCallback(() => {
    window.clearTimeout(timer.current);
    setCurrent(null);
  }, []);

  const toaster = useMemo<Toaster>(
    () => ({
      show(text, options) {
        window.clearTimeout(timer.current);
        seq.current += 1;
        setCurrent({ id: seq.current, text, undo: options?.undo, wide: options?.wide });
        timer.current = window.setTimeout(() => setCurrent(null), options?.wide ? 8000 : 5000);
      },
    }),
    [],
  );

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const value = useMemo(() => ({ toaster, current, dismiss }), [toaster, current, dismiss]);
  return <ToasterContext.Provider value={value}>{children}</ToasterContext.Provider>;
}

export function useToaster(): Toaster {
  const ctx = useContext(ToasterContext);
  if (!ctx) throw new Error('useToaster needs a ToasterProvider');
  return ctx.toaster;
}

/** Where the toast shows: inside the page area, so it centres on the page. */
export function ToastHost() {
  const ctx = useContext(ToasterContext);
  const toast = ctx?.current;
  if (!toast) return null;
  return (
    <div key={toast.id} className={`ui toast${toast.wide ? ' is-wide' : ''}`} role="status" aria-live="polite">
      <span>{toast.text}</span>
      {toast.undo ? (
        <button
          type="button"
          className="toast-undo"
          onClick={() => {
            const undo = toast.undo;
            ctx.dismiss();
            undo?.();
          }}
        >
          Undo
        </button>
      ) : null}
    </div>
  );
}
