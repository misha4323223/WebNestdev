import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getTable, isYdbEnabled, ydbQuery } from "../storage/ydb.js";
import { limitsForPlan, type PlanId } from "./plans.js";

/**
 * Квота ресурсов хоста на аккаунт.
 *
 * Дневные лимиты запусков и кредиты считают то, что стоит платформе денег за токены. Но узкое
 * место единственной машины — не токены, а контейнеры: CPU, память и время. Поэтому здесь
 * отдельный счётчик — секунды жизни контейнеров песочницы (команды агента, установки, сборки).
 *
 * Считать секунды, а не «штуки команд», — единственный способ, при котором длинный `npm install`
 * и три быстрых `git status` не выглядят одинаково. CPU-минуты при этом оцениваются по времени
 * жизни контейнера: контейнер занимает место на всё время команды, даже если процесс ждёт сеть.
 *
 * Хранится в той же таблице `usage_counters`, что и дневные счётчики, но отдельным видом
 * (`sandboxSeconds`) и с накоплением, а не «+1». Схема не меняется, поэтому выкатка не требует
 * миграции: новая строка появляется при первом списании.
 *
 * Ошибка хранилища трактуется как «пропустить»: недоступная база не должна останавливать работу
 * всем аккаунтам сразу. Это тот же выбор, что у счётчиков частоты.
 */

export const SANDBOX_SECONDS_KIND = "sandboxSeconds";

/** Ошибка квоты ресурсов: 429 и текст, который человек видит в панели. */
export class SandboxQuotaError extends Error {
  readonly statusCode = 429;
  readonly code = "SANDBOX_QUOTA_EXCEEDED";
  constructor(
    readonly usedMinutes: number,
    readonly limitMinutes: number,
    readonly resetAt: string,
  ) {
    super(
      "Дневной лимит времени песочницы исчерпан: " +
        usedMinutes +
        " из " +
        limitMinutes +
        " минут. Лимит обновится " +
        resetAt +
        ". Команды, установки и сборки снова заработают после сброса; тариф с большим лимитом меняется в разделе «Тарифы». " +
        "Если вы считаете, что лимит израсходован не вами, напишите в поддержку.",
    );
    this.name = "SandboxQuotaError";
  }
}

/** Предел минут контейнеров в сутки по тарифу. */
export function sandboxMinutesLimitFor(plan: PlanId): number {
  return limitsForPlan(plan).resourceLimits.sandboxMinutesPerDay;
}

/**
 * Сколько контейнеров песочницы один аккаунт держит одновременно.
 *
 * `SANDBOX_MAX_PER_USER` переопределяет тариф: на маленькой ВМ администратору нужно уметь
 * поставить более строгое число, не меняя каталог. `0` — без ограничения на аккаунт (тогда
 * действует только потолок хоста `SANDBOX_MAX_CONCURRENT`).
 */
export function concurrentSandboxLimitFor(plan: PlanId): number {
  const raw = process.env.SANDBOX_MAX_PER_USER?.trim();
  if (raw === "0") return 0;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return limitsForPlan(plan).resourceLimits.concurrentSandbox;
}

function utcDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** Следующая полночь UTC: момент, когда дневной счётчик обнуляется. */
export function quotaResetAt(now = new Date()): Date {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next;
}

export function quotaResetLabel(now = new Date()): string {
  const next = quotaResetAt(now);
  const hours = Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 3_600_000));
  return "в 00:00 UTC (через " + hours + " ч)";
}

const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
const resourceFile = (date: string) => path.join(root, "account", "resources", date + ".json");

let fileGate: Promise<unknown> = Promise.resolve();
function withFileLock<T>(action: () => Promise<T>): Promise<T> {
  const next = fileGate.then(action, action);
  fileGate = next.catch(() => undefined);
  return next;
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    try {
      await unlink(temp);
    } catch {}
    throw error;
  }
}

/** Сколько секунд песочницы аккаунт израсходовал за UTC-сутки. */
export async function readSandboxSeconds(userId: string, now = new Date()): Promise<number> {
  const date = utcDay(now);
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{ used: number | string | bigint }>>`
      SELECT used FROM ${ydbQuery().identifier(getTable("usage_counters"))}
      WHERE user_id = ${userId} AND usage_date = ${date} AND kind = ${SANDBOX_SECONDS_KIND}
      LIMIT 1
    `;
    return Math.max(0, Number(rows[0]?.used ?? 0));
  }
  const all = await readJson<Record<string, number>>(resourceFile(date), {});
  return Math.max(0, Number(all[userId] ?? 0));
}

/**
 * Прибавляет израсходованное время одной записью. В PostgreSQL это `ON CONFLICT DO UPDATE` с
 * прибавлением, поэтому два контейнера одного аккаунта не затирают счёт друг друга, а вторая
 * реплика API видит то же число, что и первая.
 */
export async function addSandboxSeconds(userId: string, seconds: number, now = new Date()): Promise<void> {
  const amount = Math.max(0, Math.round(seconds));
  if (!amount) return;
  const date = utcDay(now);
  if (isYdbEnabled()) {
    const table = ydbQuery().identifier(getTable("usage_counters"));
    await ydbQuery()`
      INSERT INTO ${table} (user_id, usage_date, kind, used)
      VALUES (${userId}, ${date}, ${SANDBOX_SECONDS_KIND}, ${amount})
      ON CONFLICT (user_id, usage_date, kind) DO UPDATE SET
        used = ${table}.used + ${amount}
    `;
    return;
  }
  await withFileLock(async () => {
    const file = resourceFile(date);
    const all = await readJson<Record<string, number>>(file, {});
    all[userId] = Math.max(0, Number(all[userId] ?? 0)) + amount;
    await writeJsonAtomic(file, all);
  });
}

export type ResourceUsage = {
  date: string;
  sandboxSecondsUsed: number;
  sandboxMinutesUsed: number;
  sandboxMinutesLimit: number;
  concurrentLimit: number;
};

/** Состояние квоты для панели и для проверки перед запуском контейнера. */
export async function resourceUsageFor(userId: string, plan: PlanId, now = new Date()): Promise<ResourceUsage> {
  const seconds = await readSandboxSeconds(userId, now);
  return {
    date: utcDay(now),
    sandboxSecondsUsed: seconds,
    sandboxMinutesUsed: Math.floor(seconds / 60),
    sandboxMinutesLimit: sandboxMinutesLimitFor(plan),
    concurrentLimit: concurrentSandboxLimitFor(plan),
  };
}

/**
 * Проверка перед стартом контейнера. Ошибка хранилища пропускает запуск (fail-open) и пишет
 * причину в лог: квота — защита от злоупотребления, а не повод остановить платформу целиком.
 */
export async function assertSandboxBudget(userId: string, plan: PlanId, now = new Date()): Promise<void> {
  const limit = sandboxMinutesLimitFor(plan);
  if (!(limit > 0)) return;
  let used: number;
  try {
    used = await readSandboxSeconds(userId, now);
  } catch (error) {
    console.warn(
      "[quota] счётчик времени песочницы недоступен, проверка пропущена: " +
        (error instanceof Error ? error.message : String(error)),
    );
    return;
  }
  if (used < limit * 60) return;
  throw new SandboxQuotaError(Math.floor(used / 60), limit, quotaResetLabel(now));
}
