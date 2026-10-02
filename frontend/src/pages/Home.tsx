// Home — where you talk to the companion, and the page you land on.
//
// The conversation space is the page: a greeting and where things stand, a few
// questions worth asking, and the prompt docked at the bottom. The rail on the
// right keeps the work in view — what is waiting on you, what is running, what
// got done. Asking something starts a chat in the same frame.

import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { companionApi } from '../api';
import { Ico } from '../dec/icons';
import { useToast } from '../ui/Toast';
import { Composer } from './Chat';
import { openingLine, useConsole, Workspace } from './CompanionRail';

/** Questions worth asking on day one, answered from the tools the chat has. */
const SUGGESTIONS = [
  'What is waiting on me?',
  'What is ready to send for approval?',
  'Which bills look like duplicates?',
  'Spend by vendor this month',
];

export function HomePage() {
  const { organizationId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const q = useConsole(organizationId);
  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 5) return 'Working late';
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }, []);
  const ask = useMutation({
    mutationFn: (text: string) => companionApi.startChat(organizationId, text),
    onSuccess: ({ chatId }) => {
      void queryClient.invalidateQueries({ queryKey: ['companion-chats', organizationId] });
      navigate(`/organizations/${organizationId}/chat/${chatId}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not ask that.'),
  });
  const c = q.data;
  const firstName = c?.viewer.name?.trim().split(/\s+/)[0];

  return (
    <Workspace>
      <div className="cw-scroll">
        <div className="cw-hello">
          <h1>{firstName ? `${greeting}, ${firstName}` : greeting}</h1>
          {c ? <div className="cw-hello-line"><Ico.sparkle w={14} />{openingLine(c)}</div> : null}
          <div className="cp-chips">
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" className="cp-chip" disabled={ask.isPending} onClick={() => ask.mutate(s)}>{s}</button>
            ))}
          </div>
        </div>
      </div>
      <div className="cw-dock">
        <Composer placeholder="What can I help you with?" busy={ask.isPending} onSend={(t) => ask.mutate(t)} autoFocus />
      </div>
    </Workspace>
  );
}
