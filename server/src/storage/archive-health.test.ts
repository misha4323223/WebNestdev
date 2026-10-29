import test from "node:test";
import assert from "node:assert/strict";
import { archiveErrorsLastHour, recordArchiveFailure, resetArchiveHealth } from "./archive-health.js";

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
