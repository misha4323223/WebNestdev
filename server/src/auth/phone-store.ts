import { createHash, randomBytes, randomInt } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isYdbEnabled, ydbQuery, getTable } from "../storage/ydb.js";
import { createUser, findUserByEmail, getUser, type User } from "./auth-store.js";

const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
const phonesFile = path.join(root, "auth", "phones.json");

export type PhoneAccount = { phone: string; userId: string; createdAt: string };

/**
 * Russian numbers only: 8XXXXXXXXXX, 7XXXXXXXXXX and the bare 10 digits all collapse
 * to +7XXXXXXXXXX, anything else is rejected before a code is generated.
 */
export function normalizePhone(input: string): string | null {
  const digits = (input ?? "").replace(/\D/g, "");
  if (!digits) return null;
  let value = digits;
  if (value.length === 11 && value.startsWith("8")) value = "7" + value.slice(1);
  else if (value.length === 10) value = "7" + value;
  if (value.length !== 11 || !value.startsWith("7")) return null;
  return "+" + value;
}

/** Readable form for messages and logs: +7 999 123-45-67. */
export function formatPhone(phone: string) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length !== 11) return phone;
  return "+" + digits[0] + " " + digits.slice(1, 4) + " " + digits.slice(4, 7) + "-" + digits.slice(7, 9) + "-" + digits.slice(9);
}

/**
 * A demo number that skips SMS entirely, so the phone flow can be used before an SMS
 * provider exists (or while Yandex Cloud is not connected yet). Same convention as the
 * demo e-mail account in auth-store: on by default outside production, opt-in in
 * production, and off whenever WEBNESTDEV_DEMO_PHONE_ENABLED=0.
 */
const DEFAULT_DEMO_PHONE = "+79990000000";

export function demoPhone(): string | null {
  const enabled = process.env.WEBNESTDEV_DEMO_PHONE_ENABLED
    ? process.env.WEBNESTDEV_DEMO_PHONE_ENABLED !== "0"
    : process.env.NODE_ENV !== "production";
  if (!enabled) return null;
  return normalizePhone(process.env.WEBNESTDEV_DEMO_PHONE?.trim() || DEFAULT_DEMO_PHONE);
}

async function readAccounts(): Promise<PhoneAccount[]> {
  try { return JSON.parse(await readFile(phonesFile, "utf8")) as PhoneAccount[]; }
  catch { return []; }
}

async function writeAccounts(accounts: PhoneAccount[]) {
  await mkdir(path.dirname(phonesFile), { recursive: true });
  await writeFile(phonesFile, JSON.stringify(accounts, null, 2), { mode: 0o600 });
}

export async function findUserIdByPhone(phone: string) {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{ user_id: string }>>`
      SELECT user_id FROM ${ydbQuery().identifier(getTable("phone_accounts"))}
      WHERE phone = ${phone}
      LIMIT 1
    `;
    return rows?.[0]?.user_id ?? null;
  }
  const accounts = await readAccounts();
  return accounts.find(account => account.phone === phone)?.userId ?? null;
}

/** The number an account signed in with, oldest link first. Null when it has none. */
export async function findPhoneByUserId(userId: string) {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{ phone: string }>>`
      SELECT phone FROM ${ydbQuery().identifier(getTable("phone_accounts"))}
      WHERE user_id = ${userId}
      ORDER BY created_at ASC
      LIMIT 1
    `;
    return rows?.[0]?.phone ?? null;
  }
  const accounts = await readAccounts();
  return accounts.find(account => account.userId === userId)?.phone ?? null;
}

export async function linkPhone(phone: string, userId: string) {
  if (isYdbEnabled()) {
    await ydbQuery()`
      UPSERT INTO ${ydbQuery().identifier(getTable("phone_accounts"))} (phone,user_id,created_at)
      VALUES (${phone},${userId},${new Date().toISOString()})
    `;
    return;
  }
  const accounts = await readAccounts();
  if (accounts.some(account => account.phone === phone)) return;
  accounts.push({ phone, userId, createdAt: new Date().toISOString() });
  await writeAccounts(accounts);
}

