// The policy dialogs on Organisation, for the primary admin only: turning No
// self-approval off (for everyone or for named people) and back on, and
// changing the bill ceiling. Each asks for the password when the account has
// one, and the server checks it: a policy changes only behind it.
import { useState, type ReactNode } from 'react';
import { policiesApi, protectionsApi } from '../../api';
import { Avatar } from '../../kit/Avatar';
import { Dialog } from '../../kit/Dialog';
import { usd } from '../../kit/format';
import { codeOf, joinNames, messageOf } from './parts';

/** Someone who can send a bill for approval, and so be let approve their own. */
export type Sender = { personId: string; name: string; avatarUrl: string | null; role: string; you: boolean };

type Problem = { text: string; at: 'people' | 'amount' | 'password' | 'end' };

function Note({ problem, at }: { problem: Problem | null; at: Problem['at'] }) {
  if (problem?.at !== at) return null;
  return (
    <span className="field-error" role="alert">
      {problem.text}
    </span>
  );
}

function PasswordField({
  value,
  onChange,
  problem,
  focus,
}: {
  value: string;
  onChange: (v: string) => void;
  problem: Problem | null;
  focus: boolean;
}) {
  return (
    <label className="field">
      <span className="field-label">Your password</span>
      <input
        className={`input${problem?.at === 'password' ? ' is-error' : ''}`}
        type="password"
        autoComplete="current-password"
        aria-label="Your password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-autofocus={focus || undefined}
      />
      <Note problem={problem} at="password" />
    </label>
  );
}

/** What every policy dialog shares: the busy state, the password, the refusal. */
function usePolicyDialog(requiresPassword: boolean) {
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  return {
    password,
    problem,
    busy,
    setProblem,
    typePassword(v: string) {
      setPassword(v);
      setProblem(null);
    },
    /** The password check before anything is sent; false when it's missing. */
    passwordReady() {
      if (requiresPassword && !password) {
        setProblem({ text: 'Enter your password.', at: 'password' });
        return false;
      }
      return true;
    },
    async send(run: () => Promise<void>) {
      setBusy(true);
      try {
        await run();
      } catch (e) {
        setBusy(false);
        setProblem({ text: messageOf(e), at: codeOf(e) === 'wrong_password' ? 'password' : 'end' });
      }
    },
  };
}

function Actions({ busy, label, tone, focus, onCancel, onConfirm }: { busy: boolean; label: string; tone: 'primary' | 'remove'; focus: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <>
      <button type="button" className="btn" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
      <button
        type="button"
        className={`btn ${tone === 'remove' ? 'is-remove' : 'is-primary'}${busy && tone === 'primary' ? ' is-busy' : ''}`}
        onClick={onConfirm}
        disabled={busy}
        data-autofocus={focus || undefined}
      >
        {label}
      </button>
    </>
  );
}

const nothing = () => {};

