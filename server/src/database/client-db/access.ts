import { quoteIdent, type TenantNames } from "./sql.js";
import type { SqlExecutor } from "./provision.js";

/**
 * Доступ tenant-роли к собственной схеме.
 *
 * Роль не должна владеть схемой: владелец может `DROP SCHEMA CASCADE`, менять владельца и
 * обходить ограничения, которые администратор считает выставленными. Схемой владеет
 * администратор клиентской базы, а роль получает только `USAGE`/`CREATE` и права на таблицы.
 *
 * Read-only — это не только `ALTER ROLE … default_transaction_read_only`, потому что роль может
 * выполнить `SET default_transaction_read_only = off`. При исчерпании квоты мы:
 *   1) забираем владение таблицами/последовательностями у tenant-роли;
 *   2) отзываем `CREATE` и DML;
 *   3) ставим `CONNECTION LIMIT 0`, чтобы новые сессии не обходили запрет;
 *   4) завершаем уже открытые сессии, если администратору это разрешено.
 *
 * При возврате оплаченной квоты права и владение возвращаются, поэтому обычные миграции снова
 * работают. Схема остаётся за администратором — её нельзя удалить целиком.
 */

const RELATIONS_SQL =
  "SELECT c.oid::regclass::text AS relname, c.relkind " +
  "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
  "WHERE n.nspname = $1 AND c.relowner = $2::regrole " +
  "AND c.relkind IN ('r','p','v','m','S','f')";
const RELATIONS_BY_CURRENT_USER_SQL =
  "SELECT c.oid::regclass::text AS relname, c.relkind " +
  "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
  "WHERE n.nspname = $1 AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) " +
  "AND c.relkind IN ('r','p','v','m','S','f')";

function alterOwnerSql(relkind: unknown, relname: unknown, owner: string): string | null {
  const relation = String(relname ?? "");
  if (!relation) return null;
  switch (String(relkind ?? "")) {
    case "r":
    case "p":
      return "ALTER TABLE " + relation + " OWNER TO " + owner;
    case "v":
      return "ALTER VIEW " + relation + " OWNER TO " + owner;
    case "m":
      return "ALTER MATERIALIZED VIEW " + relation + " OWNER TO " + owner;
    case "S":
      return "ALTER SEQUENCE " + relation + " OWNER TO " + owner;
    case "f":
      return "ALTER FOREIGN TABLE " + relation + " OWNER TO " + owner;
    default:
      return null;
  }
}

/**
 * Переносит владение отношениями схемы. `fromRole` — имя роли, `owner` — `CURRENT_USER` или
 * проверенный идентификатор роли. Имена отношений приходят из `regclass::text`, то есть уже
 * заключены в кавычки PostgreSQL, и не собираются из пользовательской строки.
 */
async function transferRelations(
  db: SqlExecutor,
  names: TenantNames,
  fromRole: string,
  owner: "CURRENT_USER" | string,
) {
  const rows = fromRole === "CURRENT_USER"
    ? await db.query(RELATIONS_BY_CURRENT_USER_SQL, [names.schema])
    : await db.query(RELATIONS_SQL, [names.schema, fromRole]);
  for (const row of rows.rows) {
    const statement = alterOwnerSql(row.relkind, row.relname, owner);
    if (statement) await db.query(statement);
  }
}

async function withTemporaryMembership<T>(db: SqlExecutor, roleSql: string, action: () => Promise<T>): Promise<T> {
  // Администратор — не постоянный член tenant-роли: членство нужно только чтобы сменить владельца
  // объектов, принадлежащих этой роли. После операции оно снимается.
  await db.query("GRANT " + roleSql + " TO CURRENT_USER");
  try {
    return await action();
  } finally {
    await db.query("REVOKE " + roleSql + " FROM CURRENT_USER").catch(error => {
      // Если снять членство не удалось, администратор остаётся членом tenant-роли. Это не
      // повышает его права (он и так управляет базой), но нарушает принцип временного доступа и
      // должно быть видно в логе, а не проглочено.
      console.warn("[client-db] не удалось снять временное членство: " + (error instanceof Error ? error.message : String(error)));
    });
  }
}

