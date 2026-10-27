import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getTable, isYdbEnabled, ydbQuery } from "../storage/ydb.js";

/**
 * Блокировка аккаунта администратором.
 *
 * Отдельная запись, а не колонка в `users`: таблица пользователей создана раньше, и добавление
 * колонки на живом сервере означало бы `ALTER TABLE` в пути входа. Здесь же блокировка — новая
 * таблица, которую хранилище создаёт при старте, а у аккаунта без блокировки просто нет строки.
 *
 * Блокировка не удаляет данные и не меняет тариф: она запрещает вход и убивает уже выданные
 * сессии (см. routes/admin-users.ts). Это обратимое действие, поэтому и хранится отдельно от
 * аккаунта.
 */
export type UserRestriction = {
  userId: string;
  blockedAt: string;
  /** Кто заблокировал: id администратора и его почта — по журналу видно автора. */
  blockedBy: string;
  blockedByLabel: string;
  reason: string;
};

/** Одна фраза на все входы (пароль, телефон, Яндекс ID): человек видит причину, а не «ошибку сети». */
export const ACCOUNT_BLOCKED_MESSAGE = "Аккаунт заблокирован администратором. Напишите в поддержку.";

const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
const restrictionsFile = () => path.join(root, "account", "restrictions.json");

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; }
  catch (error) {
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

type RestrictionRow = {
  user_id: string;
  blocked_at: string;
  blocked_by: string;
  blocked_by_label: string;
  reason: string;
};

function fromRow(row: RestrictionRow): UserRestriction {
  return {
    userId: row.user_id,
    blockedAt: row.blocked_at,
    blockedBy: row.blocked_by,
    blockedByLabel: row.blocked_by_label,
    reason: row.reason,
  };
}

export async function getRestriction(userId: string): Promise<UserRestriction | null> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<RestrictionRow[]>`
      SELECT user_id, blocked_at, blocked_by, blocked_by_label, reason
      FROM ${ydbQuery().identifier(getTable("user_restrictions"))}
      WHERE user_id = ${userId}
      LIMIT 1
    `;
    return rows[0] ? fromRow(rows[0]) : null;
  }
  const all = await readJson<Record<string, UserRestriction>>(restrictionsFile(), {});
  return all[userId] ?? null;
}

/** Один запрос на каждое обращение к закрытому API: аккаунт без строки блокировки не читается лишний раз. */
export async function isBlocked(userId: string): Promise<boolean> {
  return (await getRestriction(userId)) !== null;
}

export async function blockUser(input: {
  userId: string;
  reason: string;
  adminId: string;
  adminLabel: string;
  now?: Date;
}): Promise<UserRestriction> {
  const record: UserRestriction = {
    userId: input.userId,
    blockedAt: (input.now ?? new Date()).toISOString(),
    blockedBy: input.adminId,
    blockedByLabel: input.adminLabel,
    reason: input.reason,
  };
  if (isYdbEnabled()) {
    await ydbQuery()`
      UPSERT INTO ${ydbQuery().identifier(getTable("user_restrictions"))}
        (user_id, blocked_at, blocked_by, blocked_by_label, reason)
      VALUES (${record.userId}, ${record.blockedAt}, ${record.blockedBy}, ${record.blockedByLabel}, ${record.reason})
    `;
    return record;
  }
  const all = await readJson<Record<string, UserRestriction>>(restrictionsFile(), {});
  all[record.userId] = record;
  await writeJsonAtomic(restrictionsFile(), all);
  return record;
}

/** Снимает блокировку; `false` — блокировки не было (сессии при этом всё равно уже отозваны). */
export async function unblockUser(userId: string): Promise<boolean> {
  if (isYdbEnabled()) {
    const existing = await getRestriction(userId);
    if (!existing) return false;
    await ydbQuery()`
      DELETE FROM ${ydbQuery().identifier(getTable("user_restrictions"))}
      WHERE user_id = ${userId}
    `;
    return true;
  }
  const all = await readJson<Record<string, UserRestriction>>(restrictionsFile(), {});
  if (!all[userId]) return false;
  delete all[userId];
  await writeJsonAtomic(restrictionsFile(), all);
  return true;
}
