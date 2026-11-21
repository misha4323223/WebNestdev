import assert from "node:assert/strict";
import test from "node:test";
import { setTenantAccess } from "./access.js";
import { tenantNames } from "./sql.js";

function fakeDb() {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  return {
    calls,
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      if (sql.includes("current_database()")) return { rows: [{ name: "webnestdev" }] };
      if (sql.includes("FROM pg_class")) {
        return { rows: [{ relname: "\"tenant_x\".\"orders\"", relkind: "r" }] };
      }
      return { rows: [] };
    },
  };
}

test("read-only отбирает владение схемой и объектами, отзывает права и закрывает сессии", async () => {
  const db = fakeDb();
  const names = tenantNames("user-1");
  await setTenantAccess(db, names, true);
  const sql = db.calls.map(call => call.sql).join("\n");
  assert.match(sql, /ALTER SCHEMA \"[^\"]+\" OWNER TO CURRENT_USER/);
  assert.match(sql, /REVOKE CREATE ON SCHEMA/);
  assert.match(sql, /REVOKE CREATE ON DATABASE \"webnestdev\" FROM \"tenant_[0-9a-f]{16}\"/);
  assert.match(sql, /ALTER TABLE \"[^\"]+\"\.\"orders\" OWNER TO CURRENT_USER/);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL TABLES/);
  assert.match(sql, /REVOKE USAGE ON SCHEMA/);
  assert.match(sql, /CONNECTION LIMIT 0/);
  assert.match(sql, /default_transaction_read_only = on/);
  assert.ok(
    sql.indexOf("CONNECTION LIMIT 0") < sql.indexOf("ALTER SCHEMA"),
    "вход закрывается до смены владельца: ошибка в середине не оставляет доступ",
  );
  assert.match(sql, /pg_terminate_backend/);
  assert.match(sql, /REVOKE \"[^\"]+\" FROM CURRENT_USER/, "временное членство снимается");
});

test("возврат квоты возвращает владение и права, не трогая владельца схемы", async () => {
  const db = fakeDb();
  const names = tenantNames("user-1");
  await setTenantAccess(db, names, false);
  const sql = db.calls.map(call => call.sql).join("\n");
  assert.match(sql, /GRANT USAGE, CREATE ON SCHEMA/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE/);
  assert.match(sql, /ALTER TABLE \"[^\"]+\"\.\"orders\" OWNER TO \"[^\"]+\"/);
  assert.match(sql, /CONNECTION LIMIT 5/);
  assert.match(sql, /default_transaction_read_only = off/);
  assert.doesNotMatch(sql, /REVOKE ALL PRIVILEGES ON ALL TABLES/);
});
