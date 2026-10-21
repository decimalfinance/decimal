// Change your password, from Your account. The server checks the current one
// and signs out every other browser; this one stays signed in. A refusal goes
// under the field it's about.
import { useId, useState } from 'react';
import { api } from '../../api';
import { Dialog } from '../../kit/Dialog';
import { codeOf, messageOf } from './parts';

const MIN = 8;

type Problem = { text: string; at: 'current' | 'next' };

export function PasswordDialog({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [show, setShow] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const currentId = useId();
  const nextId = useId();

  async function save() {
    if (busy) return;
    if (!current) return setProblem({ text: 'Enter your current password.', at: 'current' });
    if (next.length < MIN) return setProblem({ text: `Use at least ${MIN} characters.`, at: 'next' });
    if (next === current) return setProblem({ text: 'Choose a password different from your current one.', at: 'next' });
    setBusy(true);
    try {
      await api.changePassword({ currentPassword: current, newPassword: next });
      onDone();
    } catch (e) {
      setBusy(false);
      const code = codeOf(e);
      setProblem({ text: messageOf(e), at: code === 'wrong_password' || code === 'current_password_missing' ? 'current' : 'next' });
    }
  }

  return (
    <Dialog
      title="Change your password"
      line="You’ll stay signed in here."
      // While it's saving, it stays: closing wouldn't stop the change.
      onCancel={busy ? () => {} : onCancel}
      onConfirm={() => void save()}
      actions={
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={`btn is-primary${busy ? ' is-busy' : ''}`} onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save password'}
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field-label" htmlFor={currentId}>
          Current password
        </label>
        <input
          id={currentId}
          className={`input${problem?.at === 'current' ? ' is-error' : ''}`}
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => {
            setCurrent(e.target.value);
            setProblem(null);
          }}
          data-autofocus
        />
        {problem?.at === 'current' ? (
          <span className="field-error" role="alert">
            {problem.text}
          </span>
        ) : null}
      </div>
      <div className="field">
        <label className="field-label" htmlFor={nextId}>
          New password
        </label>
        <span className={`input${problem?.at === 'next' ? ' is-error' : ''}`}>
          <input
            id={nextId}
            type={show ? 'text' : 'password'}
            autoComplete="new-password"
            value={next}
            onChange={(e) => {
              setNext(e.target.value);
              setProblem(null);
            }}
          />
          <button type="button" className="st-showhide" aria-pressed={show} onClick={() => setShow(!show)}>
            {show ? 'Hide' : 'Show'}
          </button>
        </span>
        {problem?.at === 'next' ? (
          <span className="field-error" role="alert">
            {problem.text}
          </span>
        ) : (
          <span className="st-dlg-note">At least {MIN} characters.</span>
        )}
      </div>
    </Dialog>
  );
}
