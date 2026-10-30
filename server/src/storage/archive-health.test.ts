import test from "node:test";
import assert from "node:assert/strict";
import {
  archiveErrorsLastHour,
  archiveStats,
  recordArchiveFailure,
  recordArchiveRun,
  resetArchiveHealth,
} from "./archive-health.js";

test("счётчик ошибок архивации считает только последний час", () => {
  resetArchiveHealth();
  const now = Date.parse("2026-10-29T12:00:00.000Z");
  recordArchiveFailure(now - 2 * 60 * 60 * 1000);
  recordArchiveFailure(now - 59 * 60 * 1000);
  recordArchiveFailure(now - 1_000);
  assert.equal(archiveErrorsLastHour(now), 2, "двухчасовая ошибка уже вне окна");

  recordArchiveFailure(now);
  assert.equal(archiveErrorsLastHour(now), 3);

  // Время идёт вперёд: старые отметки выпадают, счётчик не растёт вечно.
  assert.equal(archiveErrorsLastHour(now + 61 * 60 * 1000), 0);
  resetArchiveHealth();
});

test("reset очищает окно между проверками", () => {
  resetArchiveHealth();
  recordArchiveFailure();
  assert.equal(archiveErrorsLastHour(), 1);
  resetArchiveHealth();
  assert.equal(archiveErrorsLastHour(), 0);
});

test("итоги архивации видны в health: последний проход, байты и ошибки", () => {
  resetArchiveHealth();
  recordArchiveRun({
    mode: "pressure",
    startedAt: "2026-10-30T10:00:00.000Z",
    finishedAt: "2026-10-30T10:00:03.000Z",
    durationMs: 3000,
    candidates: 3,
    archived: 2,
    skipped: 1,
    deferred: 0,
    failed: 1,
    bytesFreed: 42_000,
    diskBefore: 78,
    diskAfter: 66,
    targetPercent: 68,
    targetReached: true,
  });
  recordArchiveFailure();

  const stats = archiveStats();
  assert.equal(stats.archivedSinceStart, 2);
  assert.equal(stats.bytesFreedSinceStart, 42_000);
  assert.equal(stats.runsSinceStart, 1);
  assert.equal(stats.averageRunMs, 3000);
  assert.equal(stats.failedSinceStart, 1);
  assert.equal(stats.errorsLastHour, 1);
  assert.equal(stats.lastRun?.targetReached, true);
  assert.equal(stats.lastRun?.diskAfter, 66);
  resetArchiveHealth();
});
