import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isYdbEnabled, ydbQuery, getTable } from "../storage/ydb.js";

const scrypt = promisify(scryptCallback);
const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
const usersDir = path.join(root, "auth");
const usersFile = path.join(usersDir, "users.json");
const sessionsFile = path.join(usersDir, "sessions.json");
const emailVerificationsFile = path.join(usersDir, "email-verifications.json");
const passwordResetsFile = path.join(usersDir, "password-resets.json");

export type User = { id:string; email:string; passwordHash:string; createdAt:string; emailVerified:boolean };
/** Запись старого формата: до подтверждения почты поле отсутствовало у всех аккаунтов. */
type StoredUser = Omit<User,"emailVerified"> & { emailVerified?:boolean };
/** Исторические аккаунты считаются подтверждёнными: иначе выкатка закрыла бы им вход. */
function normalizeUser(user:StoredUser):User{ return {...user,emailVerified:user.emailVerified!==false}; }
export const EMAIL_TAKEN_MESSAGE = "Этот email уже зарегистрирован";
export const EMAIL_NOT_VERIFIED_MESSAGE = "Подтвердите почту: откройте ссылку из письма или запросите новое.";

/**
 * Служебный домен синтетических адресов: телефон, Яндекс ID, VK ID и демо-аккаунт.
 * Письмо на такой адрес уйти не может, поэтому восстановление пароля по нему не отправляется.
 * Заодно это ответ на вопрос «есть ли у аккаунта настоящий пароль»: у внешних входов он
 * случайный, и сменить его, не зная текущего, нельзя.
 */
export const SYNTHETIC_EMAIL_DOMAIN = "webnestdev.local";
export function hasLoginPassword(email:string){
  const domain = email.trim().toLowerCase().split("@").pop() ?? "";
  // Служебные адреса живут и на поддоменах: phone., yandex-id., vk-id. — поэтому проверяется
  // и сам домен, и его поддомены, а не только конец строки с «@».
  return domain !== SYNTHETIC_EMAIL_DOMAIN && !domain.endsWith("." + SYNTHETIC_EMAIL_DOMAIN);
}

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

type UserRow = {id:string;email:string;password_hash:string;created_at:string;email_verified:boolean};
function userFromRow(row:UserRow):User{
  return {id:row.id,email:row.email,passwordHash:row.password_hash,createdAt:row.created_at,emailVerified:row.email_verified!==false};
}

export async function findUserByEmail(email:string){
  const normalized=email.toLowerCase();
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<UserRow[]>`
      SELECT id,email,password_hash,created_at,email_verified
      FROM ${ydbQuery().identifier(getTable("users"))}
      WHERE email = ${normalized}
      LIMIT 1
    `;
    const row=rows?.[0];
    return row ? userFromRow(row) : null;
  }
  const users = await readJson<StoredUser[]>(usersFile, []);
  const user = users.find(item => item.email === normalized);
  return user ? normalizeUser(user) : null;
}

export async function getUser(userId:string){
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<UserRow[]>`
      SELECT id,email,password_hash,created_at,email_verified
      FROM ${ydbQuery().identifier(getTable("users"))}
      WHERE id = ${userId}
      LIMIT 1
    `;
    const row=rows?.[0];
    return row ? userFromRow(row) : null;
  }
  const users = await readJson<StoredUser[]>(usersFile, []);
  const user = users.find(item => item.id === userId);
  return user ? normalizeUser(user) : null;
}

/**
 * Идентичности всех аккаунтов — только id и email, без хешей и сессий. Нужны админ-снимку
 * инфраструктуры: в списке песочниц email стоит рядом с проектом, а не ищется запросом на строку.
 */
export async function listUserIdentities():Promise<Array<{id:string;email:string}>>{
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{id:string;email:string}>>`
      SELECT id,email
      FROM ${ydbQuery().identifier(getTable("users"))}
    `;
    return rows.map(row=>({id:row.id,email:row.email}));
  }
  const users=await readJson<StoredUser[]>(usersFile,[]);
  return users.map(user=>({id:user.id,email:user.email}));
}

