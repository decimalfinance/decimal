import type { AuthContext } from './sessions.js';

export type ActorContext = {
  actorUserId: string | null;
  actorType: 'user';
  actorId: string;
  eventSource: 'user';
  userId: string | null;
};

export function actorFromAuth(auth: AuthContext): ActorContext {
  return {
    actorUserId: auth.userId,
    actorType: auth.actorType,
    actorId: auth.actorId,
    eventSource: auth.actorType,
    userId: auth.userId,
  };
}

export function userIdFromAuth(auth: AuthContext) {
  return auth.userId;
}
