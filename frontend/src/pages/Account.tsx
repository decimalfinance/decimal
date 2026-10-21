/**
 * Your account (2b): how you appear to your team and how you sign in, the
 * same page for everyone. Your name is edited in place and follows you into
 * every organisation; a new password signs out every other browser. Your
 * picture is the one your Google account has, or your initials: Decimal has
 * nowhere to keep a picture of its own yet.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Avatar } from '../kit/Avatar';
import { useSignOut } from '../kit/Shell';
import { personTone } from '../kit/people';
import { useToaster } from '../kit/Toast';
import { PasswordDialog } from './settings/PasswordDialog';
import { Heading, NameRow, messageOf } from './settings/parts';

export function AccountPage() {
  const queryClient = useQueryClient();
  const toaster = useToaster();
  const askSignOut = useSignOut();
  const session = useQuery({ queryKey: ['session'], queryFn: () => api.getSession(), staleTime: Infinity });
  const [changing, setChanging] = useState(false);
  const [changedNow, setChangedNow] = useState(false);

  const me = session.data?.user;
  if (!me) return <div className="ui page" />;

  // Everything that shows a person's name: the engine keeps a copy of it.
  async function refreshName() {
    await queryClient.invalidateQueries({ queryKey: ['session'] });
    for (const key of ['members-roles', 'protections', 'policy-exceptions', 'bills-workbench', 'inbox']) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  }

  async function rename(next: string, before: string): Promise<string | null> {
    try {
      await api.updateMe({ displayName: next });
    } catch (e) {
      return messageOf(e);
    }
    await refreshName();
    toaster.show(`Your name is now ${next}.`, {
      undo: () => {
        api
          .updateMe({ displayName: before })
          .then(refreshName)
          .catch((e) => toaster.show(`Couldn’t put your name back. ${messageOf(e)}`));
      },
    });
    return null;
  }

  const google = me.signInMethod === 'google';

  return (
    <div className="ui page">
      <div className="st-top">
        <div className="st-top-text">
          <h1 className="page-title">Your account</h1>
          <p className="page-sub">How you appear to your team and how you sign in. Only you can change these.</p>
        </div>
        <Avatar name={me.displayName} src={me.avatarUrl} size={48} fontSize={15} tone={personTone(me.userId)} />
      </div>

      <div className="st-blocks">
        <section>
          <Heading title="You" />
          <div className="st-rows">
            <NameRow
              label="Name"
              line="Shown to your team on bills, questions and approvals."
              value={me.displayName}
              canEdit
              action="Edit"
              fieldLabel="Your name"
              wide
              emptyError="Enter your name."
              save={(next) => rename(next, me.displayName)}
            />
            <div className="st-row">
              <div className="st-left">
                <div className="st-label">Email</div>
                <div className="st-line">You sign in with this address.</div>
              </div>
              <div className="st-right">
                <span className="st-value num clip" title={me.email}>
                  {me.email}
                </span>
              </div>
            </div>
          </div>
        </section>

        <section>
          <Heading title="Signing in" />
          <div className="st-rows">
            <div className="st-row">
              <div className="st-left">
                <div className="st-label">Password</div>
                <div className="st-line">
                  {me.hasPassword === false
                    ? google
                      ? 'You sign in with Google.'
                      : 'This account has no password.'
                    : changedNow
                      ? 'Changed just now.'
                      : 'Changing it signs you out of Decimal in every other browser.'}
                </div>
              </div>
              {me.hasPassword === false ? null : (
                <div className="st-right">
                  <span className="st-dots" aria-label="Hidden">
                    ••••••••••
                  </span>
                  <button type="button" className="st-pill" onClick={() => setChanging(true)}>
                    Change password
                  </button>
                </div>
              )}
            </div>
            <div className="st-row">
              <div className="st-left">
                <div className="st-label">Sign out</div>
                <div className="st-line">Signs you out of Decimal in this browser. Your team and your bills aren’t affected.</div>
              </div>
              <div className="st-right">
                <button type="button" className="st-pill" onClick={askSignOut}>
                  Sign out
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>

      {changing ? (
        <PasswordDialog
          onCancel={() => setChanging(false)}
          onDone={() => {
            setChanging(false);
            setChangedNow(true);
            toaster.show('Password changed. You’re still signed in here.');
          }}
        />
      ) : null}
    </div>
  );
}
