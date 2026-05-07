import { useState } from 'react';
import { api } from '../api';

export function OAuthButton({
  mode,
  returnTo,
}: {
  mode: 'login' | 'register';
  returnTo?: string | null;
}) {
  const [isRedirecting, setIsRedirecting] = useState(false);

  return (
    <button
      className="button button-secondary oauth-button"
      disabled={isRedirecting}
      type="button"
      onClick={() => {
        setIsRedirecting(true);
        window.location.assign(api.getGoogleOAuthStartUrl(returnTo ?? '/setup'));
      }}
    >
      <span className="oauth-button-mark" aria-hidden>
        G
      </span>
      {isRedirecting
        ? 'Opening Google...'
        : mode === 'login'
          ? 'Sign in with Google'
          : 'Continue with Google'}
    </button>
  );
}

export function AuthDivider() {
  return (
    <div className="auth-divider" role="presentation">
      <span />
      <em>or</em>
      <span />
    </div>
  );
}
