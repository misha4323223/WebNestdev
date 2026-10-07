type OAuthState = { expiresAt:number; userId:string };
const states = new Map<string, OAuthState>();
const TTL_MS = 10 * 60 * 1000;

export function createOAuthState(userId:string) {
  const state = crypto.randomUUID();
  states.set(state, { expiresAt: Date.now() + TTL_MS, userId });
  return state;
}

export function consumeOAuthState(state:string) {
  const value = states.get(state);
  states.delete(state);
  if(!value || value.expiresAt <= Date.now()) return null;
  return value.userId;
}
