import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getTable, initializeStorage, isYdbEnabled, ydbQuery } from "./pg.js";

/**
 * Счётчики частоты с общим состоянием.
 *
 * Раньше они лежали в `Map` внутри процесса (`auth/auth-rate-limit.ts`). Последствия были ровно
 * те, которых не должно быть у защиты от перебора: рестарт обнулял все окна (выкатка раз в день —
 * и лимит на вход обходится ожиданием деплоя), а вторая реплика API начинала считать попытки
 * заново, потому что видела только свои. Теперь окно живёт в PostgreSQL и растёт одной атомарной
 * записью — `INSERT … ON CONFLICT DO UPDATE`, поэтому два одновременных запроса не могут оба
 * увидеть «ещё можно».
 *
 * Режимы те же, что у остального хранилища: PostgreSQL в проде, файл в `WEBNESTDEV_DATA_DIR` для
 * локальной работы и тестов. В файловом режиме атомарности между процессами нет — там и процессов
 * обычно один; это ограничение, а не забытая деталь.
 *
 * Ошибка хранилища трактуется как «пропустить» (`fail-open`) с записью в лог: недоступная база не
 * должна запирать вход всем пользователям сразу. Это сознательный выбор в пользу доступности.
 */

export type RateLimitVerdict = { allowed: boolean; retryAfter: number };

type StoredBucket = { count: number; resetAt: number };

function file(): string {
  return path.join(process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev"), "rate-limits.json");
}

let fileGate: Promise<unknown> = Promise.resolve();

function withFileLock<T>(action: () => Promise<T>): Promise<T> {
  const next = fileGate.then(action, action);
  fileGate = next.catch(() => undefined);
  return next;
}

async function readBuckets(): Promise<Record<string, StoredBucket>> {
  try {
    const parsed = JSON.parse(await readFile(file(), "utf8")) as Record<string, StoredBucket>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeBuckets(buckets: Record<string, StoredBucket>): Promise<void> {
  const target = file();
  await mkdir(path.dirname(target), { recursive: true });
  const temp = target + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, JSON.stringify(buckets), { mode: 0o600 });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function verdict(count: number, resetAt: number, limit: number, now: number): RateLimitVerdict {
  if (count <= limit) return { allowed: true, retryAfter: 0 };
  return { allowed: false, retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000)) };
}

/**
 * Одна попытка. Возвращает, можно ли её пропустить, и через сколько секунд окно откроется снова.
 *
 * Порядок важен: счётчик увеличивается до сравнения с лимитом, иначе при лимите 8 проходила бы
 * девятая попытка. Ровно то же поведение было у прежней карты в памяти.
 */
export async function consumeRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): Promise<RateLimitVerdict> {
  const resetAt = now + windowMs;
  if (!isYdbEnabled()) {
    return withFileLock(async () => {
      const buckets = await readBuckets();
      const current = buckets[key];
      if (!current || current.resetAt <= now) {
        buckets[key] = { count: 1, resetAt };
        await writeBuckets(prune(buckets, now));
        return { allowed: limit >= 1, retryAfter: 0 };
      }
      current.count += 1;
      await writeBuckets(buckets);
      return verdict(current.count, current.resetAt, limit, now);
    });
  }

  await initializeStorage();
  const table = ydbQuery().identifier(getTable("rate_limits"));
  const [rows] = await ydbQuery()<Array<{ count: number | string; reset_at: number | string }>>`
    INSERT INTO ${table} (key, count, reset_at)
    VALUES (${key}, ${1}, ${resetAt})
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN ${table}.reset_at <= ${now} THEN ${1} ELSE ${table}.count + ${1} END,
      reset_at = CASE WHEN ${table}.reset_at <= ${now} THEN ${resetAt} ELSE ${table}.reset_at END
    RETURNING count, reset_at`;
  const row = rows[0];
  if (!row) throw new Error("счётчик не записался");
  // Просроченные строки убираются сами: без этого таблица росла бы каждым адресом, который
  // когда-либо пробовал войти. Один процент запросов — достаточно, чтобы мусор не копился.
  if (Math.random() < 0.01) {
    ydbQuery()`DELETE FROM ${table} WHERE reset_at < ${now - windowMs}`.catch(() => undefined);
  }
  return verdict(Number(row.count), Number(row.reset_at), limit, now);
}

function prune(buckets: Record<string, StoredBucket>, now: number): Record<string, StoredBucket> {
  const alive: Record<string, StoredBucket> = {};
  for (const [key, bucket] of Object.entries(buckets)) {
    if (bucket.resetAt > now) alive[key] = bucket;
  }
  return alive;
}

/** Сброс всех окон: нужен тестам и ручной разблокировке при разборе инцидента. */
export async function clearRateLimits(): Promise<void> {
  if (!isYdbEnabled()) {
    await withFileLock(async () => {
      await rm(file(), { force: true }).catch(() => undefined);
    });
    return;
  }
  await initializeStorage();
  const table = ydbQuery().identifier(getTable("rate_limits"));
  await ydbQuery()`DELETE FROM ${table}`;
}

/** Сколько сейчас активно окон — для админки и `/api/health`. */
export async function activeRateLimitWindows(now = Date.now()): Promise<number> {
  if (!isYdbEnabled()) {
    const buckets = await readBuckets();
    return Object.values(buckets).filter(bucket => bucket.resetAt > now).length;
  }
  await initializeStorage();
  const table = ydbQuery().identifier(getTable("rate_limits"));
  const [rows] = await ydbQuery()<Array<{ count: number | string }>>`
    SELECT COUNT(*) AS count FROM ${table} WHERE reset_at > ${now}`;
  return Number(rows[0]?.count ?? 0);
}
