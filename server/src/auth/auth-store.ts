import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isYdbEnabled, ydbQuery, getTable } from "../storage/ydb.js";

const scrypt = promisify(scryptCallback);
const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
const usersDir = path.join(root, "auth");
const usersFile = path.join(usersDir, "users.json");
const sessionsFile = path.join(usersDir, "sessions.json");

export type User = { id:string; email:string; passwordHash:string; createdAt:string };
export const EMAIL_TAKEN_MESSAGE = "Этот email уже зарегистрирован";

/**
 * Сессия. `expiresAt` — абсолютный срок, `lastSeenAt` — когда ею пользовались в последний раз.
 *
 * Без второй отметки украденная cookie жила бы ровно 30 дней, даже если владелец за это время
 * ни разу не открыл панель. Поэтому у сессии два предела: «бездействие» и «возраст», и оба
 * проверяются при каждом обращении (см. `getSession`).
 */
export type Session = { id:string; userId:string; expiresAt:string; lastSeenAt:string };
/** Запись старого формата: до появления idle-таймаута отметки активности не было. */
type StoredSession = Omit<Session,"lastSeenAt"> & { lastSeenAt?:string };

/** Абсолютный срок сессии: 30 дней по умолчанию (было зашито числом в коде и в cookie). */
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Бездействие: 7 дней по умолчанию — но никогда дольше абсолютного срока. */
const DEFAULT_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Отметка «сессия использовалась» пишется не чаще раза в минуту, а не на каждый запрос. */
export const SESSION_TOUCH_INTERVAL_MS = 60_000;

function positiveMs(raw:string|undefined, fallback:number){
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
/** Сколько живёт сессия всего (абсолютный срок); значение для cookie берётся отсюда же. */
export function sessionTtlMs(){ return positiveMs(process.env.SESSION_TTL_MS, DEFAULT_SESSION_TTL_MS); }
/** Сколько сессия может простоять без единого запроса; больше абсолютного срока не бывает. */
export function sessionIdleTtlMs(){ return Math.min(sessionTtlMs(), positiveMs(process.env.SESSION_IDLE_TTL_MS, DEFAULT_IDLE_TTL_MS)); }

async function readJson<T>(file:string, fallback:T):Promise<T>{
  try { return JSON.parse(await readFile(file, "utf8")) as T; } catch { return fallback; }
}
async function writeJson(file:string, value:unknown){
  await mkdir(usersDir, {recursive:true});
  await writeFile(file, JSON.stringify(value, null, 2), {mode:0o600});
}

export async function findUserByEmail(email:string){
  const normalized=email.toLowerCase();
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{id:string;email:string;password_hash:string;created_at:string}>>`
      SELECT id,email,password_hash,created_at
      FROM ${ydbQuery().identifier(getTable("users"))}
      WHERE email = ${normalized}
      LIMIT 1
    `;
    const row=rows?.[0];
    return row ? {id:row.id,email:row.email,passwordHash:row.password_hash,createdAt:row.created_at} : null;
  }
  const users = await readJson<User[]>(usersFile, []);
  return users.find(user => user.email === normalized) ?? null;
}

export async function getUser(userId:string){
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{id:string;email:string;password_hash:string;created_at:string}>>`
      SELECT id,email,password_hash,created_at
      FROM ${ydbQuery().identifier(getTable("users"))}
      WHERE id = ${userId}
      LIMIT 1
    `;
    const row=rows?.[0];
    return row ? {id:row.id,email:row.email,passwordHash:row.password_hash,createdAt:row.created_at} : null;
  }
  const users = await readJson<User[]>(usersFile, []);
  return users.find(user => user.id === userId) ?? null;
}

export async function createUser(email:string, password:string){
  const normalized = email.trim().toLowerCase();
  if(await findUserByEmail(normalized)) throw new Error(EMAIL_TAKEN_MESSAGE);
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64) as Buffer;
  const user:User = {id:randomUUID(), email:normalized, passwordHash:salt + ":" + derived.toString("hex"), createdAt:new Date().toISOString()};
  if(isYdbEnabled()){
    try {
      await ydbQuery()`
        INSERT INTO ${ydbQuery().identifier(getTable("users"))}
          (id,email,password_hash,created_at)
        VALUES (${user.id},${user.email},${user.passwordHash},${user.createdAt})
      `;
    } catch (error) {
      if(await findUserByEmail(normalized)) throw new Error(EMAIL_TAKEN_MESSAGE);
      throw error;
    }
    return user;
  }
  const users = await readJson<User[]>(usersFile, []);
  users.push(user);
  await writeJson(usersFile, users);
  return user;
}

export const DEMO_ACCOUNT = { email: "demo@webnestdev.local", password: "demo1234" };

/**
 * Shared demo account: NestDev seeds it on startup so a fresh install can be
 * opened without registering. Disabled in production unless WEBNESTDEV_DEMO_USER=1;
 * credentials can be overridden with WEBNESTDEV_DEMO_EMAIL / WEBNESTDEV_DEMO_PASSWORD.
 */
export async function ensureDemoUser(){
  const email = process.env.WEBNESTDEV_DEMO_EMAIL?.trim().toLowerCase() || DEMO_ACCOUNT.email;
  const password = process.env.WEBNESTDEV_DEMO_PASSWORD?.trim() || DEMO_ACCOUNT.password;
  if(await findUserByEmail(email)) return {email,created:false};
  try{
    await createUser(email,password);
    return {email,created:true};
  }catch(error){
    // Another worker may have seeded it first; that is not an error.
    if(await findUserByEmail(email)) return {email,created:false};
    throw error;
  }
}

