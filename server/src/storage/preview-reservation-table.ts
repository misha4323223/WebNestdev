import type { Pool } from "pg";

/**
 * Короткоживущая бронь на запуск container-preview.
 *
 * Пока контейнер поднимается, строки в `previews` ещё нет. Без брони две реплики
 * одновременно читают «живых предпросмотров нет» и обе проходят проверку лимита. Бронь
 * занимает слот на время старта и истекает сама, если процесс упал.
 *
 * `reservation_id` — токен владельца: поздний `release` другого запуска того же проекта не
 * должен снять чужую бронь.
 */
export async function ensurePreviewReservationTable(pool: Pool, table: string): Promise<void> {
  const name = `"${table.replace(/"/g, '""')}"`;
  await pool.query(`CREATE TABLE IF NOT EXISTS ${name} (
    project_id TEXT NOT NULL PRIMARY KEY,
    reservation_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL DEFAULT '',
    node TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT 'container',
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
  )`);
  // Совместимость с таблицей, созданной до разделения Docker и hybrid: старые брони
  // считаются Docker-контейнерами, потому что hybrid тогда ещё не было.
  await pool.query(`ALTER TABLE ${name} ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'container'`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_${table}_expires ON ${name} (expires_at)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_${table}_owner ON ${name} (owner_user_id) WHERE owner_user_id <> ''`,
  );
}
