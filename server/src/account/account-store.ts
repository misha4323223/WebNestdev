import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isYdbEnabled, ydbQuery, getTable } from "../storage/ydb.js";

/**
 * Account settings. Plans are not stored here: there is no paid plan to hand out yet,
 * so every account runs on the free plan and the picked plan is a client-side choice
 * (see src/lib/plan-choice.ts).
 */
export type UserPreferences = {
  language: "ru" | "en";
  compactMode: boolean;
  emailNotifications: boolean;
  productUpdates: boolean;
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
