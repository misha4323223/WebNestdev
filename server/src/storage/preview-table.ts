import type { Pool } from "pg";

/**
 * Реестр живых container-preview, общий для всех API-реплик.
 *
 * Строка переживает падение API, поэтому её TTL обязан быть больше паузы между heartbeat-ами
 * preview. Просроченная строка не отдаётся читателям и удаляется уборкой, иначе после падения
 * узла вторая реплика пыталась бы проксировать в контейнер, которого уже нет.
 *
 * Static-preview сюда не попадает: его слушатель живёт в процессе конкретной API-реплики и
 * адрес `127.0.0.1` с другой машины ничего не значит.
 */
export async function ensurePreviewTable(pool: Pool, table: string): Promise<void> {
  const name = `"${table.replace(/"/g, '""')}"`;
  await pool.query(`CREATE TABLE IF NOT EXISTS ${name} (
    project_id TEXT NOT NULL PRIMARY KEY,
    owner_user_id TEXT NOT NULL DEFAULT '',
    node TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT 'container',
    container_id TEXT NOT NULL DEFAULT '',
    host TEXT NOT NULL DEFAULT '',
    port INTEGER NOT NULL DEFAULT 0,
    container_port INTEGER,
    backend_host TEXT NOT NULL DEFAULT '',
    backend_port INTEGER,
    started_at BIGINT NOT NULL,
    last_used_at BIGINT NOT NULL,
    settled BOOLEAN NOT NULL DEFAULT FALSE,
    exec_only BOOLEAN NOT NULL DEFAULT FALSE,
    exec_only_checked_at BIGINT,
    ready BOOLEAN,
    checked_at BIGINT,
    owner_address TEXT NOT NULL DEFAULT '',
    updated_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    CONSTRAINT previews_mode_check CHECK (mode IN ('container', 'static', 'hybrid'))
  )`);
  // Совместимость с таблицей, созданной до cross-replica static preview и hybrid: колонки и
  // ограничение добавляются на месте, без пересоздания и без потери живых строк.
  await pool.query(`ALTER TABLE ${name} ADD COLUMN IF NOT EXISTS owner_address TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE ${name} ADD COLUMN IF NOT EXISTS backend_host TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE ${name} ADD COLUMN IF NOT EXISTS backend_port INTEGER`);
  await pool.query(`ALTER TABLE ${name} DROP CONSTRAINT IF EXISTS previews_mode_check`);
  await pool.query(`ALTER TABLE ${name} ADD CONSTRAINT previews_mode_check CHECK (mode IN ('container', 'static', 'hybrid'))`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_${table}_expires ON ${name} (expires_at)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_${table}_owner ON ${name} (owner_user_id) WHERE owner_user_id <> ''`,
  );
  // Уникальный индекс «один preview на аккаунт» здесь намеренно не ставится: смена preview
  // останавливает старый проект и запускает новый, а удаление старой строки и вставка новой
  // идут через разные очереди. Уникальность превратила бы обычную смену проекта в гонку.
  // Правило одного preview считает менеджер по общему реестру (preview-manager.ts).
}
