import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTenantQuota,
  getTenant,
  listTenants,
  provisionTenant,
  reconcileTenantQuota,
  roleExists,
  tenantSizeBytes,
  type SqlExecutor,
  type TenantRecord,
} from "./provision.js";
import { tenantNames } from "./sql.js";

const PASSWORD = "AbCdEfGhIjKlMnOpQrStUvWx";

/** Исполнитель, который записывает операторы и отвечает по заранее заданному плану. */
function fakeDb(answers: Array<{ rows: Array<Record<string, unknown>> }> = []): SqlExecutor & { calls: Array<{ sql: string; values?: unknown[] }> } {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  let index = 0;
  return {
    calls,
    query: async (sql, values) => {
      calls.push({ sql, values });
      const answer = answers[index];
      index += 1;
      return answer ?? { rows: [] };
    },
  };
}

test("provisionTenant создаёт роль, схему и учётную запись в правильном порядке", async () => {
  const db = fakeDb();
  const names = tenantNames("user-1");
  const result = await provisionTenant(db, {
    accountId: "user-1",
    database: "app",
    password: PASSWORD,
    quotaBytes: 134_217_728,
  });
  assert.deepEqual(result, names);
  const sql = db.calls.map(call => call.sql);
  assert.match(sql[0]!, /CREATE SCHEMA IF NOT EXISTS nestdev_admin/);
  assert.match(sql[1]!, /CREATE TABLE IF NOT EXISTS nestdev_admin\.tenants/);
  assert.match(sql[2]!, /SELECT 1 FROM pg_roles/);
  assert.ok(sql.some(statement => /^CREATE ROLE/.test(statement)));
  const register = db.calls.find(call => call.sql.includes("INSERT INTO nestdev_admin.tenants"));
  assert.deepEqual(register?.values, ["user-1", names.schema, names.role, 134_217_728]);
});

test("provisionTenant не пересоздаёт существующую роль", async () => {
  const db = fakeDb([{ rows: [] }, { rows: [] }, { rows: [{ "?column?": 1 }] }]);
  await provisionTenant(db, { accountId: "user-1", database: "app", password: PASSWORD, quotaBytes: 0 });
  assert.ok(!db.calls.some(call => /^CREATE ROLE/.test(call.sql)));
  assert.ok(db.calls.some(call => /^ALTER ROLE/.test(call.sql)));
});

test("roleExists различает пустой и непустой ответ", async () => {
  assert.equal(await roleExists(fakeDb([{ rows: [] }]), "tenant_x"), false);
  assert.equal(await roleExists(fakeDb([{ rows: [{ "?column?": 1 }] }]), "tenant_x"), true);
});

test("tenantSizeBytes приводит bigint-строку к числу и переживает пустой ответ", async () => {
  assert.equal(await tenantSizeBytes(fakeDb([{ rows: [{ bytes: "1048576" }] }]), "tenant_x"), 1_048_576);
  assert.equal(await tenantSizeBytes(fakeDb([{ rows: [] }]), "tenant_x"), 0);
  assert.equal(await tenantSizeBytes(fakeDb([{ rows: [{ bytes: "не число" }] }]), "tenant_x"), 0);
});

test("getTenant и listTenants разбирают строки учётной таблицы", async () => {
  const row = {
    account_id: "user-1",
    schema_name: "tenant_abc",
    role_name: "tenant_abc",
    quota_bytes: "134217728",
    read_only: false,
  };
  assert.deepEqual(await getTenant(fakeDb([{ rows: [row] }]), "user-1"), {
    accountId: "user-1",
    schema: "tenant_abc",
    role: "tenant_abc",
    quotaBytes: 134_217_728,
    readOnly: false,
  });
  assert.equal(await getTenant(fakeDb([{ rows: [] }]), "user-1"), null);
  const list = await listTenants(fakeDb([{ rows: [row, { ...row, account_id: "user-2" }] }]));
  assert.equal(list.length, 2);
});

function tenant(overrides: Partial<TenantRecord> = {}): TenantRecord {
  return {
    accountId: "user-1",
    schema: "tenant_abc",
    role: "tenant_abc",
    quotaBytes: 100,
    readOnly: false,
    ...overrides,
  };
}

test("квота включает read-only при превышении и снимает его после освобождения", async () => {
  const over = fakeDb([{ rows: [{ bytes: 200 }] }, { rows: [] }, { rows: [] }]);
  const first = await applyTenantQuota(over, tenant(), 100);
  assert.equal(first.readOnly, true);
  assert.ok(over.calls.some(call => /default_transaction_read_only = on/.test(call.sql)));
  const update = over.calls.find(call => call.sql.includes("SET quota_bytes"));
  assert.deepEqual(update?.values, ["user-1", 100, true]);

  const under = fakeDb([{ rows: [{ bytes: 10 }] }, { rows: [] }, { rows: [] }]);
  const second = await applyTenantQuota(under, tenant({ readOnly: true }), 100);
  assert.equal(second.readOnly, false);
  assert.ok(under.calls.some(call => /default_transaction_read_only = off/.test(call.sql)));
});

test("статус снимает устаревший read-only у пустой базы и обновляет квоту", async () => {
  const db = fakeDb([{ rows: [{ bytes: "0" }] }, { rows: [] }, { rows: [] }]);
  const result = await reconcileTenantQuota(db, tenant({ readOnly: true, quotaBytes: 0 }), 134_217_728);
  assert.equal(result.usedBytes, 0);
  assert.equal(result.readOnly, false);
  assert.ok(db.calls.some(call => /default_transaction_read_only = off/.test(call.sql)));
  const update = db.calls.find(call => call.sql.includes("SET quota_bytes"));
  assert.deepEqual(update?.values, ["user-1", 134_217_728, false]);
});

test("нулевая квота (тариф без базы) всегда read-only и данные не удаляет", async () => {
  const db = fakeDb([{ rows: [{ bytes: 0 }] }, { rows: [] }, { rows: [] }]);
  const result = await applyTenantQuota(db, tenant(), 0);
  assert.equal(result.readOnly, true);
  assert.ok(db.calls.some(call => /default_transaction_read_only = on/.test(call.sql)));
  assert.ok(!db.calls.some(call => /DROP/i.test(call.sql)));
});

test("повторная проверка без изменения состояния не трогает роль", async () => {
  const db = fakeDb([{ rows: [{ bytes: 200 }] }, { rows: [] }]);
  await applyTenantQuota(db, tenant({ readOnly: true }), 100);
  assert.ok(!db.calls.some(call => /ALTER ROLE/.test(call.sql)));
});
