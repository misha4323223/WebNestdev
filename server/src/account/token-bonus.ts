import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getTable, isYdbEnabled, ydbQuery } from "../storage/ydb.js";

/**
 * Начисленные администратором токены: доплата к месячному пулу тарифа.
 *
 * Пул тарифа — константа каталога (`limits.agentTokensPerMonth`), поэтому «дать человеку ещё
 * токенов» нельзя правкой расхода: расход считается по `model_usage` и должен оставаться честным.
 * Вместо этого надбавка живёт отдельной строкой на аккаунт и месяц и прибавляется к пределу —
 * и в проверке запуска (usage-store.ts), и в шкале пула в кабинете.
 *
 * Ключ — аккаунт и месяц: надбавка не переносится на следующий месяц и не превращается в
 * бессрочный кредит. Повторное начисление в том же месяце складывается.
 */
export type TokenBonus = { userId: string; month: string; tokens: number; updatedAt: string };

const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
const bonusFile = () => path.join(root, "account", "token-bonus.json");

/** Календарный месяц UTC — тот же, по которому считается расход в пуле. */
export function tokenMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

function key(userId: string, month: string) {
  return userId + ":" + month;
}

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

async function readBonus(userId: string, month: string): Promise<TokenBonus | null> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{ tokens: number | string | bigint; updated_at: string }>>`
      SELECT tokens, updated_at FROM ${ydbQuery().identifier(getTable("token_bonuses"))}
      WHERE user_id = ${userId} AND month = ${month}
      LIMIT 1
    `;
    const row = rows[0];
    return row ? { userId, month, tokens: Number(row.tokens ?? 0), updatedAt: row.updated_at } : null;
  }
  const all = await readJson<Record<string, TokenBonus>>(bonusFile(), {});
  return all[key(userId, month)] ?? null;
}

/** Надбавка на месяц; 0 — надбавки нет, действует только пул тарифа. */
export async function tokenBonusFor(userId: string, month: string): Promise<number> {
  const record = await readBonus(userId, month);
  return record && Number.isFinite(record.tokens) ? record.tokens : 0;
}

/**
 * Начисляет токены на месяц. Сумма складывается с уже начисленным: две выдачи по 5 млн — это
 * 10 млн, а не 5, и повтор действия не может незаметно отнять выданное раньше.
 */
export async function addTokenBonus(userId: string, tokens: number, now = new Date()): Promise<TokenBonus> {
  const month = tokenMonth(now);
  const updatedAt = now.toISOString();
  const current = await tokenBonusFor(userId, month);
  const total = Math.max(0, Math.floor(current + tokens));
  if (isYdbEnabled()) {
    await ydbQuery()`
      INSERT INTO ${ydbQuery().identifier(getTable("token_bonuses"))}
        (user_id, month, tokens, updated_at)
      VALUES (${userId}, ${month}, ${total}, ${updatedAt})
      ON CONFLICT (user_id, month) DO UPDATE SET tokens = ${total}, updated_at = ${updatedAt}
    `;
    return { userId, month, tokens: total, updatedAt };
  }
  const all = await readJson<Record<string, TokenBonus>>(bonusFile(), {});
  const record: TokenBonus = { userId, month, tokens: total, updatedAt };
  all[key(userId, month)] = record;
  await writeJsonAtomic(bonusFile(), all);
  return record;
}
