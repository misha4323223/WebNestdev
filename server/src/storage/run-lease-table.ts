import type { Pool } from "pg";

/**
 * Аренда запуска агента на аккаунт.
 *
 * Это не блокировка на всё время прогона: соединение с базой нельзя держать часами, иначе
 * пул из десяти коннектов закончится на десяти одновременных запусках. Вместо этого строка
 * продлевается heartbeat-ом, а после падения процесса истекает сама.
 */
export async function ensureRunLeaseTable(pool: Pool, table: string): Promise<void> {
  const name = `"${table.replace(/"/g, '""')}"`;
  await pool.query(`CREATE TABLE IF NOT EXISTS ${name} (
    user_id TEXT NOT NULL PRIMARY KEY,
    run_id TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT '',
    node TEXT NOT NULL DEFAULT '',
    expires_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`);
  // Таблица могла быть создана до появления project_id; ALTER идемпотентен и не требует
  // отдельного шага миграции при откате на предыдущую версию.
  await pool.query(
    `ALTER TABLE ${name} ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT ''`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_${table}_expires ON ${name} (expires_at)`,
  );
  // По проекту проверяются архивация, перенос и idle-уборка preview: активный запуск на
  // другой реплике не должен позволить им тронуть файлы проекта.
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_${table}_project ON ${name} (project_id, expires_at) WHERE project_id <> ''`,
  );
}
