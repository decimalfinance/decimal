// Auth pages — implements the design (pages-auth.jsx): two-column .auth
// grid with a pink BrandPanel on the left and a form column on the right.
// Each page wraps its surface in <div className="dec"> so the design CSS
// activates (the auth pages live outside the AppShell's .dec wrapper).

import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type AuthenticatedSession } from '../api';
import { queryKeys, toAuthenticatedSession } from '../lib/app-helpers';
import { Ico } from '../dec/icons';

function readSafeReturnTo(search: string): string | null {
  const params = new URLSearchParams(search);
  const raw = params.get('returnTo');
  if (!raw) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  return raw;
}

function authErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === 'invalid_credentials') return 'Invalid email or password.';
    if (err.code === 'conflict') return 'An account with this email already exists.';
    if (err.code === 'validation_error') return err.message || 'Please check the form and try again.';
    return err.message || fallback;
  }
  return err instanceof Error ? err.message : fallback;
}

// Pink brand panel on the left of every auth screen. Tagline switches per
// screen so the messaging matches the action ("Pay vendors globally" for
// login, "Create an account..." for signup, "You've been invited..." for
// the join screen). Exported so InviteAccept reuses it.
export function BrandPanel({ tagline }: { tagline: string }) {
  return (
    <div className="auth-brand">
      <div className="ab-word">
        <span className="ab-glyph">D</span>
        Decimal
      </div>
      <div className="ab-mid">
        <h2>Finance &amp; accounting, run by an agent you control.</h2>
        <p className="ab-tag">{tagline}</p>
      </div>
      <div className="ab-feats">
        <div className="ab-feat">
          <span className="af-ic"><Ico.bolt w={14} fill="currentColor" sw={0} /></span>
          Auto-pay routine bills your team approved — no vote each time
        </div>
        <div className="ab-feat">
          <span className="af-ic"><Ico.shield w={14} /></span>
          Multi-signer approvals for everything above your limits
        </div>
        <div className="ab-feat">
          <span className="af-ic"><Ico.doc w={14} /></span>
          A downloadable proof packet for every payment
        </div>
      </div>
    </div>
  );
}

function GoogleButton({ mode, returnTo }: { mode: 'login' | 'register'; returnTo?: string | null }) {
  const [redirecting, setRedirecting] = useState(false);
  return (
    <button
      type="button"
      className="btn-google"
      disabled={redirecting}
      onClick={() => {
        setRedirecting(true);
        window.location.assign(api.getGoogleOAuthStartUrl(returnTo ?? '/setup'));
      }}
    >
      <Ico.google w={18} />
      {redirecting
        ? 'Opening Google…'
        : mode === 'login'
          ? 'Continue with Google'
          : 'Sign up with Google'}
    </button>
  );
}

// Wrapper for any auth screen — provides the .dec namespace + viewport
// height + the two-column split (.auth).
export function AuthLayout({ tagline, children }: { tagline: string; children: React.ReactNode }) {
  return (
    <div className="dec" style={{ height: '100vh' }}>
      <div className="auth">
        <BrandPanel tagline={tagline} />
        <div className="auth-form">
          <div className="auth-card">{children}</div>
        </div>
      </div>
    </div>
  );
}

// ─── OAuth callback ─────────────────────────────────────────────────────
// Lands here after Google redirect. Reads the session_token from the URL
// fragment, primes the session query, and redirects to /setup (or the
// original returnTo). On error we render a minimal screen inside the
// AuthLayout so it doesn't look like a broken page.

export function OAuthCallbackPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const token = fragment.get('session_token');
    const returnTo = fragment.get('return_to') || '/setup';
    const oauthError = fragment.get('error');
    window.history.replaceState(null, document.title, '/oauth/callback');

    if (oauthError) {
      setError(`Google sign-in failed: ${oauthError}`);
      return;
    }
    if (!token) {
      setError('Google sign-in did not return a session.');
      return;
    }

    api.setSessionToken(token);
    void queryClient
      .fetchQuery({ queryKey: queryKeys().session, queryFn: () => api.getSession() })
      .then((session) => {
        const firstOrganizationId = session.organizations[0]?.organizationId;
        const safeReturnTo = returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/setup';
        navigate(firstOrganizationId && safeReturnTo === '/setup' ? `/organizations/${firstOrganizationId}` : safeReturnTo, {
          replace: true,
        });
      })
      .catch((err) => {
        api.clearSessionToken();
        setError(err instanceof Error ? err.message : 'Unable to finish Google sign-in.');
      });
  }, [navigate, queryClient]);

  return (
    <AuthLayout tagline="Hang tight — we're loading your workspace.">
      <h1>{error ? 'Sign-in failed' : 'Finishing sign-in'}</h1>
      <p className="auth-sub">
        {error ?? 'Creating your Decimal session and loading your organizations.'}
      </p>
      {error ? (
        <a className="btn btn-primary" href="/login" style={{ width: '100%', height: 46, marginTop: 14 }}>
          Back to log in
        </a>
      ) : null}
    </AuthLayout>
  );
}