/**
 * `emailVerified` по умолчанию true: так создаются аккаунты OAuth, телефона и демо. Только
 * регистрация по почте передаёт false и ждёт перехода по ссылке из письма.
 */
export async function createUser(email:string, password:string, options:{emailVerified?:boolean}={}){
  const normalized = email.trim().toLowerCase();
  if(await findUserByEmail(normalized)) throw new Error(EMAIL_TAKEN_MESSAGE);
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64) as Buffer;
  const emailVerified = options.emailVerified !== false;
  const user:User = {id:randomUUID(), email:normalized, passwordHash:salt + ":" + derived.toString("hex"), createdAt:new Date().toISOString(), emailVerified};
  if(isYdbEnabled()){
    try {
      await ydbQuery()`
        INSERT INTO ${ydbQuery().identifier(getTable("users"))}
          (id,email,password_hash,created_at,email_verified)
        VALUES (${user.id},${user.email},${user.passwordHash},${user.createdAt},${user.emailVerified})
      `;
    } catch (error) {
      if(await findUserByEmail(normalized)) throw new Error(EMAIL_TAKEN_MESSAGE);
      throw error;
    }
    return user;
  }
  const users = await readJson<StoredUser[]>(usersFile, []);
  users.push(user);
  await writeJson(usersFile, users);
  return user;
}

export type EmailVerification = { userId:string; tokenHash:string; expiresAt:string; sentAt:string };
export type EmailVerificationResult =
  | { status:"verified"; user:User }
  | { status:"expired" }
  | { status:"invalid" };

/** В ссылке лежит случайный токен; в базе — только его SHA-256, чтобы утечка файла не давала вход. */
export function hashEmailVerificationToken(token:string){
  return createHash("sha256").update(token).digest("hex");
}

/** Один актуальный токен на аккаунт: повторная отправка заменяет предыдущее письмо. */
export async function saveEmailVerification(record:EmailVerification){
  if(isYdbEnabled()){
    await ydbQuery()`
      UPSERT INTO ${ydbQuery().identifier(getTable("email_verifications"))}
        (user_id,token_hash,expires_at,sent_at)
      VALUES (${record.userId},${record.tokenHash},${record.expiresAt},${record.sentAt})
    `;
    return;
  }
  const records = await readJson<EmailVerification[]>(emailVerificationsFile, []);
  const next = records.filter(item => item.userId !== record.userId);
  next.push(record);
  await writeJson(emailVerificationsFile, next);
}

export async function getEmailVerification(userId:string):Promise<EmailVerification|null>{
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{user_id:string;token_hash:string;expires_at:string;sent_at:string}>>`
      SELECT user_id,token_hash,expires_at,sent_at
      FROM ${ydbQuery().identifier(getTable("email_verifications"))}
      WHERE user_id = ${userId}
      LIMIT 1
    `;
    const row=rows?.[0];
    return row ? {userId:row.user_id,tokenHash:row.token_hash,expiresAt:row.expires_at,sentAt:row.sent_at} : null;
  }
  const records = await readJson<EmailVerification[]>(emailVerificationsFile, []);
  return records.find(item => item.userId === userId) ?? null;
}

/** Поиск до погашения: пароль проверяется раньше, чтобы неверная попытка не сжигала ссылку. */
export async function findEmailVerificationByTokenHash(tokenHash:string):Promise<EmailVerification|null>{
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{user_id:string;token_hash:string;expires_at:string;sent_at:string}>>`
      SELECT user_id,token_hash,expires_at,sent_at
      FROM ${ydbQuery().identifier(getTable("email_verifications"))}
      WHERE token_hash = ${tokenHash}
      LIMIT 1
    `;
    const row=rows?.[0];
    return row ? {userId:row.user_id,tokenHash:row.token_hash,expiresAt:row.expires_at,sentAt:row.sent_at} : null;
  }
  const records = await readJson<EmailVerification[]>(emailVerificationsFile, []);
  return records.find(item => item.tokenHash === tokenHash) ?? null;
}

