// Signing in and creating an account (designs 4c, 7a and 7c), the moment
// back from Google, and the developer page testing signs in through.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type AuthenticatedSession } from '../../api';
import { queryKeys } from '../../lib/app-helpers';
import { Body, Field, Frame, GoogleRow, Ink, LinkButton, Links, Note, Pill, TextLink, Title, failureText, useFocusOnOpen } from './parts';
import { homeFor, keepSession, landingFor, readSafeReturnTo, signOut, startClean, withReturn } from './landing';

/** The code, handed to Check your email, when this server sends no email. */
export type DevCodeState = { devCode?: string | null } | null;

const EMAIL_PROPS = { type: 'email', autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false } as const;
const MIN_PASSWORD = 8;

export function passwordProblem(password: string) {
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (password.length > 128) return 'Use 128 characters or fewer.';
  return undefined;
}

// ─── 4c · Sign in ──────────────────────────────────────────────────────

export function LoginPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const returnTo = readSafeReturnTo(useLocation().search);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const first = useFocusOnOpen<HTMLInputElement>();

  const signIn = useMutation({
    mutationFn: (input: { email: string; password: string }) => {
      startClean(queryClient);
      return api.login(input);
    },
    onSuccess: (result) => navigate(landingFor(keepSession(queryClient, result), returnTo), { replace: true }),
    onError: (error) => setErrors({ password: signInFailure(error) }),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const address = email.trim();
    const next = {
      email: address ? undefined : 'Enter your email.',
      password: password ? undefined : 'Enter your password.',
    };
    setErrors(next);
    if (!next.email && !next.password) signIn.mutate({ email: address, password });
  }

  return (
    <Frame>
      <Title>Sign in</Title>
      <form onSubmit={submit} noValidate>
        <GoogleRow returnTo={returnTo} />
        <div className="si-fields">
          <Field
            ref={first}
            id="si-email"
            label="EMAIL"
            name="email"
            placeholder="name@company.com"
            autoComplete="email"
            {...EMAIL_PROPS}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={errors.email}
          />
          <Field
            id="si-password"
            label="PASSWORD"
            type="password"
            name="password"
            placeholder="Your password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={errors.password}
          />
        </div>
        <Pill busy={signIn.isPending} busyLabel="Signing in…">Sign in</Pill>
      </form>
      <Links>
        New to Decimal? <TextLink to={withReturn('/register', returnTo)}>Create an account</TextLink>
      </Links>
    </Frame>
  );
}

function signInFailure(error: unknown) {
  // An unknown address, a wrong password and an account that has no password
  // all come back the same, on purpose.
  if (error instanceof ApiError && (error.status === 401 || error.code === 'validation_error')) {
    return 'That email and password don’t match an account.';
  }
  return failureText(error);
}

// ─── 7a · Create an account ────────────────────────────────────────────

export function RegisterPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const returnTo = readSafeReturnTo(useLocation().search);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ name?: string; email?: string; password?: string }>({});
  const first = useFocusOnOpen<HTMLInputElement>();

  const create = useMutation({
    mutationFn: (input: { email: string; password: string; displayName: string }) => {
      startClean(queryClient);
      return api.register(input);
    },
    onSuccess: (result) => {
      const session = keepSession(queryClient, result);
      const state: DevCodeState = { devCode: result.devEmailVerificationCode ?? null };
      navigate(landingFor(session, returnTo), { replace: true, state });
    },
    onError: (error) => setErrors(registerFailure(error)),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const displayName = name.trim();
    const address = email.trim();
    const next = {
      name: displayName ? undefined : 'Enter your name.',
      email: address ? undefined : 'Enter your email.',
      password: passwordProblem(password),
    };
    setErrors(next);
    if (!next.name && !next.email && !next.password) create.mutate({ email: address, password, displayName });
  }

  return (
    <Frame>
      <Title>Create an account</Title>
      <form onSubmit={submit} noValidate>
        <GoogleRow returnTo={returnTo} />
        <div className="si-fields">
          <Field
            ref={first}
            id="si-name"
            label="FULL NAME"
            name="name"
            placeholder="Your name"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={errors.name}
          />
          <Field
            id="si-email"
            label="WORK EMAIL"
            name="email"
            placeholder="name@company.com"
            autoComplete="email"
            {...EMAIL_PROPS}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={errors.email}
          />
          <Field
            id="si-password"
            label="PASSWORD"
            type="password"
            name="password"
            placeholder={`At least ${MIN_PASSWORD} characters`}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={errors.password}
          />
        </div>
        <Pill busy={create.isPending} busyLabel="Creating account…">Create account</Pill>
      </form>
      <Links>
        Already have an account? <TextLink to={withReturn('/login', returnTo)}>Sign in</TextLink>
      </Links>
    </Frame>
  );
}

