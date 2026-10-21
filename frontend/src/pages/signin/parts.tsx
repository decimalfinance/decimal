// What every sign-in screen is built from (designs 4c and turn 7): the frame
// with the art, then the column's title, lines, fields, the one action and
// the links.
import { useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode, type Ref } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../api';
import { Orb } from '../../kit/Orb';
import { orgInitials } from '../../kit/people';

export function Frame({ children }: { children?: ReactNode }) {
  return (
    <div className="ui si-page">
      <div className="si-art" aria-hidden="true">
        <Orb size={200} state="work" bg="page" />
        <span className="si-name">Decimal</span>
      </div>
      <main className="si-col">
        <div className="si-form">{children}</div>
      </main>
    </div>
  );
}

export function Title({ children }: { children: ReactNode }) {
  return <h1 className="si-title">{children}</h1>;
}

export function Body({ children }: { children: ReactNode }) {
  return <p className="si-body">{children}</p>;
}

/** An address or a name inside a line, in ink. */
export function Ink({ children }: { children: ReactNode }) {
  return <span className="si-ink">{children}</span>;
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="si-note">{children}</p>;
}

type FieldProps = {
  id: string;
  label: string;
  error?: string | null;
  ref?: Ref<HTMLInputElement>;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'className'>;

/** A label in caps over a pill, and what's wrong with it under it. */
export function Field({ id, label, error, ref, ...input }: FieldProps) {
  const errorId = `${id}-error`;
  return (
    <div className="si-field">
      <label className="si-label" htmlFor={id}>{label}</label>
      <input
        ref={ref}
        id={id}
        className={`si-input${error ? ' is-error' : ''}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        {...input}
      />
      {error ? <span id={errorId} className="si-error" role="alert">{error}</span> : null}
    </div>
  );
}

/** The address an invitation was sent to: shown, not typed. */
export function FixedEmail({ email, error }: { email: string; error?: string | null }) {
  return (
    <div className="si-field">
      <span className="si-label">EMAIL</span>
      <div className="si-fixed" title={email}>{email}</div>
      {error ? <span className="si-error" role="alert">{error}</span> : null}
    </div>
  );
}

/** The one thing to do. While it works, it says so and can't be pressed twice. */
export function Pill({
  busy = false,
  busyLabel,
  far = false,
  type = 'submit',
  onClick,
  children,
}: {
  busy?: boolean;
  busyLabel?: string;
  /** Straight under a line of text rather than under a field. */
  far?: boolean;
  type?: 'submit' | 'button';
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type={type}
      className={`si-pill${far ? ' is-far' : ''}`}
      aria-busy={busy || undefined}
      disabled={busy}
      onClick={onClick}
    >
      {busy && busyLabel ? busyLabel : children}
    </button>
  );
}

export function TextLink({ to, children }: { to: string; children: ReactNode }) {
  return <Link className="si-link" to={to}>{children}</Link>;
}

export function LinkButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" className="si-link" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

/** A row of links: centred, or one at each end. */
export function Links({ pair = false, children }: { pair?: boolean; children: ReactNode }) {
  return <div className={`si-links${pair ? ' is-pair' : ''}`}>{children}</div>;
}

export function OrgMark({ name, tone, large = false }: { name: string; tone: string; large?: boolean }) {
  return (
    <span className={`org-mark${large ? ' is-lg' : ''}`} style={{ background: tone }} aria-hidden="true">
      {orgInitials(name)}
    </span>
  );
}

/** Whether "Continue with Google" works on this deployment. */
function useGoogleSignIn() {
  const capabilities = useQuery({
    queryKey: ['capabilities'] as const,
    queryFn: () => api.getCapabilities(),
    staleTime: 60_000,
  });
  return Boolean(capabilities.data?.auth?.googleSignIn);
}

/** Continue with Google, then OR. Neither shows where Google isn't set up. */
export function GoogleRow({ returnTo }: { returnTo: string | null }) {
  const enabled = useGoogleSignIn();
  const [going, setGoing] = useState(false);
  if (!enabled) return null;
  return (
    <>
      <button
        type="button"
        className="si-google"
        aria-busy={going || undefined}
        onClick={() => {
          setGoing(true);
          window.location.assign(api.getGoogleOAuthStartUrl(returnTo ?? '/setup'));
        }}
      >
        <GoogleMark />
        {going ? 'Opening Google…' : 'Continue with Google'}
      </button>
      <div className="si-or"><span>OR</span></div>
    </>
  );
}

/** Google's own mark, in its own colours, never altered. */
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/** The capsule's arrow. */
export function Chevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

/** Focuses a field once the screen opens, without scrolling to it. */
export function useFocusOnOpen<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return ref;
}

/** A failure in words for the screen: never a raw server error. */
export function failureText(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === 'network') return 'Can’t reach Decimal. Check your connection and try again.';
    if (error.status === 429) return 'Too many tries. Wait a minute, then try again.';
    if (error.status >= 500) return 'Something went wrong on our side. Try again in a moment.';
  }
  return 'That didn’t work. Try again in a moment.';
}
