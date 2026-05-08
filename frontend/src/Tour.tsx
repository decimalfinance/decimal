import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type TourStep = {
  key: string;
  title: string;
  body: string;
};

const DEFAULT_STEPS: TourStep[] = [
  {
    key: 'overview',
    title: 'Overview',
    body:
      'Your command center. Treasury balance, recent payments and collections, and what’s pending approval — all in one view.',
  },
  {
    key: 'payments',
    title: 'Payments',
    body:
      'Outbound USDC. Pay one recipient or a CSV batch. Policy routes approval, you sign, Decimal matches it on-chain.',
  },
  {
    key: 'collections',
    title: 'Collections',
    body:
      'Inbound USDC. Tell Decimal a payment is expected from a counterparty; when it lands on-chain we match it and emit a proof.',
  },
  {
    key: 'wallets',
    title: 'Wallets',
    body:
      'The Solana wallets you control. Source of outbound payments, destination for inbound collections.',
  },
  {
    key: 'counterparties',
    title: 'Counterparties',
    body:
      'The businesses you transact with. Each counterparty can have many destination and payer wallets grouped under it.',
  },
  {
    key: 'destinations',
    title: 'Destinations',
    body:
      'Outbound wallets — who you pay. Trust levels drive whether a payment auto-approves or needs review.',
  },
  {
    key: 'payers',
    title: 'Payers',
    body:
      'Inbound wallets — who pays you. New payers are auto-created as unreviewed on first match; promote to trusted once verified.',
  },
];

const TOUR_DISMISSED_PREFIX = 'decimal.tour.v1.dismissed';

type TourContextValue = {
  isOpen: boolean;
  stepIndex: number;
  steps: TourStep[];
  isDismissed: boolean;
  start: () => void;
  next: () => void;
  back: () => void;
  skip: () => void;
  finish: () => void;
};

const TourContext = createContext<TourContextValue | null>(null);

export function useTour(): TourContextValue {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error('useTour must be used inside <TourProvider>');
  return ctx;
}

function storageKey(userId?: string | null): string {
  return userId ? `${TOUR_DISMISSED_PREFIX}:${userId}` : TOUR_DISMISSED_PREFIX;
}

function readDismissed(userId?: string | null): boolean {
  try {
    return Boolean(window.localStorage.getItem(storageKey(userId)));
  } catch {
    return false;
  }
}

function writeDismissed(userId?: string | null) {
  try {
    window.localStorage.setItem(storageKey(userId), '1');
  } catch {
    // ignore
  }
}

export function TourProvider({
  children,
  steps = DEFAULT_STEPS,
  userId,
}: {
  children: ReactNode;
  steps?: TourStep[];
  userId?: string | null;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [isDismissed, setIsDismissed] = useState<boolean>(() => readDismissed(userId));

  // Re-read dismissal when the active user changes (e.g. after logout/login).
  useEffect(() => {
    setIsDismissed(readDismissed(userId));
    setIsOpen(false);
  }, [userId]);

  const start = useCallback(() => {
    setStepIndex(0);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    writeDismissed(userId);
    setIsDismissed(true);
    setIsOpen(false);
  }, [userId]);

  const next = useCallback(() => {
    setStepIndex((idx) => {
      if (idx >= steps.length - 1) {
        close();
        return idx;
      }
      return idx + 1;
    });
  }, [steps.length, close]);

  const back = useCallback(() => {
    setStepIndex((idx) => Math.max(0, idx - 1));
  }, []);

  const value = useMemo<TourContextValue>(
    () => ({
      isOpen,
      stepIndex,
      steps,
      isDismissed,
      start,
      next,
      back,
      skip: close,
      finish: close,
    }),
    [isOpen, stepIndex, steps, isDismissed, start, next, back, close],
  );

  // Escape key dismisses
  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, close]);

  return (
    <TourContext.Provider value={value}>
      {children}
      {isOpen ? <TourOverlay /> : null}
    </TourContext.Provider>
  );
}

function TourOverlay() {
  const { steps, stepIndex, next, back, skip } = useTour();
  const step = steps[stepIndex];
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [sidebarRight, setSidebarRight] = useState<number>(260);

  useLayoutEffect(() => {
    function update() {
      const target = document.querySelector(`[data-tour-key="${step.key}"]`);
      setTargetRect(target ? target.getBoundingClientRect() : null);
      const sb = document.querySelector('.ax-sidebar');
      if (sb) setSidebarRight(sb.getBoundingClientRect().right);
    }
    update();
    const ro = new ResizeObserver(update);
    const sb = document.querySelector('.ax-sidebar');
    if (sb) ro.observe(sb);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [step.key]);

  const isFirst = stepIndex === 0;
  const isLast = stepIndex === steps.length - 1;

  const tooltipTop = targetRect ? Math.max(16, targetRect.top) : 80;
  const tooltipLeft = sidebarRight + 20;

  return (
    <div className="tour-root" role="presentation">
      <div
        className="tour-backdrop"
        style={{ left: sidebarRight }}
        aria-hidden
      />
      {targetRect ? (
        <div
          className="tour-highlight"
          style={{
            top: targetRect.top - 4,
            left: targetRect.left - 4,
            width: targetRect.width + 8,
            height: targetRect.height + 8,
          }}
          aria-hidden
        />
      ) : null}
      <div
        className="tour-tooltip"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        style={{ top: tooltipTop, left: tooltipLeft }}
      >
        <div className="tour-step-count">
          Step {stepIndex + 1} of {steps.length}
        </div>
        <h3 id="tour-title" className="tour-title">
          {step.title}
        </h3>
        <p className="tour-body">{step.body}</p>
        <div className="tour-actions">
          <button type="button" className="tour-skip" onClick={skip}>
            Skip tour
          </button>
          <div className="tour-actions-right">
            {!isFirst ? (
              <button type="button" className="tour-back" onClick={back}>
                Back
              </button>
            ) : null}
            <button type="button" className="tour-next" onClick={next}>
              {isLast ? 'Finish' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
