import assert from "node:assert/strict";
import test from "node:test";
import {
  quoteIdent,
  quoteLiteral,
  readOnlyStatement,
  tenantNames,
  provisionStatements,
  SCHEMA_SIZE_SQL,
} from "./sql.js";

const PASSWORD = "AbCdEfGhIjKlMnOpQrStUvWx";

test("имя схемы детерминировано и валидно для PostgreSQL", () => {
  const first = tenantNames("user-123");
  const second = tenantNames("user-123");
  assert.deepEqual(first, second);
  assert.match(first.schema, /^tenant_[0-9a-f]{16}$/);
  assert.equal(first.schema, first.role);
  assert.notDeepEqual(tenantNames("user-124").schema, first.schema);
});

test("разные аккаунты не могут получить одно имя", () => {
  const names = new Set<string>();
  for (let index = 0; index < 5000; index++) names.add(tenantNames("account-" + index).schema);
  assert.equal(names.size, 5000);
});

test("пустой аккаунт и кривой идентификатор отклоняются", () => {
  assert.throws(() => tenantNames(""));
  assert.throws(() => quoteIdent("tenant; DROP DATABASE app"));
  assert.throws(() => quoteIdent("Tenant_x"));
});

test("литерал экранирует кавычку", () => {
  assert.equal(quoteLiteral("a'b"), "'a''b'");
});

test("провижининг создаёт роль раньше схемы", () => {
  const names = tenantNames("user-1");
  const statements = provisionStatements({ names, database: "app", password: PASSWORD, roleExists: false });
  assert.match(statements[0], /^CREATE ROLE "tenant_[0-9a-f]{16}" LOGIN PASSWORD '/);
  const schemaIndex = statements.findIndex(statement => statement.startsWith("CREATE SCHEMA"));
  assert.ok(schemaIndex > 0, "схема создаётся после роли");
  assert.match(statements[schemaIndex]!, /^CREATE SCHEMA IF NOT EXISTS "tenant_[0-9a-f]{16}"$/);
  assert.ok(statements.some(statement => /ALTER SCHEMA "tenant_[0-9a-f]{16}" OWNER TO CURRENT_USER/.test(statement)),
    "схемой владеет администратор, а не tenant-роль");
  assert.ok(statements.some(statement => /GRANT USAGE, CREATE ON SCHEMA/.test(statement)));
});

test("существующая роль не пересоздаётся, но пароль и лимиты обновляются", () => {
  const names = tenantNames("user-1");
  const statements = provisionStatements({ names, database: "app", password: PASSWORD, roleExists: true });
  assert.ok(!statements.some(statement => statement.startsWith("CREATE ROLE")));
  assert.ok(statements.some(statement => /ALTER ROLE .* PASSWORD '/.test(statement)));
});

test("права ограничены своей схемой и public", () => {
  const names = tenantNames("user-1");
  const statements = provisionStatements({ names, database: "app", password: PASSWORD, roleExists: true });
  const joined = statements.join("\n");
  assert.match(joined, /SET search_path = "tenant_[0-9a-f]{16}", public/);
  assert.match(joined, /GRANT "tenant_[0-9a-f]{16}" TO CURRENT_USER/);
  assert.match(joined, /REVOKE "tenant_[0-9a-f]{16}" FROM CURRENT_USER/);
  assert.match(joined, /GRANT CONNECT ON DATABASE "app"/);
  assert.match(joined, /REVOKE CREATE ON DATABASE "app" FROM/);
  assert.match(joined, /statement_timeout/);
  assert.match(joined, /idle_in_transaction_session_timeout/);
  assert.doesNotMatch(joined, /temp_file_limit/, "temp_file_limit доступен только superuser");
});

test("членство администратора снимается после создания схемы", () => {
  const names = tenantNames("user-1");
  const statements = provisionStatements({ names, database: "app", password: PASSWORD, roleExists: false });
  const schemaIndex = statements.findIndex(statement => statement.startsWith("CREATE SCHEMA"));
  const grantIndex = statements.findIndex(statement => statement.startsWith("GRANT \"tenant_"));
  const revokeIndex = statements.findIndex(statement => statement.startsWith("REVOKE \"tenant_"));
  assert.ok(grantIndex > 0 && grantIndex < schemaIndex, "членство нужно для ALTER SCHEMA существующей схемы");
  assert.ok(revokeIndex > schemaIndex, "членство снимается после настройки схемы");
});

test("слабый пароль не проходит", () => {
  const names = tenantNames("user-1");
  assert.throws(() => provisionStatements({ names, database: "app", password: "123", roleExists: true }));
  assert.throws(() => provisionStatements({ names, database: "app", password: "pass'word-pass-word", roleExists: true }));
});

test("read-only включается и выключается на роли", () => {
  const names = tenantNames("user-1");
  assert.match(readOnlyStatement(names, true), /default_transaction_read_only = on$/);
  assert.match(readOnlyStatement(names, false), /default_transaction_read_only = off$/);
});

test("размер схемы не суммирует индексы повторно", () => {
  assert.match(SCHEMA_SIZE_SQL, /c\.relkind IN \('r','m'\)/);
  assert.match(SCHEMA_SIZE_SQL, /pg_total_relation_size/);
});