/**
 * A phone account is a normal user record. The email column is what the existing
 * storage links everything to, so a synthetic address derived from the number is used
 * and the password is a random string nobody knows: the SMS code is the only way in.
 */
export async function ensurePhoneAccount(phone: string): Promise<User> {
  const existingId = await findUserIdByPhone(phone);
  if (existingId) {
    const user = await getUser(existingId);
    if (user) return user;
  }
  const email = phone.replace(/\D/g, "") + "@phone.webnestdev.local";
  const byEmail = await findUserByEmail(email);
  const user = byEmail ?? await createUser(email, randomBytes(24).toString("hex"));
  await linkPhone(phone, user.id);
  return user;
}

type PendingCode = { salt: string; hash: string; expiresAt: number; attempts: number; sends: number[] };

const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const SEND_WINDOW_MS = 15 * 60 * 1000;
const MAX_SENDS_PER_WINDOW = 4;
const RESEND_COOLDOWN_MS = 45 * 1000;

/** Codes live in memory: they are short-lived, single-process state by design. */
const pending = new Map<string, PendingCode>();

function hashCode(salt: string, code: string) {
  return createHash("sha256").update(salt + ":" + code).digest("hex");
}

function prune(now = Date.now()) {
  for (const [phone, entry] of pending) {
    if (entry.expiresAt <= now && entry.sends.every(sentAt => now - sentAt > SEND_WINDOW_MS)) pending.delete(phone);
  }
}

export type StartResult =
  | { ok: true; code: string; expiresInSeconds: number }
  | { ok: false; retryAfterSeconds: number; error: string };

/**
 * Creates a fresh code for the number. The limits are what keeps a login endpoint from
 * becoming an SMS bomb: one code per cooldown, and a bounded number per window.
 */
export function startPhoneLogin(phone: string, now = Date.now()): StartResult {
  prune(now);
  const entry = pending.get(phone);
  const sends = (entry?.sends ?? []).filter(sentAt => now - sentAt < SEND_WINDOW_MS);
  const last = sends.at(-1);
  if (last !== undefined && now - last < RESEND_COOLDOWN_MS) {
    return { ok: false, retryAfterSeconds: Math.ceil((RESEND_COOLDOWN_MS - (now - last)) / 1000), error: "Код уже отправлен. Запросите новый через " + Math.ceil((RESEND_COOLDOWN_MS - (now - last)) / 1000) + " с." };
  }
  if (sends.length >= MAX_SENDS_PER_WINDOW) {
    return { ok: false, retryAfterSeconds: Math.ceil((SEND_WINDOW_MS - (now - sends[0])) / 1000), error: "Слишком много кодов для этого номера. Попробуйте позже." };
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const salt = randomBytes(12).toString("hex");
  pending.set(phone, { salt, hash: hashCode(salt, code), expiresAt: now + CODE_TTL_MS, attempts: 0, sends: [...sends, now] });
  return { ok: true, code, expiresInSeconds: Math.round(CODE_TTL_MS / 1000) };
}

export type VerifyResult = { ok: true } | { ok: false; error: string };

export function verifyPhoneCode(phone: string, code: string, now = Date.now()): VerifyResult {
  prune(now);
  const entry = pending.get(phone);
  if (!entry) return { ok: false, error: "Запросите новый код" };
  if (entry.expiresAt <= now) {
    pending.delete(phone);
    return { ok: false, error: "Код истёк. Запросите новый." };
  }
  if (entry.attempts >= MAX_ATTEMPTS) {
    pending.delete(phone);
    return { ok: false, error: "Слишком много попыток. Запросите новый код." };
  }
  const value = (code ?? "").replace(/\D/g, "");
  if (hashCode(entry.salt, value) !== entry.hash) {
    entry.attempts += 1;
    return { ok: false, error: "Неверный код" };
  }
  pending.delete(phone);
  return { ok: true };
}

/** Test helper: the codes are process state, so tests start from a clean map. */
export function clearPendingCodes() {
  pending.clear();
}
