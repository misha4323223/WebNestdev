import type { Pool } from "pg";

/**
 * Журнал запусков предпросмотра за последние сутки.
 *
 * Он нужен админке: `coldStarts24h`, среднее и самое долгое время старта нельзя посчитать по
 * реестру работающих preview — после остановки строка исчезает. Поэтому запуск пишется отдельной
 * строкой, а старые строки удаляются при чтении. Таблица общая для реплик: иначе каждая ВМ
 * показывала бы только свои старты.
 *
 * `started_at` — миллисекунды, как и остальные отметки времени в storage: PostgreSQL BIGINT не
 * теряет точность, а сравнение окна не зависит от часового пояса.
 */
export async function ensurePreviewStartTable(pool: Pool, table: string): Promise<void> {
  const name = `"${table.replace(/"/g, '""')}"`;
  await pool.query(`CREATE TABLE IF NOT EXISTS ${name} (
    id TEXT NOT NULL PRIMARY KEY,
    project_id TEXT NOT NULL DEFAULT '',
    node TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT 'container',
    duration_ms INTEGER NOT NULL,
    ok BOOLEAN NOT NULL DEFAULT TRUE,
    started_at BIGINT NOT NULL
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_${table}_started ON ${name} (started_at)`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_${table}_project ON ${name} (project_id, started_at DESC)`,
  );
}