export async function deleteEmailVerification(userId:string){
  if(isYdbEnabled()){
    await ydbQuery()`DELETE FROM ${ydbQuery().identifier(getTable("email_verifications"))} WHERE user_id = ${userId}`;
    return;
  }
  const records = await readJson<EmailVerification[]>(emailVerificationsFile, []);
  await writeJson(emailVerificationsFile, records.filter(item => item.userId !== userId));
}

/**
 * Одноразовое погашение ссылки. В PostgreSQL удаление и есть проверка «токен ещё не использован»:
 * два одновременных перехода не могут оба получить строку. В JSON-режиме те же шаги выполняются
 * над файлом; сбой между удалением токена и отметкой пользователя лечится повторной отправкой.
 */
export async function consumeEmailVerification(tokenHash:string, now=Date.now()):Promise<EmailVerificationResult>{
  const stamp = new Date(now).toISOString();
  if(isYdbEnabled()){
    const [consumed]=await ydbQuery()<Array<{user_id:string}>>`
      DELETE FROM ${ydbQuery().identifier(getTable("email_verifications"))}
      WHERE token_hash = ${tokenHash} AND expires_at > ${stamp}
      RETURNING user_id
    `;
    const userId=consumed?.[0]?.user_id;
    if(!userId){
      const [expired]=await ydbQuery()<Array<{user_id:string}>>`
        SELECT user_id
        FROM ${ydbQuery().identifier(getTable("email_verifications"))}
        WHERE token_hash = ${tokenHash}
        LIMIT 1
      `;
      if(expired?.[0]){
        await ydbQuery()`DELETE FROM ${ydbQuery().identifier(getTable("email_verifications"))} WHERE token_hash = ${tokenHash}`;
        return {status:"expired"};
      }
      return {status:"invalid"};
    }
    await ydbQuery()`
      UPDATE ${ydbQuery().identifier(getTable("users"))}
      SET email_verified = TRUE
      WHERE id = ${userId}
    `;
    await ydbQuery()`DELETE FROM ${ydbQuery().identifier(getTable("email_verifications"))} WHERE user_id = ${userId}`;
    const user=await getUser(userId);
    return user ? {status:"verified",user} : {status:"invalid"};
  }

  const records = await readJson<EmailVerification[]>(emailVerificationsFile, []);
  const record = records.find(item => item.tokenHash === tokenHash);
  if(!record) return {status:"invalid"};
  if(Date.parse(record.expiresAt) <= now){
    await writeJson(emailVerificationsFile, records.filter(item => item.tokenHash !== tokenHash));
    return {status:"expired"};
  }
  await writeJson(emailVerificationsFile, records.filter(item => item.userId !== record.userId));
  const users = await readJson<StoredUser[]>(usersFile, []);
  const index = users.findIndex(item => item.id === record.userId);
  if(index < 0) return {status:"invalid"};
  users[index] = {...users[index], emailVerified:true};
  await writeJson(usersFile, users);
  return {status:"verified", user:normalizeUser(users[index])};
}

/**
 * Восстановление пароля. Устроено так же, как подтверждение почты: в ссылке случайный токен,
 * в хранилище — только его SHA-256, на аккаунт живёт один актуальный токен.
 *
 * Отдельная таблица, а не поле в `users`: неудачная отправка не должна трогать сам аккаунт,
 * а срок и одноразовость проверяются по записи токена.
 */
export type PasswordReset = { userId:string; tokenHash:string; expiresAt:string; sentAt:string };
export type PasswordResetTake =
  | { status:"ok"; userId:string }
  | { status:"expired" }
  | { status:"invalid" };

