import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type AuthenticatedSession } from '../api';
import { AuthDivider, OAuthButton } from '../ui/AuthButtons';
import { queryKeys, toAuthenticatedSession } from '../lib/app-helpers';

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

function AuthTabs({ active }: { active: 'login' | 'register' }) {
  return (
    <div className="auth-tabs" role="tablist" aria-label="Authentication mode">
      <Link
        to="/login"
        role="tab"
        aria-selected={active === 'login'}
        data-active={active === 'login'}
        className="auth-tab"
        replace
      >
        Sign in
      </Link>
      <Link
        to="/register"
        role="tab"
        aria-selected={active === 'register'}
        data-active={active === 'register'}
        className="auth-tab"
        replace
      >
        Create account
      </Link>
    </div>
  );
}

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
    <main className="login-shell">
      <section className="login-panel">
        <div className="panel-kicker">Google OAuth</div>
        <h1 className="auth-title">{error ? 'Sign-in failed' : 'Finishing sign-in'}</h1>
        <p className="muted-copy">
          {error ?? 'Creating your Decimal session and loading your organizations.'}
        </p>
        {error ? (
          <Link className="button button-primary" to="/login" replace>
            Back to sign in
          </Link>
        ) : null}
      </section>
    </main>
  );
}

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
    <main className="login-shell">
      <section className="login-panel">
        <AuthTabs active="login" />
        <OAuthButton mode="login" returnTo={returnTo} />
        <AuthDivider />
        <form className="login-form" onSubmit={handleSubmit}>
          <label>
            Email
            <input
              name="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="ops@company.com"
              autoComplete="email"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              inputMode="email"
              required
            />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Your password"
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={loginMutation.isPending} type="submit">
            {loginMutation.isPending ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
        {error ? <p className="form-error">{error}</p> : null}
      </section>
    </main>
  );
}

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
    <main className="login-shell">
      <section className="login-panel">
        <AuthTabs active="register" />
        <OAuthButton mode="register" returnTo={returnTo} />
        <AuthDivider />
        <form className="login-form" onSubmit={handleSubmit}>
          <label>
            Email
            <input
              name="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="ops@company.com"
              autoComplete="email"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              inputMode="email"
              required
            />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="At least 8 characters"
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              required
            />
          </label>
          <label>
            Name <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>(optional)</span>
            <input
              name="displayName"
              type="text"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Ops"
              autoComplete="name"
            />
          </label>
          <button
            className="button button-primary"
            disabled={registerMutation.isPending}
            type="submit"
          >
            {registerMutation.isPending ? 'Creating account...' : 'Create account'}
          </button>
        </form>
        {error ? <p className="form-error">{error}</p> : null}
      </section>
    </main>
  );
}

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
      navigate(session.organizations[0] ? `/organizations/${session.organizations[0].organizationId}` : '/setup', { replace: true });
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
    <main className="login-shell">
      <section className="login-panel">
        <div className="panel-kicker">Verify email</div>
        <h1 className="auth-title">Confirm your account</h1>
        <p className="muted-copy">Enter the verification code for {session.user.email}.</p>
        <form
          className="login-form"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            verifyMutation.mutate();
          }}
        >
          <label>
            Verification code
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="123456"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
            />
          </label>
          <button className="button button-primary" disabled={verifyMutation.isPending} type="submit">
            {verifyMutation.isPending ? 'Verifying...' : 'Verify email'}
          </button>
        </form>
        <button className="button button-secondary" disabled={resendMutation.isPending} onClick={() => resendMutation.mutate()} type="button">
          {resendMutation.isPending ? 'Sending...' : 'Resend code'}
        </button>
        {statusMessage ? <p className="muted-copy">{statusMessage}</p> : null}
        {devCode ? <p className="muted-copy">Dev code (no email provider configured): <strong>{devCode}</strong></p> : null}
        {error ? <p className="form-error">{error}</p> : null}
      </section>
    </main>
  );
}
