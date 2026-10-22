import path from "node:path";
import { Pool } from "pg";

/**
 * Перешифровывает все секреты со старого ключа на новый. Раньше скрипт знал только три
 * каталога (`providers`, `github`, `yandex`), а в production данные лежат в PostgreSQL —
 * скрипт отчитывался «0 файлов», ключ менялся, и все подключения переставали читаться.
 *
 * Теперь обрабатываются оба бэкенда и все места, где лежит шифротекст:
 *   • файлы providers/github/yandex/database/cloud/domains/services/project-secrets;
 *   • таблицы providers, github_connections, yandex_connections, database_connections, project_secrets,
 *     cloud_connections, domain_connections, service_connections;
 *   • ключи платформы (platform/env.json) — их читает сервер до инициализации хранилища.
 *
 * Сначала собираются все расшифрованные значения, и только потом что-то пишется: ошибка
 * старого ключа оставляет данные нетронутыми. PostgreSQL меняется одной транзакцией.
 */

let crypto;
let rotation;
try {
  crypto = await import("../server/dist/storage/secret-crypto.js");
  rotation = await import("../server/dist/storage/rotate-secrets.js");
} catch (error) {
  throw new Error(
    "Сначала соберите сервер (npm run build:server): скрипт использует server/dist. " +
      (error instanceof Error ? error.message : String(error)),
  );
}
const { decryptSecretWith, encryptSecretWith } = crypto;
const { rotateJsonStore } = rotation;

const root = path.resolve(process.env.WEBNESTDEV_DATA_DIR ?? ".webnestdev");
const oldKey = process.env.WEBNESTDEV_ENCRYPTION_KEY;
const newKey = process.env.WEBNESTDEV_ENCRYPTION_KEY_NEXT;
if (!oldKey || !newKey || oldKey === newKey) {
  throw new Error("Set WEBNESTDEV_ENCRYPTION_KEY to the current key and WEBNESTDEV_ENCRYPTION_KEY_NEXT to a different new key.");
}

/** Проверка обеих ключей до первого секрета: кривой ключ не должен дойти до записи. */
const probe = encryptSecretWith("rotation-probe", newKey);
if (decryptSecretWith(probe, newKey) !== "rotation-probe") throw new Error("Новый ключ не расшифровывает собственный шифротекст.");
try {
  encryptSecretWith("rotation-probe", oldKey);
} catch {
  throw new Error("WEBNESTDEV_ENCRYPTION_KEY не является 32-байтовым ключом (base64 или 64 hex).");
}

function rewrap(value) {
  if (typeof value !== "string" || !value) return null;
  return encryptSecretWith(decryptSecretWith(value, oldKey), newKey);
}

const PG_TARGETS = [
  { table: "providers", key: "project_id", fields: ["token"] },
  { table: "github_connections", key: "user_id", fields: ["access_token"] },
  { table: "gitlab_connections", key: "user_id", fields: ["access_token"] },
  { table: "yandex_connections", key: "user_id", fields: ["secret"] },
  { table: "database_connections", key: "user_id", fields: ["password", "url"] },
  // Ключи из «Интеграций»: облака, регистраторы домена, сервисы.
  { table: "cloud_connections", key: "user_id", fields: ["secret"] },
  { table: "domain_connections", key: "user_id", fields: ["secret"] },
  { table: "service_connections", key: "user_id", fields: ["secret"] },
  { table: "project_secrets", key: "project_id", fields: ["payload"] },
];

function quote(name) {
  return '"' + name.replace(/"/g, '""') + '"';
}

async function rotatePostgres() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required when WEBNESTDEV_STORAGE=postgres");
  const prefix = (process.env.PG_TABLE_PREFIX ?? "webnestdev").replace(/[^A-Za-z0-9_]/g, "_");
  const pool = new Pool({ connectionString, max: 2 });
  const client = await pool.connect();
  let fields = 0;
  try {
    await client.query("BEGIN");
    for (const target of PG_TARGETS) {
      const table = quote(prefix + "_" + target.table);
      let rows;
      try {
        ({ rows } = await client.query(
          `SELECT ${quote(target.key)}, ${target.fields.map(quote).join(", ")} FROM ${table}`,
        ));
      } catch (error) {
        // Таблицы может не быть, если интеграцией ни разу не пользовались.
        if (error?.code === "42P01") continue;
        throw error;
      }
      for (const row of rows) {
        const assignments = [];
        const values = [];
        for (const field of target.fields) {
          const next = rewrap(row[field]);
          if (next === null) continue;
          assignments.push(quote(field) + " = $" + (values.length + 1));
          values.push(next);
          fields++;
        }
        if (!assignments.length) continue;
        values.push(row[target.key]);
        await client.query(
          `UPDATE ${table} SET ${assignments.join(", ")} WHERE ${quote(target.key)} = $${values.length}`,
          values,
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end().catch(() => undefined);
  }
  return fields;
}

const backend = process.env.WEBNESTDEV_STORAGE ?? (process.env.NODE_ENV === "production" ? "postgres" : "json");
if (backend !== "json" && backend !== "postgres") {
  throw new Error('WEBNESTDEV_STORAGE must be "json" or "postgres" (got "' + backend + '").');
}

try {
  // Файлы платформы и подключений нужны при любом бэкенде, но в postgres сами подключения
  // лежат в таблицах — файловые каталоги могут быть пустыми.
  const { files, fields: fileFields } = await rotateJsonStore(root, oldKey, newKey);
  let dbFields = 0;
  if (backend === "postgres") dbFields = await rotatePostgres();
  const total = fileFields + dbFields;
  console.log(
    "Rotated " + total + " secret field(s) in " + files.length + " file(s)" +
      (backend === "postgres" ? " and PostgreSQL" : "") +
      ". Keep the old key in secure backup until the new deployment is verified.",
  );
} catch (error) {
  console.error("Key rotation failed. Stop the application and restore the data-directory backup before retrying.");
  throw error;
}
