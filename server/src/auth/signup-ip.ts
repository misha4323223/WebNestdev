import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getTable, initializeStorage, isYdbEnabled, ydbQuery } from "../storage/ydb.js";

/**
 * Сколько аккаунтов создано с одного IP-адреса.
 *
 * Окно частоты (`auth/auth-rate-limit.ts`) отвечает на «не веер ли это за пятнадцать минут», но
 * не на «не завёл ли человек пятьдесят аккаунтов за неделю». Для бесплатного тарифа второе важнее
 * первого: аккаунт живёт долго, а значит и ограничение должно жить долго.
 *
 * Поэтому счётчик **постоянный**, а не суточный: суточное окно обходится регистрацией по одному
 * аккаунту в день — ровно та стратегия, от которой это правило и защищает.
 *
 * Учёт — по созданным аккаунтам (почта и телефон), а не по успешным входам: неподтверждённый
 * аккаунт тоже занимает адрес почты и место в базе, и считать его «несуществующим» значило бы
 * разрешать создавать их пачками. Счётчик не уменьшается при удалении аккаунта: иначе правило
 * обходится циклом «создал — удалил».
 *
 * Хранилище: таблица `signup_ips` в PostgreSQL (общая у реплик, прибавление одной атомарной
 * записью) и JSON-файл в `WEBNESTDEV_DATA_DIR` для локальной работы и тестов. Сбой хранилища
 * трактуется как «пропустить» на уровне маршрута: недоступная база не должна закрывать
 * регистрацию всем сразу.
 */

/** Предел по умолчанию: три аккаунта с одного адреса. */
export const DEFAULT_SIGNUP_IP_LIMIT = 3;

/** Текст отказа. Лимит берётся текущий, чтобы сообщение не врало после `SIGNUP_IP_LIMIT`. */
export function signupIpExceededMessage(limit = signupIpLimit()): string {
  return (
    "С этого IP-адреса уже создано " + limit + " аккаунта — больше не регистрируем. " +
    "Бесплатным тарифом можно пользоваться с одного аккаунта; если аккаунты создавали не вы " +
    "или нужен ещё один по делу, напишите в поддержку — проверим и поможем."
  );
}

/**
 * `SIGNUP_IP_LIMIT` меняет предел без правки кода (например, на время теста или для партнёрской
 * площадки с общим NAT). `0` — без ограничения по адресу.
 */
export function signupIpLimit(): number {
  const raw = process.env.SIGNUP_IP_LIMIT?.trim();
  if (raw === "0") return 0;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return DEFAULT_SIGNUP_IP_LIMIT;
}

export type SignupIpReservation =
  | { allowed: true; used: number }
  | { allowed: false; used: number; limit: number };

type StoredIp = { accounts: number; firstAt: string; lastAt: string };

const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
const storeFile = () => path.join(root, "signup-ips.json");

let fileGate: Promise<unknown> = Promise.resolve();
function withFileLock<T>(action: () => Promise<T>): Promise<T> {
  const next = fileGate.then(action, action);
  fileGate = next.catch(() => undefined);
  return next;
}

async function readStore(): Promise<Record<string, StoredIp>> {
  try {
    const parsed = JSON.parse(await readFile(storeFile(), "utf8")) as Record<string, StoredIp>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeStore(value: Record<string, StoredIp>) {
  const target = storeFile();
  await mkdir(path.dirname(target), { recursive: true });
  const temp = target + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Адрес в том виде, в котором его видит сервер: пустой адрес считаем отдельным «неизвестным». */
export function normalizeSignupIp(ip: string | undefined): string {
  const value = (ip ?? "").trim().replace(/^\[|\]$/g, "");
  return value || "unknown";
}

/** Сколько аккаунтов уже создано с адреса. */
export async function signupIpAccounts(ip: string): Promise<number> {
  const key = normalizeSignupIp(ip);
  if (isYdbEnabled()) {
    await initializeStorage();
    const [rows] = await ydbQuery()<Array<{ accounts: number | string | bigint }>>`
      SELECT accounts FROM ${ydbQuery().identifier(getTable("signup_ips"))}
      WHERE ip = ${key}
      LIMIT 1
    `;
    return Math.max(0, Number(rows[0]?.accounts ?? 0));
  }
  const stored = (await readStore())[key];
  return Math.max(0, Number(stored?.accounts ?? 0));
}

/**
 * Занять место под новый аккаунт.
 *
 * Прибавление и сравнение — одна атомарная запись, поэтому две одновременные регистрации с
 * одного адреса не могут обе увидеть «ещё можно». Если лимит уже исчерпан, прибавление сразу
 * откатывается: иначе счётчик рос бы каждым отказом и «третьим» аккаунтом нельзя было бы
 * стать никогда.
 */
export async function reserveSignupIp(
  ip: string,
  limit = signupIpLimit(),
  now = Date.now(),
): Promise<SignupIpReservation> {
  const key = normalizeSignupIp(ip);
  if (limit <= 0) return { allowed: true, used: await signupIpAccounts(key) };
  const at = new Date(now).toISOString();

  if (isYdbEnabled()) {
    await initializeStorage();
    const table = ydbQuery().identifier(getTable("signup_ips"));
    const [rows] = await ydbQuery()<Array<{ accounts: number | string | bigint }>>`
      INSERT INTO ${table} (ip, accounts, first_at, last_at)
      VALUES (${key}, ${1}, ${at}, ${at})
      ON CONFLICT (ip) DO UPDATE SET
        accounts = ${table}.accounts + 1,
        last_at = ${at}
      RETURNING accounts
    `;
    const used = Math.max(1, Number(rows[0]?.accounts ?? 1));
    if (used <= limit) return { allowed: true, used };
    await ydbQuery()`
      UPDATE ${table} SET accounts = ${table}.accounts - 1
      WHERE ip = ${key} AND accounts > 0
    `;
    return { allowed: false, used: limit, limit };
  }

  return withFileLock(async () => {
    const store = await readStore();
    const current = store[key];
    const used = Math.max(0, Number(current?.accounts ?? 0)) + 1;
    if (used > limit) return { allowed: false, used: limit, limit };
    store[key] = {
      accounts: used,
      firstAt: current?.firstAt ?? at,
      lastAt: at,
    };
    await writeStore(store);
    return { allowed: true, used };
  });
}

/** Вернуть место, если аккаунт так и не создался (занятый адрес, сбой записи). */
export async function releaseSignupIp(ip: string): Promise<void> {
  const key = normalizeSignupIp(ip);
  if (isYdbEnabled()) {
    await initializeStorage();
    const table = ydbQuery().identifier(getTable("signup_ips"));
    await ydbQuery()`
      UPDATE ${table} SET accounts = ${table}.accounts - 1
      WHERE ip = ${key} AND accounts > 0
    `;
    return;
  }
  await withFileLock(async () => {
    const store = await readStore();
    const current = store[key];
    if (!current) return;
    const accounts = Math.max(0, Number(current.accounts) - 1);
    if (!accounts) delete store[key];
    else store[key] = { ...current, accounts };
    await writeStore(store);
  });
}

/** Сброс счётчика адреса: ручной разбор в поддержке, когда аккаунты созданы по ошибке. */
export async function resetSignupIp(ip: string): Promise<void> {
  const key = normalizeSignupIp(ip);
  if (isYdbEnabled()) {
    await initializeStorage();
    await ydbQuery()`DELETE FROM ${ydbQuery().identifier(getTable("signup_ips"))} WHERE ip = ${key}`;
    return;
  }
  await withFileLock(async () => {
    const store = await readStore();
    delete store[key];
    await writeStore(store);
  });
}
