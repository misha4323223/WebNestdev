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

export type User = { id:string; email:string; passwordHash:string; createdAt:string; phone?: string };
type Session = { id:string; userId:string; expiresAt:string };

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

export async function getUser(userId:string): Promise<User | null> {
  let user: User | null;
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{id:string;email:string;password_hash:string;created_at:string}>>`
      SELECT id,email,password_hash,created_at
      FROM ${ydbQuery().identifier(getTable("users"))}
      WHERE id = ${userId}
      LIMIT 1
    `;
    const row=rows?.[0];
    user = row ? {id:row.id,email:row.email,passwordHash:row.password_hash,createdAt:row.created_at} : null;
  } else {
    const users = await readJson<User[]>(usersFile, []);
    user = users.find(item => item.id === userId) ?? null;
  }
  if (!user) return null;
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{ phone: string }>>`
      SELECT phone FROM ${ydbQuery().identifier(getTable("phone_identities"))}
      WHERE user_id = ${userId} LIMIT 1
    `;
    return rows?.[0] ? { ...user, phone: rows[0].phone } : user;
  }
  const identities = await readJson<Record<string, string>>(path.join(usersDir, "phone-identities.json"), {});
  const phone = Object.entries(identities).find(([, id]) => id === userId)?.[0];
  return phone ? { ...user, phone } : user;
}

export async function createUser(email:string, password:string){
  const normalized = email.trim().toLowerCase();
  if(await findUserByEmail(normalized)) throw new Error("Email already registered");
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
      if(await findUserByEmail(normalized)) throw new Error("Email already registered");
      throw error;
    }
    return user;
  }
  const users = await readJson<User[]>(usersFile, []);
  users.push(user);
  await writeJson(usersFile, users);
  return user;
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

export async function createSession(userId:string){
  const session:Session = {id:randomBytes(32).toString("hex"), userId, expiresAt:new Date(Date.now()+1000*60*60*24*30).toISOString()};
  if(isYdbEnabled()){
    await ydbQuery()`
      INSERT INTO ${ydbQuery().identifier(getTable("sessions"))}
        (id,user_id,expires_at)
      VALUES (${session.id},${session.userId},${session.expiresAt})
    `;
    return session;
  }
  const sessions = await readJson<Session[]>(sessionsFile, []);
  sessions.push(session);
  await writeJson(sessionsFile, sessions);
  return session;
}

export async function getSession(sessionId:string){
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{id:string;user_id:string;expires_at:string}>>`
      SELECT id,user_id,expires_at
      FROM ${ydbQuery().identifier(getTable("sessions"))}
      WHERE id = ${sessionId}
      LIMIT 1
    `;
    const row=rows?.[0];
    if(!row)return null;
    const session:Session={id:row.id,userId:row.user_id,expiresAt:row.expires_at};
    if(Date.parse(session.expiresAt)<=Date.now()){
      await deleteSession(session.id);
      return null;
    }
    return session;
  }
  const sessions = await readJson<Session[]>(sessionsFile, []);
  const session = sessions.find(item => item.id === sessionId);
  if(!session) return null;
  if(Date.parse(session.expiresAt) <= Date.now()){
    await writeJson(sessionsFile, sessions.filter(item => item.id !== sessionId));
    return null;
  }
  return session;
}

export async function deleteSession(sessionId:string){
  if(isYdbEnabled()){
    await ydbQuery()`DELETE FROM ${ydbQuery().identifier(getTable("sessions"))} WHERE id = ${sessionId}`;
    return;
  }
  const sessions = await readJson<Session[]>(sessionsFile, []);
  await writeJson(sessionsFile, sessions.filter(item => item.id !== sessionId));
}


export async function findUserByPhone(phone: string): Promise<User | null> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{ user_id: string }>>`
      SELECT user_id FROM ${ydbQuery().identifier(getTable("phone_identities"))}
      WHERE phone = ${phone} LIMIT 1
    `;
    if (!rows?.[0]) return null;
    const user = await getUser(rows[0].user_id);
    return user ? { ...user, phone } : null;
  }
  const identities = await readJson<Record<string, string>>(path.join(usersDir, "phone-identities.json"), {});
  const userId = identities[phone];
  if (!userId) return null;
  const user = await getUser(userId);
  return user ? { ...user, phone } : null;
}

export async function createPhoneUser(phone: string): Promise<User> {
  const id = randomUUID();
  const emailKey = createHash("sha256").update(phone).digest("hex");
  const now = new Date().toISOString();
  const salt = randomBytes(16).toString("hex");
  const passwordHash = salt + ":" + randomBytes(64).toString("hex");
  const user: User = { id, email: `phone_${emailKey}@phone.webnestdev.invalid`, passwordHash, createdAt: now, phone };
  if (isYdbEnabled()) {
    const sql = ydbQuery();
    const users = sql.identifier(getTable("users"));
    const identities = sql.identifier(getTable("phone_identities"));
    await sql.transaction({ idempotent: true }, async tx => {
      await tx`INSERT INTO ${users} (id,email,password_hash,created_at) VALUES (${user.id},${user.email},${user.passwordHash},${user.createdAt})`;
      await tx`INSERT INTO ${identities} (phone,user_id,verified_at) VALUES (${phone},${user.id},${now})`;
    });
    return user;
  }
  const lockKey = "phone:" + phone;
  return withAuthStoreLock(lockKey, async () => {
    const existing = await findUserByPhone(phone);
    if (existing) return existing;
    const users = await readJson<User[]>(usersFile, []);
    users.push({ id: user.id, email: user.email, passwordHash: user.passwordHash, createdAt: user.createdAt });
    await writeJson(usersFile, users);
    const identitiesFile = path.join(usersDir, "phone-identities.json");
    const identities = await readJson<Record<string, string>>(identitiesFile, {});
    identities[phone] = user.id;
    await writeJson(identitiesFile, identities);
    return user;
  });
}

const authStoreLocks = new Map<string, Promise<unknown>>();
async function withAuthStoreLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = authStoreLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const current = previous.then(() => gate);
  authStoreLocks.set(key, current);
  await previous;
  try { return await action(); }
  finally { release(); if (authStoreLocks.get(key) === current) authStoreLocks.delete(key); }
}


export class PhoneAlreadyLinkedError extends Error {
  constructor() { super("Phone number is already linked to another account"); this.name = "PhoneAlreadyLinkedError"; }
}

export async function linkPhoneToUser(phone: string, userId: string): Promise<void> {
  if (isYdbEnabled()) {
    const sql = ydbQuery();
    const identities = sql.identifier(getTable("phone_identities"));
    await sql.transaction({ idempotent: true }, async tx => {
      const [rows] = await tx<Array<{ user_id: string }>>`
        SELECT user_id FROM ${identities} WHERE phone = ${phone} LIMIT 1
      `;
      if (rows[0] && rows[0].user_id !== userId) throw new PhoneAlreadyLinkedError();
      if (!rows[0]) await tx`INSERT INTO ${identities} (phone,user_id,verified_at) VALUES (${phone},${userId},${new Date().toISOString()})`;
    });
    return;
  }
  await withAuthStoreLock("phone:" + phone, async () => {
    const identitiesFile = path.join(usersDir, "phone-identities.json");
    const identities = await readJson<Record<string, string>>(identitiesFile, {});
    if (identities[phone] && identities[phone] !== userId) throw new PhoneAlreadyLinkedError();
    identities[phone] = userId;
    await writeJson(identitiesFile, identities);
  });
}
