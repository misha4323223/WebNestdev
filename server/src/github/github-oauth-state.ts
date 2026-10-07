const states = new Map<string, number>();
const TTL_MS = 10 * 60 * 1000;

export function createOAuthState() {
  const state = crypto.randomUUID();
  states.set(state, Date.now() + TTL_MS);
  return state;
}

export function consumeOAuthState(state: string) {
  const expiresAt = states.get(state);
  states.delete(state);
  return Boolean(expiresAt && expiresAt > Date.now());
}