export function TurnOffDialog({
  organizationId,
  senders,
  requiresPassword,
  onDone,
  onCancel,
}: {
  organizationId: string;
  senders: Sender[];
  requiresPassword: boolean;
  onDone: (said: string) => void;
  onCancel: () => void;
}) {
  const [scope, setScope] = useState<'everyone' | 'some'>('everyone');
  const [picked, setPicked] = useState<string[]>([]);
  const d = usePolicyDialog(requiresPassword);
  const title = 'Turn off No self-approval?';
  const line = 'Whoever it’s off for can approve bills they sent. Those bills are listed under Exceptions.';

  function confirm() {
    if (d.busy) return;
    if (scope === 'some' && picked.length === 0) {
      d.setProblem({ text: 'Pick at least one person.', at: 'people' });
      return;
    }
    if (!d.passwordReady()) return;
    const names = senders.filter((s) => picked.includes(s.personId)).map((s) => s.name);
    void d.send(async () => {
      await protectionsApi.relax(organizationId, 'R1', {
        password: requiresPassword ? d.password : undefined,
        // Exactly what they were shown, which goes into the record.
        sheetContent: { title, line, scope: scope === 'everyone' ? 'everyone' : names },
        scopedPersonIds: scope === 'everyone' ? null : picked,
      });
      onDone(scope === 'everyone' ? 'No self-approval is off for everyone' : `No self-approval is off for ${joinNames(names)}`);
    });
  }

  return (
    <Dialog
      title={title}
      line={line}
      onCancel={d.busy ? nothing : onCancel}
      onConfirm={confirm}
      actions={
        <Actions
          busy={d.busy}
          label={scope === 'everyone' ? 'Turn off for everyone' : 'Turn off'}
          tone="remove"
          focus={!requiresPassword}
          onCancel={onCancel}
          onConfirm={confirm}
        />
      }
    >
      <div className="st-pick">
        <div role="radiogroup" aria-label="Who it’s off for" className="st-radios">
          {(['everyone', 'some'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={scope === s}
              className="st-choice"
              onClick={() => {
                setScope(s);
                d.setProblem(null);
              }}
            >
              <span className="st-radio" aria-hidden />
              {s === 'everyone' ? 'For everyone' : 'For some people'}
            </button>
          ))}
        </div>
        {scope === 'some' ? (
          <div className="st-people" role="group" aria-label="Who it’s off for">
            {senders.map((p) => {
              const on = picked.includes(p.personId);
              return (
                <button
                  key={p.personId}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  className="st-choice is-person"
                  onClick={() => {
                    setPicked(on ? picked.filter((id) => id !== p.personId) : [...picked, p.personId]);
                    d.setProblem(null);
                  }}
                >
                  <span className="st-check" aria-hidden>
                    {on ? (
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m5.5 12.5 4 4 9-9" />
                      </svg>
                    ) : null}
                  </span>
                  <Avatar name={p.name} src={p.avatarUrl} size={16} />
                  <span className="st-choice-name">
                    {p.name}
                    {p.you ? <span className="st-you"> (you)</span> : null}
                  </span>
                  <span className="st-choice-role">{p.role}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        <Note problem={d.problem} at="people" />
      </div>
      {requiresPassword ? <PasswordField value={d.password} onChange={d.typePassword} problem={d.problem} focus /> : null}
      <Note problem={d.problem} at="end" />
    </Dialog>
  );
}

export function TurnBackOnDialog({
  organizationId,
  exceptFor,
  requiresPassword,
  onDone,
  onCancel,
}: {
  organizationId: string;
  /** The people it's off for, when it's off for some. */
  exceptFor: string[] | null;
  requiresPassword: boolean;
  onDone: (said: string) => void;
  onCancel: () => void;
}) {
  const d = usePolicyDialog(requiresPassword);

  function confirm() {
    if (d.busy || !d.passwordReady()) return;
    void d.send(async () => {
      await protectionsApi.retighten(organizationId, 'R1', requiresPassword ? d.password : undefined);
      onDone('No self-approval is back on');
    });
  }

  return (
    <Dialog
      title="Turn No self-approval back on?"
      line={
        exceptFor?.length
          ? `Whoever sent a bill for approval won’t be able to approve it, ${joinNames(exceptFor)} included.`
          : 'Whoever sent a bill for approval won’t be able to approve it.'
      }
      onCancel={d.busy ? nothing : onCancel}
      onConfirm={confirm}
      actions={<Actions busy={d.busy} label="Turn back on" tone="primary" focus={!requiresPassword} onCancel={onCancel} onConfirm={confirm} />}
    >
      {requiresPassword ? <PasswordField value={d.password} onChange={d.typePassword} problem={d.problem} focus /> : null}
      <Note problem={d.problem} at="end" />
    </Dialog>
  );
}

const MAX_CEILING = 1_000_000_000;

/** "25,000.00", as the field shows an amount. */
function grouped(amount: number) {
  return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function CeilingDialog({
  organizationId,
  currentUsd,
  requiresPassword,
  onDone,
  onCancel,
}: {
  organizationId: string;
  currentUsd: number | null;
  requiresPassword: boolean;
  onDone: (said: ReactNode) => void;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState(currentUsd === null ? '' : grouped(currentUsd));
  const d = usePolicyDialog(requiresPassword);

  function confirm() {
    if (d.busy) return;
    const typed = Number(amount.replace(/[$,\s]/g, ''));
    if (!amount.trim() || !Number.isFinite(typed) || typed <= 0) {
      d.setProblem({ text: 'Enter an amount, like 25,000.00.', at: 'amount' });
      return;
    }
    if (typed > MAX_CEILING) {
      d.setProblem({ text: `Enter an amount up to ${grouped(MAX_CEILING)}.`, at: 'amount' });
      return;
    }
    if (!d.passwordReady()) return;
    const cents = Math.round(typed * 100) / 100;
    void d.send(async () => {
      await policiesApi.setCeiling(organizationId, cents, requiresPassword ? d.password : undefined);
      onDone(
        <>
          The bill ceiling is now <span className="num">{usd(cents)}</span>
        </>,
      );
    });
  }

  return (
    <Dialog
      title="Change the bill ceiling"
      line="A bill over this needs an exception from the primary admin before anyone can approve it."
      onCancel={d.busy ? nothing : onCancel}
      onConfirm={confirm}
      actions={<Actions busy={d.busy} label="Save" tone="primary" focus={false} onCancel={onCancel} onConfirm={confirm} />}
    >
      <label className="field">
        <span className="field-label">Largest bill</span>
        <span className={`input st-amount-field${d.problem?.at === 'amount' ? ' is-error' : ''}`}>
          <span className="st-dollar" aria-hidden>
            $
          </span>
          <input
            inputMode="decimal"
            aria-label="Largest bill"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              d.setProblem(null);
            }}
            data-autofocus
          />
        </span>
        <Note problem={d.problem} at="amount" />
      </label>
      {requiresPassword ? <PasswordField value={d.password} onChange={d.typePassword} problem={d.problem} focus={false} /> : null}
      <Note problem={d.problem} at="end" />
    </Dialog>
  );
}