// ─── Log in ─────────────────────────────────────────────────────────────

export function LoginPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = readSafeReturnTo(location.search);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const loginMutation = useMutation({
    mutationFn: (input: { email: string; password: string }) => {
      // Always start login from a clean auth state so stale tokens cannot win.
      void queryClient.cancelQueries({ queryKey: queryKeys().session });
      queryClient.removeQueries({ queryKey: queryKeys().session });
      api.clearSessionToken();
      return api.login(input);
    },
    onSuccess: async (result) => {
      api.setSessionToken(result.sessionToken);
      queryClient.setQueryData(queryKeys().session, toAuthenticatedSession(result));
      if (!result.user.emailVerifiedAt) {
        navigate(returnTo ? `/verify-email?returnTo=${encodeURIComponent(returnTo)}` : '/verify-email', { replace: true });
        return;
      }
      if (returnTo) {
        navigate(returnTo, { replace: true });
        return;
      }
      const firstOrganizationId = result.organizations[0]?.organizationId;
      navigate(firstOrganizationId ? `/organizations/${firstOrganizationId}` : '/setup', { replace: true });
    },
    onError: (nextError) => {
      setError(authErrorMessage(nextError, 'Unable to sign in.'));
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedEmail = email.trim();
    if (!normalizedEmail) {
      setError('Email is required.');
      return;
    }
    if (!password) {
      setError('Password is required.');
      return;
    }
    setError(null);
    loginMutation.mutate({ email: normalizedEmail, password });
  }

  return (
    <AuthLayout tagline="Pay vendors globally, set bounded autonomy for routine bills, and keep every approval on your team's keys.">
      <h1>Log in to Decimal</h1>
      <p className="auth-sub">Welcome back. Use your work account to continue.</p>

      <GoogleButton mode="login" returnTo={returnTo} />
      <div className="auth-divider">or</div>

      <form className="stack-field" onSubmit={handleSubmit}>
        <div className="field">
          <label className="field-label">Work email</label>
          <input
            className="input"
            type="email"
            name="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            autoComplete="email"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            inputMode="email"
            required
          />
        </div>
        <div className="field">
          <div className="field-label-row">
            <label className="field-label">Password</label>
            <span className="field-link">Forgot password?</span>
          </div>
          <input
            className="input"
            type="password"
            name="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>

        {error ? (
          <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div>
        ) : null}

        <button
          type="submit"
          className="btn btn-primary"
          disabled={loginMutation.isPending}
          aria-busy={loginMutation.isPending}
        >
          {loginMutation.isPending ? 'Logging in…' : <>Log in<Ico.arrowRight w={15} /></>}
        </button>
      </form>

      <p className="auth-switch">
        New to Decimal? <a href="/register">Create an account</a>
      </p>
    </AuthLayout>
  );
}

// ─── Sign up (public — creates a new account, which then creates an org) ──

export function RegisterPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = readSafeReturnTo(location.search);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');

  const registerMutation = useMutation({
    mutationFn: (input: { email: string; password: string; displayName?: string }) => {
      void queryClient.cancelQueries({ queryKey: queryKeys().session });
      queryClient.removeQueries({ queryKey: queryKeys().session });
      api.clearSessionToken();
      return api.register(input);
    },
    onSuccess: (result) => {
      api.setSessionToken(result.sessionToken);
      queryClient.setQueryData(queryKeys().session, toAuthenticatedSession(result));
      navigate(returnTo ? `/verify-email?returnTo=${encodeURIComponent(returnTo)}` : '/verify-email', { replace: true });
    },
    onError: (nextError) => {
      setError(authErrorMessage(nextError, 'Unable to create account.'));
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedEmail = email.trim();
    const trimmedDisplayName = displayName.trim();
    if (!normalizedEmail) {
      setError('Email is required.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password.length > 128) {
      setError('Password must be 128 characters or fewer.');
      return;
    }
    setError(null);
    registerMutation.mutate({
      email: normalizedEmail,
      password,
      displayName: trimmedDisplayName ? trimmedDisplayName : undefined,
    });
  }

  return (
    <AuthLayout tagline="Create an account to set up your organization, connect a treasury, and let the agent start paying vendors.">
      <h1>Create your account</h1>
      <p className="auth-sub">Start running finance with Decimal in minutes.</p>

      <GoogleButton mode="register" returnTo={returnTo} />
      <div className="auth-divider">or</div>

      <form className="stack-field" onSubmit={handleSubmit}>
        <div className="field">
          <label className="field-label">Full name</label>
          <input
            className="input"
            type="text"
            name="displayName"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Jordan Keil"
            autoComplete="name"
          />
        </div>
        <div className="field">
          <label className="field-label">Work email</label>
          <input
            className="input"
            type="email"
            name="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            autoComplete="email"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            inputMode="email"
            required
          />
        </div>
        <div className="field">
          <label className="field-label">Password</label>
          <input
            className="input"
            type="password"
            name="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            maxLength={128}
            required
          />
          <span className="input-help">At least 8 characters.</span>
        </div>

        {error ? (
          <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div>
        ) : null}

        <button
          type="submit"
          className="btn btn-primary"
          disabled={registerMutation.isPending}
          aria-busy={registerMutation.isPending}
        >
          {registerMutation.isPending ? 'Creating…' : <>Create account<Ico.arrowRight w={15} /></>}
        </button>
      </form>

      <p className="auth-switch">
        Already have an account? <a href="/login">Log in</a>
      </p>
    </AuthLayout>
  );
}

// ─── Verify email ───────────────────────────────────────────────────────
// Lands here after register or after login with an unverified email.

export function VerifyEmailPage({ session }: { session: AuthenticatedSession }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = readSafeReturnTo(location.search);
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const verifyMutation = useMutation({
    mutationFn: () => api.verifyEmail({ code: code.trim() }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys().session });
      if (returnTo) {
        navigate(returnTo, { replace: true });
        return;
      }
      navigate(
        session.organizations[0] ? `/organizations/${session.organizations[0].organizationId}` : '/setup',
        { replace: true },
      );
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Unable to verify email.'),
  });

  const resendMutation = useMutation({
    mutationFn: () => api.resendVerification(),
    onSuccess: (result) => {
      setDevCode(result.devEmailVerificationCode ?? null);
      if (result.emailDelivered) {
        setStatusMessage(`Code sent to ${session.user.email}. Check your inbox.`);
      } else if (result.devEmailVerificationCode) {
        setStatusMessage(null);
      } else {
        setStatusMessage('Could not send the email. Try again in a moment.');
      }
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Unable to send verification code.'),
  });

  return (
    <AuthLayout tagline="One quick step before we hand you the keys to your workspace.">
      <h1>Confirm your account</h1>
      <p className="auth-sub">
        Enter the verification code we sent to <b style={{ color: 'var(--text-primary)' }}>{session.user.email}</b>.
      </p>

      <form
        className="stack-field"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          verifyMutation.mutate();
        }}
      >
        <div className="field">
          <label className="field-label">Verification code</label>
          <input
            className="input"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
          />
        </div>

        {error ? <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div> : null}
        {statusMessage ? <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{statusMessage}</div> : null}
        {devCode ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Dev code (no email provider configured): <b style={{ color: 'var(--text-primary)' }}>{devCode}</b>
          </div>
        ) : null}

        <button
          type="submit"
          className="btn btn-primary"
          disabled={verifyMutation.isPending}
          aria-busy={verifyMutation.isPending}
        >
          {verifyMutation.isPending ? 'Verifying…' : <>Verify email<Ico.arrowRight w={15} /></>}
        </button>
      </form>

      <button
        type="button"
        className="btn btn-secondary"
        style={{ marginTop: 12, width: '100%', height: 46 }}
        disabled={resendMutation.isPending}
        onClick={() => resendMutation.mutate()}
      >
        {resendMutation.isPending ? 'Sending…' : 'Resend code'}
      </button>
    </AuthLayout>
  );
}
