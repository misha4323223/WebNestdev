import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isYdbEnabled, ydbQuery, getTable } from "../storage/ydb.js";

/**
 * Контактные данные аккаунта: имя, почта для связи и согласия на письма.
 *
 * Хранится отдельно от настроек интерфейса (user_settings): это не переключатель темы, а данные
 * профиля, которые заполняются один раз при первом входе. Наличие записи — единственный признак
 * того, что знакомство пройдено: так его увидят и аккаунты, созданные до появления знакомства,
 * у которых записи ещё нет.
 */
export type OnboardingInput = {
  name: string;
  email: string;
  /** Письма о работе сервиса: сбои, лимиты, важные изменения. */
  newsletter: boolean;
  /** Новости и обновления продукта. */
  productUpdates: boolean;
};

export type OnboardingProfile = OnboardingInput & {
  completedAt: string;
  updatedAt: string;
};

const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
const profilesFile = path.join(root, "account", "profiles.json");

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

export async function getUserProfile(userId: string): Promise<OnboardingProfile | null> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{
      name: string; email: string; newsletter: boolean; product_updates: boolean;
      completed_at: string; updated_at: string;
    }>>`
      SELECT name,email,newsletter,product_updates,completed_at,updated_at
      FROM ${ydbQuery().identifier(getTable("user_profiles"))} WHERE user_id = ${userId} LIMIT 1
    `;
    const row = rows?.[0];
    return row ? {
      name: row.name,
      email: row.email,
      newsletter: Boolean(row.newsletter),
      productUpdates: Boolean(row.product_updates),
      completedAt: row.completed_at,
      updatedAt: row.updated_at,
    } : null;
  }
  const all = await readJson<Record<string, OnboardingProfile>>(profilesFile, {});
  return all[userId] ?? null;
}

/**
 * Повторное сохранение (например, если человек вернулся на первый экран) обновляет контакты,
 * но не сдвигает дату знакомства: она отвечает на вопрос «когда оставил данные», а не «когда
 * последний раз открывал форму».
 */
export async function saveUserProfile(userId: string, input: OnboardingInput): Promise<OnboardingProfile> {
  const now = new Date().toISOString();
  const existing = await getUserProfile(userId);
  const profile: OnboardingProfile = {
    name: input.name.trim(),
    email: input.email.trim().toLowerCase(),
    newsletter: input.newsletter,
    productUpdates: input.productUpdates,
    completedAt: existing?.completedAt ?? now,
    updatedAt: now,
  };
  if (isYdbEnabled()) {
    await ydbQuery()`
      UPSERT INTO ${ydbQuery().identifier(getTable("user_profiles"))}
        (user_id,name,email,newsletter,product_updates,completed_at,updated_at)
      VALUES (${userId},${profile.name},${profile.email},${profile.newsletter},${profile.productUpdates},${profile.completedAt},${profile.updatedAt})
    `;
    return profile;
  }
  const all = await readJson<Record<string, OnboardingProfile>>(profilesFile, {});
  all[userId] = profile;
  await writeJsonAtomic(profilesFile, all);
  return profile;
}
