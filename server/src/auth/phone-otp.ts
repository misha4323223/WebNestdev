import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isYdbEnabled, ydbQuery, getTable } from "../storage/ydb.js";

type Challenge = { phone: string; codeHash: string; expiresAt: string; resendAfter: string; attempts: number; createdAt: string };
const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
const challengeFile = path.join(root, "auth", "phone-otp-challenges.json");
const consentFile = path.join(root, "auth", "phone-consents.json");
const OTP_TTL_MS = 5 * 60_000;
const RESEND_DELAY_MS = 60_000;
const MAX_ATTEMPTS = 5;
const buckets = new Map<string, { count: number; resetAt: number }>();

export function normalizeRussianPhone(value: string): string | null {
  const digits = value.replace(/[\s().-]/g, "");
  let normalized = digits;
  if (/^8\d{10}$/.test(digits)) normalized = "7" + digits.slice(1);
  else if (/^\d{10}$/.test(digits)) normalized = "7" + digits;
  else if (/^\+7\d{10}$/.test(digits)) normalized = digits.slice(1);
  if (!/^7\d{10}$/.test(normalized)) return null;
  return "+" + normalized;
}

function secret(): string {
  const value = process.env.WEBNESTDEV_PHONE_OTP_SECRET ?? process.env.WEBNESTDEV_ENCRYPTION_KEY;
  if (!value || value.length < 32) throw new Error("WEBNESTDEV_PHONE_OTP_SECRET (32+ chars) is required for phone OTP");
  return value;
}
function hashCode(phone: string, code: string) {
  return createHmac("sha256", secret()).update(phone + ":" + code).digest("hex");
}
function allowLocal(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const item = buckets.get(key);
  if (!item || item.resetAt <= now) {
    if (buckets.size > 20_000) {
      for (const [bucketKey, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(bucketKey);
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (item.count >= limit) return false;
  item.count++;
  return true;
}
async function consumeRateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
  if (!isYdbEnabled()) return allowLocal(key, limit, windowMs);
  const sql = ydbQuery();
  const table = sql.identifier(getTable("phone_otp_limits"));
  const bucketKey = createHash("sha256").update(key).digest("hex");
  return sql.transaction({ idempotent: true }, async tx => {
    const [rows] = await tx<Array<{ request_count: number; reset_at: string }>>`
      SELECT request_count,reset_at FROM ${table} WHERE bucket_key = ${bucketKey} LIMIT 1
    `;
    const now = Date.now();
    const row = rows?.[0];
    const currentCount = row && Date.parse(row.reset_at) > now ? Number(row.request_count) : 0;
    const resetAt = row && Date.parse(row.reset_at) > now ? row.reset_at : new Date(now + windowMs).toISOString();
    if (currentCount >= limit) return false;
    await tx`
      UPSERT INTO ${table} (bucket_key,request_count,reset_at)
      VALUES (${bucketKey},${currentCount + 1},${resetAt})
    `;
    return true;
  });
}
export async function allowPhoneOtpRequest(phone: string, ip: string): Promise<boolean> {
  const phoneAllowed = await consumeRateLimit("phone:" + phone, 3, 60 * 60_000);
  if (!phoneAllowed) return false;
  return consumeRateLimit("ip:" + ip, 10, 60 * 60_000);
}
export async function allowPhoneOtpVerify(phone: string, ip: string): Promise<boolean> {
  const phoneAllowed = await consumeRateLimit("verify-phone:" + phone, 10, 15 * 60_000);
  if (!phoneAllowed) return false;
  return consumeRateLimit("verify-ip:" + ip, 30, 15 * 60_000);
}

export async function recordPhoneConsent(phone: string, ip: string, purpose: "sign_in" | "link_account"): Promise<void> {
  const record = {
    consentId: randomUUID(),
    phone,
    version: process.env.WEBNESTDEV_PHONE_CONSENT_VERSION ?? "phone-auth-v1",
    purpose,
    consentedAt: new Date().toISOString(),
    ipHash: createHash("sha256").update(ip).digest("hex"),
  };
  if (isYdbEnabled()) {
    await ydbQuery()`
      INSERT INTO ${ydbQuery().identifier(getTable("phone_consents"))}
        (consent_id,phone,consent_version,purpose,consented_at,ip_hash)
      VALUES (${record.consentId},${record.phone},${record.version},${record.purpose},${record.consentedAt},${record.ipHash})
    `;
    return;
  }
  await mkdir(path.dirname(consentFile), { recursive: true });
  let records: Array<typeof record> = [];
  try { records = JSON.parse(await readFile(consentFile, "utf8")) as typeof record[]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  records.push(record);
  await writeFile(consentFile, JSON.stringify(records), { mode: 0o600 });
}

async function readLocal(): Promise<Record<string, Challenge>> {
  try { return JSON.parse(await readFile(challengeFile, "utf8")) as Record<string, Challenge>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
}
async function writeLocal(value: Record<string, Challenge>) {
  await mkdir(path.dirname(challengeFile), { recursive: true });
  await writeFile(challengeFile, JSON.stringify(value), { mode: 0o600 });
}
async function getChallenge(phone: string): Promise<Challenge | null> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{phone:string;code_hash:string;expires_at:string;resend_after:string;attempts:number;created_at:string}>>`
      SELECT phone,code_hash,expires_at,resend_after,attempts,created_at
      FROM ${ydbQuery().identifier(getTable("phone_otp_challenges"))}
      WHERE phone = ${phone} LIMIT 1
    `;
    const row = rows?.[0];
    return row ? { phone: row.phone, codeHash: row.code_hash, expiresAt: row.expires_at, resendAfter: row.resend_after, attempts: Number(row.attempts), createdAt: row.created_at } : null;
  }
  return (await readLocal())[phone] ?? null;
}
async function saveChallenge(challenge: Challenge) {
  if (isYdbEnabled()) {
    await ydbQuery()`
      UPSERT INTO ${ydbQuery().identifier(getTable("phone_otp_challenges"))}
        (phone,code_hash,expires_at,resend_after,attempts,created_at)
      VALUES (${challenge.phone},${challenge.codeHash},${challenge.expiresAt},${challenge.resendAfter},${challenge.attempts},${challenge.createdAt})
    `;
    return;
  }
  const all = await readLocal();
  all[challenge.phone] = challenge;
  await writeLocal(all);
}
async function removeChallenge(phone: string) {
  if (isYdbEnabled()) {
    await ydbQuery()`DELETE FROM ${ydbQuery().identifier(getTable("phone_otp_challenges"))} WHERE phone = ${phone}`;
    return;
  }
  const all = await readLocal();
  delete all[phone];
  await writeLocal(all);
}

async function deliverSms(phone: string, code: string): Promise<void> {
  const mode = process.env.WEBNESTDEV_SMS_MODE ?? (process.env.NODE_ENV === "production" ? "smsru" : "disabled");
  if (mode === "console" && process.env.NODE_ENV !== "production") {
    // Local-only development helper; never enabled in production.
    console.info("[phone-otp] Local development code issued for a phone ending in", phone.slice(-4), ":", code);
    return;
  }
  if (mode !== "smsru") throw new Error("SMS delivery is not configured");
  const apiId = process.env.SMSRU_API_ID;
  if (!apiId) throw new Error("SMSRU_API_ID is required");
  const form = new URLSearchParams({
    api_id: apiId,
    to: phone.slice(1),
    msg: `Код входа WebNestdev: ${code}. Не сообщайте его никому.`,
    json: "1",
  });
  const response = await fetch("https://sms.ru/sms/send", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error("SMS provider request failed");
  const payload = await response.json() as {
    status?: string;
    status_code?: string | number;
    sms?: Record<string, { status?: string; status_code?: string | number }>;
  };
  const recipient = payload.sms?.[phone.slice(1)];
  if (payload.status !== "OK" || (payload.status_code && String(payload.status_code) !== "100") ||
      (recipient && (recipient.status !== "OK" || String(recipient.status_code) !== "100"))) {
    throw new Error("SMS provider rejected the request");
  }
  if (!recipient && !payload.status_code) throw new Error("SMS provider response was incomplete");
}

export async function requestPhoneOtp(phone: string): Promise<{ resendAfter: string }> {
  const existing = await getChallenge(phone);
  if (existing && Date.parse(existing.resendAfter) > Date.now()) {
    const error = new Error("Повторно запросить код можно через минуту.");
    Object.assign(error, { statusCode: 429 });
    throw error;
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const now = new Date();
  const challenge: Challenge = {
    phone,
    codeHash: hashCode(phone, code),
    expiresAt: new Date(now.getTime() + OTP_TTL_MS).toISOString(),
    resendAfter: new Date(now.getTime() + RESEND_DELAY_MS).toISOString(),
    attempts: 0,
    createdAt: now.toISOString(),
  };
  await saveChallenge(challenge);
  try { await deliverSms(phone, code); }
  catch (error) { await removeChallenge(phone); throw error; }
  return { resendAfter: challenge.resendAfter };
}

const challengeLocks = new Map<string, Promise<unknown>>();
async function withChallengeLock<T>(phone: string, action: () => Promise<T>): Promise<T> {
  const previous = challengeLocks.get(phone) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const current = previous.then(() => gate);
  challengeLocks.set(phone, current);
  await previous;
  try { return await action(); }
  finally { release(); if (challengeLocks.get(phone) === current) challengeLocks.delete(phone); }
}

function matchesCode(phone: string, code: string, expectedHash: string): boolean {
  const supplied = Buffer.from(hashCode(phone, code), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function verifyPhoneOtp(phone: string, code: string): Promise<boolean> {
  if (isYdbEnabled()) {
    const sql = ydbQuery();
    const table = sql.identifier(getTable("phone_otp_challenges"));
    return sql.transaction({ idempotent: true }, async tx => {
      const [rows] = await tx<Array<{phone:string;code_hash:string;expires_at:string;resend_after:string;attempts:number;created_at:string}>>`
        SELECT phone,code_hash,expires_at,resend_after,attempts,created_at
        FROM ${table} WHERE phone = ${phone} LIMIT 1
      `;
      const row = rows?.[0];
      if (!row) return false;
      const challenge: Challenge = { phone: row.phone, codeHash: row.code_hash, expiresAt: row.expires_at, resendAfter: row.resend_after, attempts: Number(row.attempts), createdAt: row.created_at };
      if (Date.parse(challenge.expiresAt) <= Date.now() || challenge.attempts >= MAX_ATTEMPTS) {
        await tx`DELETE FROM ${table} WHERE phone = ${phone}`;
        return false;
      }
      if (!matchesCode(phone, code, challenge.codeHash)) {
        await tx`
          UPSERT INTO ${table} (phone,code_hash,expires_at,resend_after,attempts,created_at)
          VALUES (${challenge.phone},${challenge.codeHash},${challenge.expiresAt},${challenge.resendAfter},${challenge.attempts + 1},${challenge.createdAt})
        `;
        return false;
      }
      await tx`DELETE FROM ${table} WHERE phone = ${phone}`;
      return true;
    });
  }
  return withChallengeLock(phone, async () => {
    const challenge = await getChallenge(phone);
    if (!challenge || Date.parse(challenge.expiresAt) <= Date.now() || challenge.attempts >= MAX_ATTEMPTS) {
      if (challenge && (Date.parse(challenge.expiresAt) <= Date.now() || challenge.attempts >= MAX_ATTEMPTS)) await removeChallenge(phone);
      return false;
    }
    if (!matchesCode(phone, code, challenge.codeHash)) {
      await saveChallenge({ ...challenge, attempts: challenge.attempts + 1 });
      return false;
    }
    await removeChallenge(phone);
    return true;
  });
}
