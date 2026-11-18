/**
 * Дешёвый локальный бюджет запросов на ноду.
 *
 * Общие окна в PostgreSQL нужны для честности между двумя нодами, но каждое обращение к ним —
 * это запись в базу. При ботнете такая защита сама становится узким местом. Поэтому первый
 * барьер считается в памяти процесса: глобальный RPS, RPS на IP и RPS на сайт. PostgreSQL
 * остаётся вторым, более медленным уровнем для per-site/per-account бюджетов.
 *
 * Это token bucket, а не «не больше N в минуту»: короткий всплеск от нормального пользователя
 * не должен упираться в лимит, а устойчивый поток должен быстро приводить к 429. Состояние
 * живёт только на ноде и специально не переживает рестарт — это предохранитель, а не биллинг.
 */

import { availableParallelism } from "node:os";

export type LocalBudgetOptions = {
  globalRps: number;
  globalBurst: number;
  ipRps: number;
  ipBurst: number;
  siteRps: number;
  siteBurst: number;
  maxKeys: number;
};

export type LocalBudgetVerdict = { allowed: boolean; retryAfter: number };

type Bucket = { tokens: number; updatedAt: number };

function positiveInt(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/**
 * 4 CPU → 100 RPS на ноду, 2 CPU → 50 RPS. Это не функция и не статика: через дверь идут
 * только `/api/*` опубликованных сайтов, поэтому запас должен покрывать несколько сотен
 * активных сессий с редкими запросами.
 */
export function defaultGlobalRps(cpus = availableParallelism()) {
  return Math.max(50, Math.min(400, cpus * 25));
}

export function localBudgetOptions(
  env: NodeJS.ProcessEnv = process.env,
  cpus = availableParallelism(),
): LocalBudgetOptions {
  const globalRps = positiveInt(env.FUNCTIONS_LOCAL_GLOBAL_RPS, defaultGlobalRps(cpus), 1, 10_000);
  const ipRps = positiveInt(env.FUNCTIONS_LOCAL_IP_RPS, 10, 1, 1_000);
  const siteRps = positiveInt(env.FUNCTIONS_LOCAL_SITE_RPS, Math.max(10, cpus * 10), 1, 10_000);
  return {
    globalRps,
    globalBurst: positiveInt(env.FUNCTIONS_LOCAL_GLOBAL_BURST, globalRps * 2, 1, 20_000),
    ipRps,
    ipBurst: positiveInt(env.FUNCTIONS_LOCAL_IP_BURST, ipRps * 2, 1, 10_000),
    siteRps,
    siteBurst: positiveInt(env.FUNCTIONS_LOCAL_SITE_BURST, siteRps * 2, 1, 20_000),
    maxKeys: positiveInt(env.FUNCTIONS_LOCAL_MAX_KEYS, 50_000, 100, 1_000_000),
  };
}

export class LocalTokenBucket {
  private buckets = new Map<string, Bucket>();

  constructor(private readonly maxKeys = 50_000) {}

  /** Одна попытка. При отказе `retryAfter` — целые секунды до следующего токена. */
  take(key: string, ratePerSecond: number, burst: number, now = Date.now()): LocalBudgetVerdict {
    if (ratePerSecond <= 0 || burst <= 0) return { allowed: false, retryAfter: 1 };
    const current = this.buckets.get(key);
    let tokens = current ? current.tokens : burst;
    if (current) {
      const elapsed = Math.max(0, now - current.updatedAt) / 1000;
      tokens = Math.min(burst, tokens + elapsed * ratePerSecond);
    }
    if (tokens >= 1) {
      this.buckets.set(key, { tokens: tokens - 1, updatedAt: now });
      this.prune(now);
      return { allowed: true, retryAfter: 0 };
    }
    this.buckets.set(key, { tokens, updatedAt: now });
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((1 - tokens) / ratePerSecond)) };
  }

  /** Память под ботнет не растёт бесконечно: старые ключи удаляются, затем самые старые. */
  private prune(now: number) {
    if (this.buckets.size <= this.maxKeys) return;
    const staleBefore = now - 10 * 60_000;
    for (const [key, bucket] of this.buckets) {
      if (bucket.updatedAt < staleBefore) this.buckets.delete(key);
    }
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }

  reset() {
    this.buckets.clear();
  }
}

export const localBudget = new LocalTokenBucket(localBudgetOptions().maxKeys);

export function localBudgetKey(kind: "global" | "ip" | "site", value = "") {
  return kind + (value ? ":" + value : "");
}
