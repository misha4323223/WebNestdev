import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { ensurePreviewTable } from "./preview-table.js";

test("preview table migration is additive and accepts hybrid rows", async () => {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(String(sql));
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;

  await ensurePreviewTable(pool, "previews");

  const all = queries.join("\n");
  assert.match(all, /backend_host TEXT NOT NULL DEFAULT ''/);
  assert.match(all, /backend_port INTEGER/);
  assert.match(all, /CHECK \(mode IN \('container', 'static', 'hybrid'\)\)/);
  assert.match(all, /ALTER TABLE "previews" ADD COLUMN IF NOT EXISTS backend_host/);
  assert.match(all, /ALTER TABLE "previews" ADD COLUMN IF NOT EXISTS backend_port/);
  assert.match(all, /ALTER TABLE "previews" DROP CONSTRAINT IF EXISTS previews_mode_check/);
});
