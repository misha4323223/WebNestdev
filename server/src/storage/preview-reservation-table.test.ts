import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { ensurePreviewReservationTable } from "./preview-reservation-table.js";

test("reservation table migration adds the runtime mode without dropping live rows", async () => {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(String(sql));
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;

  await ensurePreviewReservationTable(pool, "preview_reservations");

  const all = queries.join("\n");
  assert.match(all, /mode TEXT NOT NULL DEFAULT 'container'/);
  assert.match(all, /ALTER TABLE "preview_reservations" ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'container'/);
  assert.match(all, /CREATE INDEX IF NOT EXISTS idx_preview_reservations_expires/);
});