export function hashPasswordResetToken(token:string){
  return createHash("sha256").update(token).digest("hex");
}

/** Один актуальный токен на аккаунт: новый запрос заменяет предыдущее письмо. */
export async function savePasswordReset(record:PasswordReset){
  if(isYdbEnabled()){
    await ydbQuery()`
      UPSERT INTO ${ydbQuery().identifier(getTable("password_resets"))}
        (user_id,token_hash,expires_at,sent_at)
      VALUES (${record.userId},${record.tokenHash},${record.expiresAt},${record.sentAt})
    `;
    return;
  }
  const records = await readJson<PasswordReset[]>(passwordResetsFile, []);
  const next = records.filter(item => item.userId !== record.userId);
  next.push(record);
  await writeJson(passwordResetsFile, next);
}

export async function getPasswordReset(userId:string):Promise<PasswordReset|null>{
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{user_id:string;token_hash:string;expires_at:string;sent_at:string}>>`
      SELECT user_id,token_hash,expires_at,sent_at
      FROM ${ydbQuery().identifier(getTable("password_resets"))}
      WHERE user_id = ${userId}
      LIMIT 1
    `;
    const row=rows?.[0];
    return row ? {userId:row.user_id,tokenHash:row.token_hash,expiresAt:row.expires_at,sentAt:row.sent_at} : null;
  }
  const records = await readJson<PasswordReset[]>(passwordResetsFile, []);
  return records.find(item => item.userId === userId) ?? null;
}

export async function deletePasswordReset(userId:string){
  if(isYdbEnabled()){
    await ydbQuery()`DELETE FROM ${ydbQuery().identifier(getTable("password_resets"))} WHERE user_id = ${userId}`;
    return;
  }
  const records = await readJson<PasswordReset[]>(passwordResetsFile, []);
  await writeJson(passwordResetsFile, records.filter(item => item.userId !== userId));
}

/**
 * Одноразовое погашение ссылки. Сначала удаление, потом проверка срока: в PostgreSQL удаление
 * с условием `expires_at > now` и есть проверка «токен ещё жив и не использован», поэтому два
 * одновременных перехода не могут оба получить строку. Просроченная запись удаляется, чтобы
 * повторный переход отвечал «истёк», а не «недействителен».
 */
export async function takePasswordReset(tokenHash:string, now=Date.now()):Promise<PasswordResetTake>{
  const stamp = new Date(now).toISOString();
  if(isYdbEnabled()){
    const [consumed]=await ydbQuery()<Array<{user_id:string}>>`
      DELETE FROM ${ydbQuery().identifier(getTable("password_resets"))}
      WHERE token_hash = ${tokenHash} AND expires_at > ${stamp}
      RETURNING user_id
    `;
    const userId=consumed?.[0]?.user_id;
    if(userId) return {status:"ok",userId};
    const [expired]=await ydbQuery()<Array<{user_id:string}>>`
      SELECT user_id
      FROM ${ydbQuery().identifier(getTable("password_resets"))}
      WHERE token_hash = ${tokenHash}
      LIMIT 1
    `;
    if(expired?.[0]){
      await ydbQuery()`DELETE FROM ${ydbQuery().identifier(getTable("password_resets"))} WHERE token_hash = ${tokenHash}`;
      return {status:"expired"};
    }
    return {status:"invalid"};
  }
  const records = await readJson<PasswordReset[]>(passwordResetsFile, []);
  const record = records.find(item => item.tokenHash === tokenHash);
  if(!record) return {status:"invalid"};
  await writeJson(passwordResetsFile, records.filter(item => item.userId !== record.userId));
  return Date.parse(record.expiresAt) <= now ? {status:"expired"} : {status:"ok",userId:record.userId};
}