export function registerFailure(error: unknown): { email?: string; password?: string } {
  if (error instanceof ApiError && error.code === 'conflict') {
    return { email: 'There’s already an account with this email. Sign in instead.' };
  }
  if (error instanceof ApiError && error.code === 'validation_error') {
    return { email: 'Check the address: it should look like name@company.com.' };
  }
  return { password: failureText(error) };
}

// ─── 7c · Check your email ─────────────────────────────────────────────
// The design sends a link; Decimal sends a six-digit code, so the screen asks
// for it. Shown for any page until the address is confirmed.

export function VerifyEmailPage({ session }: { session: AuthenticatedSession }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = readSafeReturnTo(location.search);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(() => (location.state as DevCodeState)?.devCode ?? null);
  const first = useFocusOnOpen<HTMLInputElement>();

  const confirm = useMutation({
    mutationFn: (value: string) => api.verifyEmail({ code: value }),
    onSuccess: async () => {
      // Always the server's answer: the copy in hand still says unconfirmed.
      const fresh = await queryClient.fetchQuery({ queryKey: queryKeys().session, queryFn: () => api.getSession(), staleTime: 0 });
      // From a page that needed the address confirmed, carry on to it.
      const here = location.pathname === '/verify-email' ? homeFor(fresh) : `${location.pathname}${location.search}`;
      navigate(returnTo ?? here, { replace: true });
    },
    onError: (err) => setError(codeFailure(err)),
  });

  const resend = useMutation({
    mutationFn: () => api.resendVerification(),
    onSuccess: (result) => {
      setDevCode(result.devEmailVerificationCode ?? null);
      setSent(
        result.emailDelivered
          ? 'A new code is on its way.'
          : result.devEmailVerificationCode
            ? null
            : 'The email didn’t go. Try again in a moment.',
      );
      setError(null);
    },
    onError: (err) => setSent(failureText(err)),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = code.trim();
    if (!value) {
      setError('Enter the code from the email.');
      return;
    }
    setError(null);
    confirm.mutate(value);
  }

  return (
    <Frame>
      <Title>Check your email</Title>
      <Body>
        We sent a six-digit code to <Ink>{session.user.email}</Ink>. Enter it here to finish creating your account.
      </Body>
      <form onSubmit={submit} noValidate>
        <div className="si-fields">
          <Field
            ref={first}
            id="si-code"
            label="CODE"
            name="code"
            placeholder="123456"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={12}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            error={error}
          />
        </div>
        <Pill busy={confirm.isPending} busyLabel="Confirming…">Confirm email</Pill>
      </form>
      <Links pair>
        <LinkButton onClick={() => resend.mutate()} disabled={resend.isPending}>
          {resend.isPending ? 'Sending…' : 'Send a new code'}
        </LinkButton>
        <LinkButton
          onClick={async () => {
            await signOut(queryClient);
            navigate('/register', { replace: true });
          }}
        >
          Use a different email
        </LinkButton>
      </Links>
      {sent ? <Note>{sent}</Note> : null}
      {devCode ? <Note>This server sends no email. The code is <Ink>{devCode}</Ink>.</Note> : null}
    </Frame>
  );
}

function codeFailure(error: unknown) {
  if (error instanceof ApiError && error.status === 400) {
    if (/expired/i.test(error.message)) return 'That code has expired. Send a new one.';
    if (/not active/i.test(error.message)) return 'That code is no longer in use. Send a new one.';
    return 'That code isn’t right. Check the email and try again.';
  }
  return failureText(error);
}

// ─── Back from Google ──────────────────────────────────────────────────

export function OAuthCallbackPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);
  // The fragment is read once: it is wiped from the address bar straight away.
  const read = useRef(false);

  useEffect(() => {
    if (read.current) return;
    read.current = true;
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const token = fragment.get('session_token');
    const asked = fragment.get('return_to');
    window.history.replaceState(null, document.title, '/oauth/callback');
    if (fragment.get('error') || !token) {
      setFailed(true);
      return;
    }
    api.setSessionToken(token);
    // "/setup" is where Google is sent when nowhere in particular was asked for.
    const returnTo = asked && asked !== '/setup' ? readSafeReturnTo(`?returnTo=${encodeURIComponent(asked)}`) : null;
    void queryClient
      .fetchQuery({ queryKey: queryKeys().session, queryFn: () => api.getSession(), staleTime: 0 })
      .then((session) => navigate(landingFor(session, returnTo), { replace: true }))
      .catch(() => {
        api.clearSessionToken();
        setFailed(true);
      });
  }, [navigate, queryClient]);

  if (failed) {
    return (
      <Frame>
        <Title>Sign-in didn’t finish</Title>
        <Body>Google didn’t sign you in. Try again, or use your email and password.</Body>
        <Links><TextLink to="/login">Back to sign in</TextLink></Links>
      </Frame>
    );
  }
  return (
    <Frame>
      <Title>Signing in</Title>
      <Body>One moment.</Body>
    </Frame>
  );
}

