import type { Pool } from "pg";

/**
 * Колонки фоновых заданий хостинга.
 *
 * Таблица `jobs` уже хранит аренду, попытки и retry для архивации. Фоновому заданию нужны
 * привязка к сайту/релизу, имя обработчика, payload и краткий результат. Отдельная таблица
 * раздвоила бы захват и дедупликацию, поэтому расширяем существующую.
 *
 * Все `ADD COLUMN IF NOT EXISTS`: таблица создана в production раньше, и `CREATE TABLE
 * IF NOT EXISTS` не добавил бы новые поля.
 */
export async function ensureBackgroundJobColumns(pool: Pool, tableName: string): Promise<void> {
  const table = `"${tableName.replace(/"/g, '""')}"`;
  await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS site_id TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS release_id TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS function_name TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS payload_json TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS result_json TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0`);
  // Захват фонового пула фильтрует по kind и берёт сначала более приоритетные задания.
  // Индекс не мешает существующему пути архивации: он тоже начинается с kind/state.
  const prefix = tableName.replace(/[^A-Za-z0-9_]/g, "_");
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_${prefix}_kind_priority ON ${table} (kind, state, priority DESC, run_after)`,
  );
}
