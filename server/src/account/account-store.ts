import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { createHmac, randomUUID } from "node:crypto";
import path from "node:path";
import { isYdbEnabled, ydbQuery, getTable } from "../storage/ydb.js";
import { findPhoneByUserId } from "../auth/phone-store.js";
import { hashKey } from "../security/hash-key.js";

export type UserPreferences = {
  language: "ru" | "en";
  compactMode: boolean;
  emailNotifications: boolean;
  productUpdates: boolean;
};
export type PlanId = "free" | "pro" | "team";
export type Subscription = {
  userId: string;
  plan: PlanId;
  status: "free" | "demo_active" | "demo_expired" | "demo_cancelled";
  startedAt: string | null;
  expiresAt: string | null;
  updatedAt: string;
};
const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
const defaults: UserPreferences = { language: "ru", compactMode: false, emailNotifications: true, productUpdates: false };

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}
async function writeJsonAtomic(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  try { await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(temp, file); }
  catch (error) { try { await unlink(temp); } catch {} throw error; }
}
export async function getUserPreferences(userId: string): Promise<UserPreferences> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{user_id:string;language:string;compact_mode:boolean;email_notifications:boolean;product_updates:boolean}>>`
      SELECT user_id,language,compact_mode,email_notifications,product_updates
      FROM ${ydbQuery().identifier(getTable("user_settings"))} WHERE user_id = ${userId} LIMIT 1
    `;
    const row = rows?.[0];
    return row ? { language: row.language === "en" ? "en" : "ru", compactMode: Boolean(row.compact_mode), emailNotifications: Boolean(row.email_notifications), productUpdates: Boolean(row.product_updates) } : { ...defaults };
  }
  const all = await readJson<Record<string, UserPreferences>>(path.join(root, "account", "settings.json"), {});
  return { ...defaults, ...(all[userId] ?? {}) };
}
export async function saveUserPreferences(userId: string, preferences: UserPreferences) {
  if (isYdbEnabled()) {
    await ydbQuery()`
      UPSERT INTO ${ydbQuery().identifier(getTable("user_settings"))}
        (user_id,language,compact_mode,email_notifications,product_updates)
      VALUES (${userId},${preferences.language},${preferences.compactMode},${preferences.emailNotifications},${preferences.productUpdates})
    `;
    return preferences;
  }
  const file = path.join(root, "account", "settings.json");
  const all = await readJson<Record<string, UserPreferences>>(file, {});
  all[userId] = preferences;
  await writeJsonAtomic(file, all);
  return preferences;
}
export async function getSubscription(userId: string): Promise<Subscription> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{user_id:string;plan:string;status:string;started_at:string;expires_at:string;updated_at:string}>>`
      SELECT user_id,plan,status,started_at,expires_at,updated_at
      FROM ${ydbQuery().identifier(getTable("subscriptions"))} WHERE user_id = ${userId} LIMIT 1
    `;
    const row = rows?.[0];
    if (!row) return { userId, plan: "free", status: "free", startedAt: null, expiresAt: null, updatedAt: new Date(0).toISOString() };
    const subscription: Subscription = { userId: row.user_id, plan: row.plan as PlanId, status: row.status as Subscription["status"], startedAt: row.started_at || null, expiresAt: row.expires_at || null, updatedAt: row.updated_at };
    const normalized = expireIfNeeded(subscription);
    if (normalized.status !== subscription.status) await saveSubscription(normalized);
    return normalized;
  }
  const all = await readJson<Record<string, Subscription>>(path.join(root, "account", "subscriptions.json"), {});
  const subscription = all[userId] ?? { userId, plan: "free" as const, status: "free" as const, startedAt: null, expiresAt: null, updatedAt: new Date(0).toISOString() };
  const normalized = expireIfNeeded(subscription);
  if (normalized.status !== subscription.status) await saveSubscription(normalized);
  return normalized;
}
function expireIfNeeded(subscription: Subscription): Subscription {
  if (subscription.status === "demo_active" && subscription.expiresAt && Date.parse(subscription.expiresAt) <= Date.now()) {
    return { ...subscription, plan: "free", status: "demo_expired", updatedAt: new Date().toISOString() };
  }
  return subscription;
}
export async function saveSubscription(subscription: Subscription) {
  if (isYdbEnabled()) {
    await ydbQuery()`
      UPSERT INTO ${ydbQuery().identifier(getTable("subscriptions"))}
        (user_id,plan,status,started_at,expires_at,updated_at)
      VALUES (${subscription.userId},${subscription.plan},${subscription.status},${subscription.startedAt ?? ""},${subscription.expiresAt ?? ""},${subscription.updatedAt})
    `;
    return subscription;
  }
  const file = path.join(root, "account", "subscriptions.json");
  const all = await readJson<Record<string, Subscription>>(file, {});
  all[subscription.userId] = subscription;
  await writeJsonAtomic(file, all);
  return subscription;
}

