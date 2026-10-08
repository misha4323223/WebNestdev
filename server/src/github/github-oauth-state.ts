import { randomUUID } from "node:crypto";
import { isYdbEnabled, ydbQuery, getTable } from "../storage/ydb.js";

type OAuthState = { expiresAt:number; userId:string };
const states = new Map<string, OAuthState>();
const TTL_MS = 10 * 60 * 1000;

export async function createOAuthState(userId:string) {
  const state = randomUUID();
  const expiresAt = new Date(Date.now() + TTL_MS);
  if(isYdbEnabled()){
    await ydbQuery()`UPSERT INTO ${ydbQuery().identifier(getTable("oauth_states"))}
      (state,user_id,expires_at)
      VALUES (${state},${userId},${expiresAt.toISOString()})`;
    return state;
  }
  states.set(state, { expiresAt: expiresAt.getTime(), userId });
  return state;
}

export async function consumeOAuthState(state:string) {
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{user_id:string;expires_at:string}>>`
      DELETE FROM ${ydbQuery().identifier(getTable("oauth_states"))}
      WHERE state = ${state}
      RETURNING user_id,expires_at
    `;
    const row=rows?.[0];
    if(!row || Date.parse(row.expires_at) <= Date.now()) return null;
    return row.user_id;
  }
  const value = states.get(state);
  states.delete(state);
  if(!value || value.expiresAt <= Date.now()) return null;
  return value.userId;
}