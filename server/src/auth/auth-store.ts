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
    const [rows]=await ydbQuery()<Array<{id:string;email:string;password_hash:string;created_at:string}>>\`
      SELECT id,email,password_hash,created_at
      FROM \${ydbQuery().identifier(getTable("users"))}
      WHERE email = \${normalized}
      LIMIT 1
    \`;
    const row=rows?.[0];
    return row ? {id:row.id,email:row.email,passwordHash:row.password_hash,createdAt:row.created_at} : null;
  }
  const users = await readJson<User[]>(usersFile, []);
  return users.find(user => user.email === normalized) ?? null;
}

export async function getUser(userId:string){
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{id:string;email:string;password_hash:string;created_at:string}>>\`
      SELECT id,email,password_hash,created_at
      FROM \${ydbQuery().identifier(getTable("users"))}
      WHERE id = \${userId}
      LIMIT 1
    \`;
    const row=rows?.[0];
    return row ? {id:row.id,email:row.email,passwordHash:row.password_hash,createdAt:row.created_at} : null;
  }
  const users = await readJson<User[]>(usersFile, []);
  return users.find(user => user.id === userId) ?? null;
}

export async function createUser(email:string, password:string){
  const normalized = email.trim().toLowerCase();
  if(await findUserByEmail(normalized)) throw new Error("Email already registered");
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64) as Buffer;
  const user:User = {id:randomUUID(), email:normalized, passwordHash:salt + ":" + derived.toString("hex"), createdAt:new Date().toISOString()};
  if(isYdbEnabled()){
    try {
      await ydbQuery()\`
        INSERT INTO \${ydbQuery().identifier(getTable("users"))}
          (id,email,password_hash,created_at)
        VALUES (\${user.id},\${user.email},\${user.passwordHash},\${user.createdAt})
      \`;
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
    await ydbQuery()\`
      INSERT INTO \${ydbQuery().identifier(getTable("sessions"))}
        (id,user_id,expires_at)
      VALUES (\${session.id},\${session.userId},\${session.expiresAt})
    \`;
    return session;
  }
  const sessions = await readJson<Session[]>(sessionsFile, []);
  sessions.push(session);
  await writeJson(sessionsFile, sessions);
  return session;
}

export async function getSession(sessionId:string){
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{id:string;user_id:string;expires_at:string}>>\`
      SELECT id,user_id,expires_at
      FROM \${ydbQuery().identifier(getTable("sessions"))}
      WHERE id = \${sessionId}
      LIMIT 1
    \`;
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
    await ydbQuery()\`DELETE FROM \${ydbQuery().identifier(getTable("sessions"))} WHERE id = \${sessionId}\`;
    return;
  }
  const sessions = await readJson<Session[]>(sessionsFile, []);
  await writeJson(sessionsFile, sessions.filter(item => item.id !== sessionId));
}
