import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { orbAccountUrl, orbTransactionUrl, shortenAddress } from './lib/app';

// A monospace explorer link for a Solana address or signature, with a copy button.
export function ChainLink({
  address,
  signature,
  prefix = 6,
  suffix = 6,
  showCopy = true,
}: {
  address?: string;
  signature?: string;
  prefix?: number;
  suffix?: number;
  showCopy?: boolean;
}) {
  const value = address ?? signature ?? '';
  const href = signature ? orbTransactionUrl(value) : orbAccountUrl(value);
  return (
    <span
      className="rd-addr-link"
      style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
    >
      <a href={href} target="_blank" rel="noreferrer" title={value} style={{ color: 'inherit' }}>
        {shortenAddress(value, prefix, suffix)}
      </a>
      {showCopy ? <CopyButton value={value} ariaLabel={signature ? 'Copy signature' : 'Copy address'} /> : null}
    </span>
  );
}

// Tiny inline clipboard button. Briefly swaps to a check icon for ~1.4s
// after a successful copy so the operator gets visual confirmation.
function CopyButton({
  value,
  ariaLabel = 'Copy',
  size = 12,
}: {
  value: string;
  ariaLabel?: string;
  size?: number;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Permissions denied or unsupported — fail silently; the user can still triple-click + Cmd+C.
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={copied ? 'Copied' : ariaLabel}
      title={copied ? 'Copied' : ariaLabel}
      className="rd-copy-btn"
      style={{
        background: 'transparent',
        border: 'none',
        padding: 2,
        margin: 0,
        display: 'inline-flex',
        alignItems: 'center',
        cursor: 'pointer',
        color: copied ? 'var(--ax-success, #4ade80)' : 'inherit',
        opacity: copied ? 1 : 0.65,
        transition: 'opacity 120ms ease, color 120ms ease',
        lineHeight: 0,
      }}
      onMouseEnter={(e) => { if (!copied) e.currentTarget.style.opacity = '1'; }}
      onMouseLeave={(e) => { if (!copied) e.currentTarget.style.opacity = '0.65'; }}
    >
      {copied ? <CheckIcon size={size} /> : <CopyIcon size={size} />}
    </button>
  );
}

function CopyIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

// Dashed institutional empty-state card.
function EmptyPanel({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state empty-state-institutional">
      <strong>{title}</strong>
      <p>{description}</p>
      {action ? <div className="empty-state-actions">{action}</div> : null}
    </div>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return <EmptyPanel title={title} description={description} />;
}

// Full-screen loading/error state (centered empty panel).
export function ScreenState({ title, description }: { title: string; description: string }) {
  return (
    <main className="screen-state">
      <EmptyState title={title} description={description} />
    </main>
  );
}
