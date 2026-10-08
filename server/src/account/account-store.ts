import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { isYdbEnabled, ydbQuery, getTable } from "../storage/ydb.js";

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

export class DemoAlreadyClaimedError extends Error {
  readonly statusCode = 409;
  constructor() {
    super("Demo access has already been claimed for this account");
    this.name = "DemoAlreadyClaimedError";
  }
}

const subscriptionLocks = new Map<string, Promise<unknown>>();
async function withSubscriptionLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = subscriptionLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const current = previous.then(() => gate);
  subscriptionLocks.set(key, current);
  await previous;
  try { return await action(); }
  finally { release(); if (subscriptionLocks.get(key) === current) subscriptionLocks.delete(key); }
}

export class PhoneVerificationRequiredError extends Error {
  constructor() {
    super("A verified phone number is required to claim a demo");
    this.name = "PhoneVerificationRequiredError";
  }
}

export async function activateDemoOnce(userId: string, plan: Exclude<PlanId, "free">, now = new Date()): Promise<Subscription> {
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
    const identities = sql.identifier(getTable("phone_identities"));
    const claims = sql.identifier(getTable("demo_claims"));
    try {
      await sql.transaction({ idempotent: true }, async tx => {
        const [identityRows] = await tx<Array<{ phone: string }>>`
          SELECT phone FROM ${identities} WHERE user_id = ${userId} LIMIT 1
        `;
        const phone = identityRows?.[0]?.phone;
        if (!phone) throw new PhoneVerificationRequiredError();
        const claimKey = createHash("sha256").update(phone).digest("hex");
        const [claimRows] = await tx<Array<{ claim_key: string }>>`
          SELECT claim_key FROM ${claims} WHERE claim_key = ${claimKey} LIMIT 1
        `;
        if (claimRows.length) throw new DemoAlreadyClaimedError();
        const [subscriptionRows] = await tx<Array<{ status: string }>>`
          SELECT status FROM ${subscriptions} WHERE user_id = ${userId} LIMIT 1
        `;
        if (subscriptionRows[0] && subscriptionRows[0].status !== "free") throw new DemoAlreadyClaimedError();
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
      if (error instanceof DemoAlreadyClaimedError || error instanceof PhoneVerificationRequiredError) throw error;
      throw error;
    }
    return subscription;
  }
  const identities = await readJson<Record<string, string>>(path.join(root, "auth", "phone-identities.json"), {});
  const phone = Object.entries(identities).find(([, id]) => id === userId)?.[0];
  if (!phone) throw new PhoneVerificationRequiredError();
  const claimKey = createHash("sha256").update(phone).digest("hex");
  return withSubscriptionLock("demo:" + claimKey, async () => {
    const file = path.join(root, "account", "subscriptions.json");
    const claimsFile = path.join(root, "account", "demo-claims.json");
    const all = await readJson<Record<string, Subscription>>(file, {});
    const demoClaims = await readJson<Record<string, { userId: string; claimedAt: string }>>(claimsFile, {});
    const current = all[userId];
    if (demoClaims[claimKey] || (current && current.status !== "free")) throw new DemoAlreadyClaimedError();
    demoClaims[claimKey] = { userId, claimedAt: now.toISOString() };
    await writeJsonAtomic(claimsFile, demoClaims);
    all[userId] = subscription;
    await writeJsonAtomic(file, all);
    return subscription;
  });
}
