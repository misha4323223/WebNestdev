import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getTable, isYdbEnabled, ydbQuery } from "../storage/ydb.js";
import type { PlanId } from "./plans.js";

/**
 * Уведомления аккаунта о том, что изменил администратор: начисленные токены и выданный тариф.
 *
 * Без такой записи действие меняло бы числа молча: человек видел бы другой баланс, но не знал,
 * почему. Поэтому запись создаётся тем же запросом, что и само действие, и только при
 * `notify: true` — администратор решает, нужно ли говорить об этом.
 *
 * Уведомление — не журнал: хранится последние 200 записей на аккаунт, старые вытесняются.
 * Значения (сумма, тариф, срок) лежат рядом с готовым текстом, чтобы интерфейс мог показать
 * сообщение как есть и при этом не разбирать его обратно.
 */
export type UserNotificationKind = "gift" | "plan";

export type UserNotification = {
  id: string;
  userId: string;
  kind: UserNotificationKind;
  message: string;
  /** Токены для `gift`; `null` у остальных видов. */
  tokens: number | null;
  /** Тариф для `plan`; `null` у подарка токенов. */
  plan: PlanId | null;
  planUntil: string | null;
  createdAt: string;
  readAt: string | null;
};

/** Форма для сайта: без служебного `userId`, но со всеми полями контракта. */
export type PublicNotification = Omit<UserNotification, "userId">;

const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
const notificationsFile = () => path.join(root, "account", "notifications.json");
const PER_USER_LIMIT = 200;

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + randomUUID() + ".tmp";
  try { await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(temp, file); }
  catch (error) { try { await unlink(temp); } catch {} throw error; }
}

type NotificationRow = {
  id: string;
  user_id: string;
  kind: string;
  message: string;
  tokens: number | string | bigint | null;
  plan: string | null;
  plan_until: string | null;
  created_at: string;
  read_at: string | null;
};

function fromRow(row: NotificationRow): UserNotification {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind === "plan" ? "plan" : "gift",
    message: row.message,
    tokens: row.tokens === null || row.tokens === undefined ? null : Number(row.tokens),
    plan: (row.plan as PlanId | null) ?? null,
    planUntil: row.plan_until ?? null,
    createdAt: row.created_at,
    readAt: row.read_at ?? null,
  };
}

export function publicNotification(record: UserNotification): PublicNotification {
  const { userId: _userId, ...rest } = record;
  return rest;
}

/**
 * Создаёт уведомление. Ошибку хранилища вызывающий решает сам: действие уже выполнено, и
 * отменять его из-за неудавшегося уведомления было бы хуже, чем показать `notified: false`.
 */
export async function createNotification(input: {
  userId: string;
  kind: UserNotificationKind;
  message: string;
  tokens?: number | null;
  plan?: PlanId | null;
  planUntil?: string | null;
  now?: Date;
}): Promise<UserNotification> {
  const now = input.now ?? new Date();
  const record: UserNotification = {
    id: randomUUID(),
    userId: input.userId,
    kind: input.kind,
    message: input.message.trim().slice(0, 300),
    tokens: input.kind === "gift" && Number.isFinite(input.tokens) ? Math.trunc(input.tokens as number) : null,
    plan: input.plan ?? null,
    planUntil: input.planUntil ?? null,
    createdAt: now.toISOString(),
    readAt: null,
  };

  if (isYdbEnabled()) {
    await ydbQuery()`
      INSERT INTO ${ydbQuery().identifier(getTable("user_notifications"))}
        (id, user_id, kind, message, tokens, plan, plan_until, created_at, read_at)
      VALUES (${record.id}, ${record.userId}, ${record.kind}, ${record.message}, ${record.tokens},
              ${record.plan}, ${record.planUntil}, ${record.createdAt}, ${record.readAt})
    `;
    return record;
  }

  const all = await readJson<Record<string, UserNotification[]>>(notificationsFile(), {});
  const list = all[record.userId] ?? [];
  list.push(record);
  all[record.userId] = list.slice(-PER_USER_LIMIT);
  await writeJsonAtomic(notificationsFile(), all);
  return record;
}

/** Последние уведомления аккаунта, новые сверху. */
export async function listNotifications(userId: string, limit = 50): Promise<UserNotification[]> {
  const take = Math.max(1, Math.min(PER_USER_LIMIT, Math.trunc(limit)));
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<NotificationRow[]>`
      SELECT id, user_id, kind, message, tokens, plan, plan_until, created_at, read_at
      FROM ${ydbQuery().identifier(getTable("user_notifications"))}
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT ${take}
    `;
    return (rows ?? []).map(fromRow);
  }
  const all = await readJson<Record<string, UserNotification[]>>(notificationsFile(), {});
  return (all[userId] ?? []).slice(-take).reverse();
}

/**
 * Отмечает одно уведомление прочитанным. Повторное нажатие не ошибка: `readAt` остаётся первым,
 * иначе время прочтения переписывалось бы каждым открытием списка.
 */
export async function markNotificationRead(userId: string, id: string, now = new Date()): Promise<boolean> {
  const readAt = now.toISOString();
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{ id: string }>>`
      UPDATE ${ydbQuery().identifier(getTable("user_notifications"))}
      SET read_at = COALESCE(read_at, ${readAt})
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING id
    `;
    return Boolean(rows?.[0]);
  }
  const all = await readJson<Record<string, UserNotification[]>>(notificationsFile(), {});
  const record = (all[userId] ?? []).find(item => item.id === id);
  if (!record) return false;
  record.readAt ??= readAt;
  await writeJsonAtomic(notificationsFile(), all);
  return true;
}

/** Отмечает прочитанными все непрочитанные; возвращает, сколько записей изменилось. */
export async function markAllNotificationsRead(userId: string, now = new Date()): Promise<number> {
  const readAt = now.toISOString();
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{ id: string }>>`
      UPDATE ${ydbQuery().identifier(getTable("user_notifications"))}
      SET read_at = ${readAt}
      WHERE user_id = ${userId} AND read_at IS NULL
      RETURNING id
    `;
    return rows?.length ?? 0;
  }
  const all = await readJson<Record<string, UserNotification[]>>(notificationsFile(), {});
  let changed = 0;
  for (const record of all[userId] ?? []) {
    if (record.readAt) continue;
    record.readAt = readAt;
    changed += 1;
  }
  if (changed) await writeJsonAtomic(notificationsFile(), all);
  return changed;
}
