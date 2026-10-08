import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getSubscription } from "./account-store.js";
import { isYdbEnabled, ydbQuery, getTable } from "../storage/ydb.js";
import { limitsForPlan, type PlanId, type UsageKind, type UsageSnapshot } from "./plans.js";

const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
type UsageEvent = { id: string; userId: string; date: string; kind: UsageKind; createdAt: string };
const locks = new Map<string, Promise<unknown>>();

async function withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const current = previous.then(() => gate);
  locks.set(key, current);
  await previous;
  try { return await action(); }
  finally { release(); if (locks.get(key) === current) locks.delete(key); }
}
async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}
async function writeJsonAtomic(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  try { await writeFile(temp, JSON.stringify(value), { mode: 0o600 }); await rename(temp, file); }
  catch (error) { try { await unlink(temp); } catch {} throw error; }
}
function utcDay(now = new Date()) { return now.toISOString().slice(0, 10); }

export class UsageLimitError extends Error {
  readonly statusCode = 429;
  constructor(readonly kind: UsageKind, readonly limit: number, readonly used: number) {
    super(kind === "agentRuns" ? "Daily agent run limit reached" : "Daily browser check limit reached");
    this.name = "UsageLimitError";
  }
}

export async function getUsageSnapshot(userId: string, now = new Date()): Promise<UsageSnapshot> {
  const date = utcDay(now);
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{kind:string;used:number|string|bigint}>>`
      SELECT kind, used FROM ${ydbQuery().identifier(getTable("usage_counters"))}
      WHERE user_id = ${userId} AND usage_date = ${date}
    `;
    return {
      date,
      agentRuns: Number(rows.find(row => row.kind === "agentRuns")?.used ?? 0),
      browserChecks: Number(rows.find(row => row.kind === "browserChecks")?.used ?? 0),
    };
  }
  const events = await readJson<UsageEvent[]>(path.join(root, "account", "usage", date + ".json"), []);
  const own = events.filter(event => event.userId === userId && event.date === date);
  return { date, agentRuns: own.filter(event => event.kind === "agentRuns").length, browserChecks: own.filter(event => event.kind === "browserChecks").length };
}

export async function consumeUsage(userId: string, kind: UsageKind, plan: PlanId, now = new Date()): Promise<UsageSnapshot> {
  const date = utcDay(now);
  // JSON mode shares a daily file, so serialize all writers. YDB mode serializes per account in this process.
  const lockKey = isYdbEnabled() ? userId + ":" + date : "json:" + date;
  return withLock(lockKey, async () => {
    const limit = kind === "agentRuns" ? limitsForPlan(plan).agentRunsPerDay : limitsForPlan(plan).browserChecksPerDay;
    const event: UsageEvent = { id: randomUUID(), userId, date, kind, createdAt: now.toISOString() };
    if (isYdbEnabled()) {
      // Serializable read-write transaction: competing reservations conflict on the same counter key.
      // The SDK retries retryable conflicts, so every replica observes the committed counter value.
      const nextUsed = await ydbQuery().transaction({ idempotent: true }, async tx => {
        const [rows] = await tx<Array<{used:number|string|bigint}>>`
          SELECT used FROM ${tx.identifier(getTable("usage_counters"))}
          WHERE user_id = ${userId} AND usage_date = ${date} AND kind = ${kind}
          LIMIT 1
        `;
        const used = Number(rows[0]?.used ?? 0);
        if (used >= limit) throw new UsageLimitError(kind, limit, used);
        await tx`
          UPSERT INTO ${tx.identifier(getTable("usage_counters"))}
            (user_id, usage_date, kind, used)
          VALUES (${userId}, ${date}, ${kind}, ${used + 1})
        `;
        await tx`
          INSERT INTO ${tx.identifier(getTable("usage_events"))}
            (user_id, usage_date, event_id, kind, created_at)
          VALUES (${userId}, ${date}, ${event.id}, ${kind}, ${event.createdAt})
        `;
        return used + 1;
      });
      const snapshot = await getUsageSnapshot(userId, now);
      return { ...snapshot, [kind === "agentRuns" ? "agentRuns" : "browserChecks"]: nextUsed };
    }
    const snapshot = await getUsageSnapshot(userId, now);
    const used = kind === "agentRuns" ? snapshot.agentRuns : snapshot.browserChecks;
    if (used >= limit) throw new UsageLimitError(kind, limit, used);
    const file = path.join(root, "account", "usage", date + ".json");
    const events = await readJson<UsageEvent[]>(file, []);
    events.push(event);
    await writeJsonAtomic(file, events);
    return { ...snapshot, [kind === "agentRuns" ? "agentRuns" : "browserChecks"]: used + 1 };
  });
}

export async function consumeUsageForCurrentPlan(userId: string, kind: UsageKind, now = new Date()) {
  const subscription = await getSubscription(userId);
  const active = subscription.status === "demo_active" && subscription.expiresAt && Date.parse(subscription.expiresAt) > now.getTime();
  const plan: PlanId = active ? subscription.plan : "free";
  return consumeUsage(userId, kind, plan, now);
}
