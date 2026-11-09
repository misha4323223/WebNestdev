import { randomUUID } from "node:crypto";
import { isYdbEnabled, ydbQuery, getTable } from "../storage/ydb.js";

type OAuthState = { expiresAt:number; userId:string; verifier:string };
const states = new Map<string, OAuthState>();
const TTL_MS = 10 * 60 * 1000;

/**
 * The state carries the browser origin that started the flow, encoded after the
 * random part, so the callback can return the user to the right host (a hosted
 * preview domain instead of the API host) without another storage column. The
 * random prefix is what makes the state unguessable: it must exist in storage to
 * be accepted, and it is consumed on first use.
 */
function encodeState(random:string,returnOrigin?:string){
  if(!returnOrigin)return random;
  return random+"."+Buffer.from(returnOrigin,"utf8").toString("base64url");
}

export function originFromOAuthState(state:string){
  const encoded=state.split(".")[1];
  if(!encoded)return null;
  try{return new URL(Buffer.from(encoded,"base64url").toString("utf8")).origin}catch{return null}
}

/**
 * `verifier` нужен только потоку с PKCE (GitVerse): без него callback на другой реплике
 * не сможет обменять код. Раньше он жил в памяти процесса, и это ломало вход после
 * переключения балансировщика. Для обычных OAuth-подключений остаётся пустым.
 */
export async function createOAuthState(userId:string,returnOrigin?:string,verifier="") {
  const random = randomUUID();
  const state = encodeState(random,returnOrigin);
  const expiresAt = new Date(Date.now() + TTL_MS);
  if(isYdbEnabled()){
    await ydbQuery()`UPSERT INTO ${ydbQuery().identifier(getTable("oauth_states"))}
      (state,user_id,expires_at,verifier)
      VALUES (${state},${userId},${expiresAt.toISOString()},${verifier})`;
    return state;
  }
  states.set(state, { expiresAt: expiresAt.getTime(), userId, verifier });
  return state;
}

/** Одноразовое изъятие строки: и для обычного входа, и для PKCE. */
async function takeOAuthState(state:string): Promise<OAuthState|null> {
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{user_id:string;expires_at:string;verifier:string}>>`
      DELETE FROM ${ydbQuery().identifier(getTable("oauth_states"))}
      WHERE state = ${state}
      RETURNING user_id,expires_at,verifier
    `;
    const row=rows?.[0];
    if(!row || Date.parse(row.expires_at) <= Date.now()) return null;
    return { userId:row.user_id, expiresAt:Date.parse(row.expires_at), verifier:row.verifier ?? "" };
  }
  const value = states.get(state);
  states.delete(state);
  if(!value || value.expiresAt <= Date.now()) return null;
  return value;
}

export async function consumeOAuthState(state:string) {
  return (await takeOAuthState(state))?.userId ?? null;
}

/** Для callback-ов с PKCE: возвращает владельца и verifier из одной строки состояния. */
export async function consumeOAuthStateWithVerifier(state:string) {
  const value = await takeOAuthState(state);
  if(!value) return null;
  return { userId:value.userId, verifier:value.verifier };
}