const GRANT_TABLES_SQL =
  "GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA ";
const GRANT_SEQUENCES_SQL = "GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ";
const REVOKE_TABLES_SQL = "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ";
const REVOKE_SEQUENCES_SQL = "REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ";

/** Имя базы из `current_database()`; кавычки экранируются, значение приходит от PostgreSQL. */
function quoteDatabase(name: string) {
  if (!name || Buffer.byteLength(name, "utf8") > 63) throw new Error("Некорректное имя клиентской базы");
  return '"' + name.replaceAll('"', '""') + '"';
}

/**
 * `CREATE` на базе позволяет создать вторую схему в обход квоты. Это право снимается в
 * провижининге, а здесь — ещё раз при каждой смене режима: старые tenant-роли могли получить его
 * до ужесточения, и GET статуса не должен оставлять такую лазейку. Ошибку не глотаем: если
 * администратор не может отозвать право, это должно быть видно, а не выглядеть закрытым.
 */
async function revokeDatabaseCreate(db: SqlExecutor, role: string) {
  const result = await db.query("SELECT current_database() AS name");
  const name = String(result.rows[0]?.name ?? "");
  if (!name) return;
  await db.query("REVOKE CREATE ON DATABASE " + quoteDatabase(name) + " FROM " + role);
}

/** Выставляет рабочее состояние роли: либо обычный доступ, либо жёсткий read-only по квоте. */
export async function setTenantAccess(
  db: SqlExecutor,
  tenant: TenantNames,
  readOnly: boolean,
): Promise<void> {
  const schema = quoteIdent(tenant.schema);
  const role = quoteIdent(tenant.role);
  const roleName = tenant.role;
  const roleOwner = quoteIdent(tenant.role);

  // Право на CREATE в самой базе не зависит от владения схемой. Снимаем его и при read-only,
  // и при возврате квоты: иначе старая роль могла бы создать новую схему рядом и обойти лимит.
  await revokeDatabaseCreate(db, role);

  await withTemporaryMembership(db, role, async () => {
    if (readOnly) {
      // Сначала закрываем вход и завершаем уже открытые сессии, затем меняем владение и права.
      // Так ошибка в середине цепочки не оставит tenant-роль с рабочим доступом: новая сессия
      // уже не подключится, а старые закрыты (если администратору разрешено их завершать).
      await db.query("ALTER ROLE " + role + " CONNECTION LIMIT 0");
      await db.query("ALTER ROLE " + role + " SET default_transaction_read_only = on");
      await db.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity " +
        "WHERE usename = $1 AND pid <> pg_backend_pid()",
        [roleName],
      ).catch(() => undefined);
      // Теперь убираем возможность создавать новые объекты и владение схемой, затем забираем
      // уже созданные: иначе tenant-сессия успела бы создать таблицу между шагами.
      await db.query("ALTER SCHEMA " + schema + " OWNER TO CURRENT_USER");
      await db.query("REVOKE CREATE ON SCHEMA " + schema + " FROM " + role);
      await transferRelations(db, tenant, roleName, "CURRENT_USER");
      await db.query(REVOKE_TABLES_SQL + schema + " FROM " + role);
      await db.query(REVOKE_SEQUENCES_SQL + schema + " FROM " + role);
      await db.query("REVOKE USAGE ON SCHEMA " + schema + " FROM " + role);
      return;
    }

    await db.query("ALTER SCHEMA " + schema + " OWNER TO CURRENT_USER");
    await db.query("GRANT USAGE, CREATE ON SCHEMA " + schema + " TO " + role);
    // Сначала выдаём права, пока администратор ещё владеет таблицами, затем возвращаем
    // владение роли: владелец имеет неявные права и снова может делать свои миграции.
    await db.query(GRANT_TABLES_SQL + schema + " TO " + role);
    await db.query(GRANT_SEQUENCES_SQL + schema + " TO " + role);
    await transferRelations(db, tenant, "CURRENT_USER", roleOwner);
    await db.query("ALTER ROLE " + role + " CONNECTION LIMIT 5");
    await db.query("ALTER ROLE " + role + " SET default_transaction_read_only = off");
  });
}