/** Новый пароль. `false` — аккаунта уже нет (например, удалён между запросом и переходом). */
export async function setUserPassword(userId:string, password:string):Promise<boolean>{
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64) as Buffer;
  const passwordHash = salt + ":" + derived.toString("hex");
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{id:string}>>`
      UPDATE ${ydbQuery().identifier(getTable("users"))}
      SET password_hash = ${passwordHash}
      WHERE id = ${userId}
      RETURNING id
    `;
    return Boolean(rows?.[0]?.id);
  }
  const users = await readJson<StoredUser[]>(usersFile, []);
  const index = users.findIndex(item => item.id === userId);
  if(index < 0) return false;
  users[index] = {...users[index], passwordHash};
  await writeJson(usersFile, users);
  return true;
}

/**
 * Переход по ссылке восстановления доказывает владение адресом, поэтому заодно снимает
 * неподтверждённость: иначе человек сменил бы пароль и всё равно не смог войти.
 */
export async function markEmailVerified(userId:string):Promise<void>{
  if(isYdbEnabled()){
    await ydbQuery()`
      UPDATE ${ydbQuery().identifier(getTable("users"))}
      SET email_verified = TRUE
      WHERE id = ${userId}
    `;
    return;
  }
  const users = await readJson<StoredUser[]>(usersFile, []);
  const index = users.findIndex(item => item.id === userId);
  if(index < 0) return;
  users[index] = {...users[index], emailVerified:true};
  await writeJson(usersFile, users);
}

export const DEMO_ACCOUNT = { email: "demo@webnestdev.local", password: "demo1234" };

/**
 * Shared demo account: NestDev seeds it on startup so a fresh install can be
 * opened without registering. Disabled in production unless WEBNESTDEV_DEMO_USER=1;
 * credentials can be overridden with WEBNESTDEV_DEMO_EMAIL / WEBNESTDEV_DEMO_PASSWORD.
 *
 * В production одного флага мало: пароль по умолчанию (`demo1234`) известен всем, и включённый
 * демо-аккаунт означал бы общий вход в платформу. Поэтому в production нужен свой пароль; без
 * него аккаунт не создаётся, а в лог уходит причина. Это закрывает P2 #17 из docs/SECURITY.md.
 */
export async function ensureDemoUser(){
  const email = process.env.WEBNESTDEV_DEMO_EMAIL?.trim().toLowerCase() || DEMO_ACCOUNT.email;
  const configured = process.env.WEBNESTDEV_DEMO_PASSWORD?.trim();
  const production = process.env.NODE_ENV === "production";
  if (production && (!configured || configured === DEMO_ACCOUNT.password)) {
    console.warn(
      "[auth] демо-аккаунт не создан: в production нужен свой WEBNESTDEV_DEMO_PASSWORD, " +
        "пароль по умолчанию известен и не годится для общего входа",
    );
    return { email, created: false };
  }
  const password = configured || DEMO_ACCOUNT.password;
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

/**
 * Последняя активность аккаунта по его сессиям. Нужна админке поддержки: по одному взгляду
 * видно, заходил ли человек недавно или пишет из старой вкладки. Пустые отметки старых сессий
 * пропускаются — они ничего не говорят о времени.
 */
export async function getUserLastSeenAt(userId:string):Promise<string|null>{
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{last_seen:string|null}>>`
      SELECT MAX(last_seen_at) AS last_seen
      FROM ${ydbQuery().identifier(getTable("sessions"))}
      WHERE user_id = ${userId} AND last_seen_at <> ''
    `;
    const value=rows?.[0]?.last_seen;
    if(!value)return null;
    const time=Date.parse(String(value));
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
  }
  const sessions = await readJson<StoredSession[]>(sessionsFile, []);
  let latest = 0;
  for(const session of sessions){
    if(session.userId!==userId||!session.lastSeenAt)continue;
    const time=Date.parse(session.lastSeenAt);
    if(Number.isFinite(time)&&time>latest)latest=time;
  }
  return latest ? new Date(latest).toISOString() : null;
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
