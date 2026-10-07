import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

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
  const users = await readJson<User[]>(usersFile, []);
  return users.find(user => user.email === email.toLowerCase()) ?? null;
}
export async function getUser(userId:string){
  const users = await readJson<User[]>(usersFile, []);
  return users.find(user => user.id === userId) ?? null;
}
export async function createUser(email:string, password:string){
  const normalized = email.trim().toLowerCase();
  if(await findUserByEmail(normalized)) throw new Error("Email already registered");
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64) as Buffer;
  const user:User = {id:randomUUID(), email:normalized, passwordHash:salt + ":" + derived.toString("hex"), createdAt:new Date().toISOString()};
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
  const sessions = await readJson<Session[]>(sessionsFile, []);
  const session:Session = {id:randomBytes(32).toString("hex"), userId, expiresAt:new Date(Date.now()+1000*60*60*24*30).toISOString()};
  sessions.push(session);
  await writeJson(sessionsFile, sessions);
  return session;
}
export async function getSession(sessionId:string){
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
  const sessions = await readJson<Session[]>(sessionsFile, []);
  await writeJson(sessionsFile, sessions.filter(item => item.id !== sessionId));
}