export async function verifyUser(email:string,password:string){
  const user = await findUserByEmail(email);
  if(!user) return null;
  const [salt, stored] = user.passwordHash.split(":");
  if(!salt || !stored) return null;
  const derived = await scrypt(password, salt, 64) as Buffer;
  const expected = Buffer.from(stored, "hex");
  return expected.length === derived.length && timingSafeEqual(expected, derived) ? user : null;
}

/**
 * `now` — только для тестов: иначе сроки проверялись бы ожиданием в несколько дней.
 */
export async function createSession(userId:string, now=Date.now()){
  const session:Session = {
    id:randomBytes(32).toString("hex"),
    userId,
    expiresAt:new Date(now+sessionTtlMs()).toISOString(),
    lastSeenAt:new Date(now).toISOString(),
  };
  if(isYdbEnabled()){
    await ydbQuery()`
      INSERT INTO ${ydbQuery().identifier(getTable("sessions"))}
        (id,user_id,expires_at,last_seen_at)
      VALUES (${session.id},${session.userId},${session.expiresAt},${session.lastSeenAt})
    `;
    return session;
  }
  const sessions = await readJson<StoredSession[]>(sessionsFile, []);
  sessions.push(session);
  await writeJson(sessionsFile, sessions);
  return session;
}

/**
 * Общая проверка срока для обеих веток хранилища.
 *
 * - Абсолютный срок истёк — сессия удаляется.
 * - Бездействие дольше `SESSION_IDLE_TTL_MS` — тоже удаляется.
 * - Записи без отметки (всё, что было до миграции) получают полный idle-срок от первого
 *   запроса: иначе выкатка оборвала бы все входы сразу, а не «через неделю бездействия».
 * - Отметка обновляется не на каждый запрос, а раз в `SESSION_TOUCH_INTERVAL_MS`.
 */
async function checkSession(session:Session, now:number):Promise<Session|null>{
  if(Date.parse(session.expiresAt)<=now){
    await deleteSession(session.id);
    return null;
  }
  const stored = Date.parse(session.lastSeenAt);
  const lastSeen = Number.isFinite(stored) ? stored : 0;
  if(lastSeen>0 && lastSeen+sessionIdleTtlMs()<=now){
    await deleteSession(session.id);
    return null;
  }
  if(!lastSeen || now-lastSeen>=SESSION_TOUCH_INTERVAL_MS){
    await touchSession(session.id, now);
    return {...session, lastSeenAt:new Date(now).toISOString()};
  }
  return session;
}

export async function getSession(sessionId:string, now=Date.now()){
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{id:string;user_id:string;expires_at:string;last_seen_at?:string}>>`
      SELECT id,user_id,expires_at,last_seen_at
      FROM ${ydbQuery().identifier(getTable("sessions"))}
      WHERE id = ${sessionId}
      LIMIT 1
    `;
    const row=rows?.[0];
    if(!row)return null;
    const session:Session={id:row.id,userId:row.user_id,expiresAt:row.expires_at,lastSeenAt:row.last_seen_at??""};
    return await checkSession(session, now);
  }
  const sessions = await readJson<StoredSession[]>(sessionsFile, []);
  const session = sessions.find(item => item.id === sessionId);
  if(!session) return null;
  return await checkSession({...session,lastSeenAt:session.lastSeenAt??""}, now);
}

/** Отметка активности. Отдельная функция: её вызывают проверка срока и, при желании, другие входы. */
async function touchSession(sessionId:string, now=Date.now()){
  const stamp = new Date(now).toISOString();
  if(isYdbEnabled()){
    await ydbQuery()`
      UPDATE ${ydbQuery().identifier(getTable("sessions"))}
      SET last_seen_at = ${stamp}
      WHERE id = ${sessionId}
    `;
    return;
  }
  const sessions = await readJson<StoredSession[]>(sessionsFile, []);
  const index = sessions.findIndex(item => item.id === sessionId);
  if(index<0) return;
  sessions[index] = {...sessions[index], lastSeenAt:stamp};
  await writeJson(sessionsFile, sessions);
}

export async function deleteSession(sessionId:string){
  if(isYdbEnabled()){
    await ydbQuery()`DELETE FROM ${ydbQuery().identifier(getTable("sessions"))} WHERE id = ${sessionId}`;
    return;
  }
  const sessions = await readJson<StoredSession[]>(sessionsFile, []);
  await writeJson(sessionsFile, sessions.filter(item => item.id !== sessionId));
}

/**
 * Отзыв всех сессий пользователя — «выйти на всех устройствах» и завершение угнанного входа.
 * Возвращает число отозванных, чтобы ответ говорил, что именно произошло.
 */
export async function deleteUserSessions(userId:string):Promise<number>{
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{id:string}>>`
      DELETE FROM ${ydbQuery().identifier(getTable("sessions"))}
      WHERE user_id = ${userId}
      RETURNING id
    `;
    return rows?.length ?? 0;
  }
  const sessions = await readJson<StoredSession[]>(sessionsFile, []);
  const kept = sessions.filter(item => item.userId !== userId);
  await writeJson(sessionsFile, kept);
  return sessions.length-kept.length;
}
