import type { Pool } from "pg";

/**
 * DDL пользовательских доменов. Отдельный модуль, чтобы `pg.ts` не разрастался и чтобы
 * таблицу можно было проверить/переиспользовать без чтения всего storage-инициализатора.
 *
 * `group_id` — один домен клиента вместе с `www`; лимит тарифа считается по группам.
 * `is_canonical` — единственный основной hostname на сайте.
 */
export async function ensureCustomDomainTable(pool: Pool, table: string, sitesTable: string): Promise<void> {
  const name = `"${table.replace(/"/g, '""')}"`;
  const sites = `"${sitesTable.replace(/"/g, '""')}"`;
  await pool.query(`CREATE TABLE IF NOT EXISTS ${name} (
    id TEXT NOT NULL PRIMARY KEY,
    group_id TEXT NOT NULL,
    site_id TEXT NOT NULL REFERENCES ${sites}(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    hostname TEXT NOT NULL UNIQUE,
    display_hostname TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'apex',
    status TEXT NOT NULL DEFAULT 'pending_dns',
    verification_token TEXT NOT NULL,
    verification_host TEXT NOT NULL,
    verified_at TEXT,
    last_checked_at TEXT,
    last_error TEXT NOT NULL DEFAULT '',
    certificate_status TEXT NOT NULL DEFAULT 'none',
    certificate_error TEXT NOT NULL DEFAULT '',
    is_canonical BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CONSTRAINT site_domains_kind_check CHECK (kind IN ('apex','www','subdomain')),
    CONSTRAINT site_domains_status_check CHECK (status IN ('pending_dns','verified','configuring','issuing_certificate','active','error')),
    CONSTRAINT site_domains_certificate_status_check CHECK (certificate_status IN ('none','issuing','active','error'))
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_${table}_site ON ${name} (site_id, created_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_${table}_group ON ${name} (group_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_${table}_status ON ${name} (status)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_one_canonical ON ${name} (site_id) WHERE is_canonical = TRUE`);
}