/** The demo plan is a one-time entitlement per verified phone number. */
export class DemoAlreadyClaimedError extends Error {
  readonly statusCode = 409;
  constructor() {
    super("Demo access has already been claimed for this phone number");
    this.name = "DemoAlreadyClaimedError";
  }
}

/** A demo cannot be attached to an account that has no verified number behind it. */
export class PhoneVerificationRequiredError extends Error {
  readonly statusCode = 403;
  constructor() {
    super("A verified phone number is required to claim a demo");
    this.name = "PhoneVerificationRequiredError";
  }
}

/**
 * The claim is keyed by the number, not by the account, so the same number cannot
 * collect the demo twice. The number itself is never stored in the claim: only its
 * HMAC, keyed by a server secret (WEBNESTDEV_TRIAL_CLAIM_SECRET in production).
 */
function phoneDemoClaimKey(phone: string): string {
  const key = hashKey(process.env.WEBNESTDEV_TRIAL_CLAIM_SECRET, "WEBNESTDEV_TRIAL_CLAIM_SECRET");
  return createHmac("sha256", key).update(phone).digest("hex");
}

const demoClaimLocks = new Map<string, Promise<unknown>>();

/** Serializes claims for one key, so two parallel requests cannot both win the race. */
async function withDemoClaimLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = demoClaimLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const current = previous.then(() => gate);
  demoClaimLocks.set(key, current);
  await previous;
  try { return await action(); }
  finally { release(); if (demoClaimLocks.get(key) === current) demoClaimLocks.delete(key); }
}

/**
 * Activates the demo plan once per phone number. Both backends check the claim and
 * write the subscription together — a transaction in PostgreSQL, a lock plus the
 * two JSON files locally — so a repeated request is refused with 409 instead of
 * handing out another 30 days.
 */
export async function activateDemoOnce(userId: string, plan: Exclude<PlanId, "free">, now = new Date()): Promise<Subscription> {
  const phone = await findPhoneByUserId(userId);
  if (!phone) throw new PhoneVerificationRequiredError();
  const claimKey = phoneDemoClaimKey(phone);
  const subscription: Subscription = {
    userId,
    plan,
    status: "demo_active",
    startedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: now.toISOString(),
  };
  if (isYdbEnabled()) {
    const sql = ydbQuery();
    const subscriptions = sql.identifier(getTable("subscriptions"));
    const claims = sql.identifier(getTable("demo_claims"));
    try {
      await sql.transaction({ idempotent: true }, async tx => {
        const [claimed] = await tx<Array<{ claim_key: string }>>`
          SELECT claim_key FROM ${claims} WHERE claim_key = ${claimKey} LIMIT 1
        `;
        if (claimed.length) throw new DemoAlreadyClaimedError();
        await tx`
          INSERT INTO ${claims} (claim_key,user_id,claimed_at)
          VALUES (${claimKey},${userId},${now.toISOString()})
        `;
        await tx`
          UPSERT INTO ${subscriptions}
            (user_id,plan,status,started_at,expires_at,updated_at)
          VALUES (${subscription.userId},${subscription.plan},${subscription.status},${subscription.startedAt ?? ""},${subscription.expiresAt ?? ""},${subscription.updatedAt})
        `;
      });
    } catch (error) {
      if (error instanceof DemoAlreadyClaimedError) throw error;
      // A unique-key violation means a parallel request claimed it first.
      const [claimed] = await sql<Array<{ claim_key: string }>>`
        SELECT claim_key FROM ${claims} WHERE claim_key = ${claimKey} LIMIT 1
      `;
      if (claimed.length) throw new DemoAlreadyClaimedError();
      throw error;
    }
    return subscription;
  }
  return withDemoClaimLock("demo:" + claimKey, async () => {
    const file = path.join(root, "account", "subscriptions.json");
    const claimsFile = path.join(root, "account", "demo-claims.json");
    const all = await readJson<Record<string, Subscription>>(file, {});
    const claims = await readJson<Record<string, { userId: string; claimedAt: string }>>(claimsFile, {});
    const current = all[userId];
    if (claims[claimKey] || (current && current.status !== "free")) throw new DemoAlreadyClaimedError();
    claims[claimKey] = { userId, claimedAt: now.toISOString() };
    await writeJsonAtomic(claimsFile, claims);
    all[userId] = subscription;
    await writeJsonAtomic(file, all);
    return subscription;
  });
}
