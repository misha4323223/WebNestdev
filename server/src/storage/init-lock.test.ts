import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { acquireStorageInitLock } from "./init-lock.js";

function fakePool(options: { fail?: boolean } = {}) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  let releases = 0;
  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (options.fail) throw new Error("lock failed");
      return { rows: [] };
    },
    release() {
      releases += 1;
    },
  };
  return {
    pool: { connect: async () => client } as unknown as Pick<Pool, "connect">,
    calls,
    releases: () => releases,
  };
}

test("блокирующий лок берётся на выделенном соединении и снимается один раз", async () => {
  const fake = fakePool();
  const lock = await acquireStorageInitLock(fake.pool);

  assert.match(fake.calls[0]?.sql ?? "", /pg_advisory_lock/);
  assert.deepEqual(fake.calls[0]?.params, ["webnestdev:storage-init"]);

  await lock.release();
  await lock.release();

  assert.equal(fake.releases(), 1);
  assert.match(fake.calls.at(-1)?.sql ?? "", /pg_advisory_unlock/);
});

test("ошибка взятия лока возвращает соединение в пул", async () => {
  const fake = fakePool({ fail: true });

  await assert.rejects(() => acquireStorageInitLock(fake.pool), /lock failed/);
  assert.equal(fake.releases(), 1);
});
