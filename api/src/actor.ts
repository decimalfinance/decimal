import type { AuthContext } from './auth.js';

export type ActorContext = {
  actorType: 'user' | 'api_key';
  actorId: string;
  eventSource: 'user' | 'api_key';
  userId: string | null;
};

export function actorFromAuth(auth: AuthContext): ActorContext {
  return {
    actorType: auth.actorType,
    actorId: auth.actorId,
    eventSource: auth.actorType,
    userId: auth.authType === 'user_session' ? auth.userId : null,
  };
}

export function userIdFromAuth(auth: AuthContext) {
  return auth.authType === 'user_session' ? auth.userId : null;
}