// ─── Developer sign-in (testing only, never linked from the product) ────
//
// Not a second way in: it calls the same /auth/login and /auth/register as
// the real pages, with the same rules. The one concession is the server's:
// an account on the reserved testing domain is made already confirmed,
// because there is no inbox to read a code from.

const DEV_EMAIL_DOMAIN = 'dev.decimal.test';

export function DevLoginPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const returnTo = readSafeReturnTo(useLocation().search);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const first = useFocusOnOpen<HTMLInputElement>();

  const capabilities = useQuery({
    queryKey: ['capabilities'] as const,
    queryFn: () => api.getCapabilities(),
    staleTime: 60_000,
  });
  const enabled = capabilities.data?.auth?.developerSignIn ?? false;
  const domain = capabilities.data?.auth?.developerEmailDomain ?? DEV_EMAIL_DOMAIN;

  // Sign in, or make the account on first use.
  const signIn = useMutation({
    mutationFn: async (input: { email: string; password: string }) => {
      startClean(queryClient);
      try {
        return await api.login(input);
      } catch (loginError) {
        if (loginError instanceof ApiError && loginError.status === 401) return api.register(input);
        throw loginError;
      }
    },
    onSuccess: (result) => navigate(landingFor(keepSession(queryClient, result), returnTo), { replace: true }),
    onError: (error) => {
      let password = signInFailure(error);
      if (error instanceof ApiError && error.code === 'validation_error') password = `Use at least ${MIN_PASSWORD} characters.`;
      // The account exists, so making it failed: the password was wrong.
      if (error instanceof ApiError && error.code === 'conflict') password = 'That isn’t this account’s password.';
      setErrors({ password });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const address = email.trim().toLowerCase();
    const next = {
      email: address.endsWith(`@${domain}`) ? undefined : `Use an address on @${domain}. Real addresses sign in on the usual page.`,
      password: password ? undefined : 'Enter a password.',
    };
    setErrors(next);
    if (!next.email && !next.password) signIn.mutate({ email: address, password });
  }

  if (capabilities.isSuccess && !enabled) {
    return (
      <Frame>
        <Title>Not available</Title>
        <Body>This server doesn’t allow testing accounts.</Body>
        <Links><TextLink to="/login">Back to sign in</TextLink></Links>
      </Frame>
    );
  }

  return (
    <Frame>
      <Title>Developer sign-in</Title>
      <Body>For testing. Use any address on @{domain}: the account is made the first time you sign in.</Body>
      <form onSubmit={submit} noValidate>
        <div className="si-fields">
          <Field
            ref={first}
            id="si-email"
            label="TESTING EMAIL"
            name="email"
            placeholder={`alice@${domain}`}
            autoComplete="off"
            {...EMAIL_PROPS}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={errors.email}
          />
          <Field
            id="si-password"
            label="PASSWORD"
            type="password"
            name="password"
            placeholder="Any password"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={errors.password}
          />
        </div>
        <Pill busy={signIn.isPending} busyLabel="Signing in…">Sign in</Pill>
      </form>
      <Note>Use the same password to sign in again.</Note>
      <Links>
        Real account? <TextLink to="/login">Sign in</TextLink>
      </Links>
    </Frame>
  );
}
