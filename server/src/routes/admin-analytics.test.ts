import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Проверяются чистые функции периода и ряда: именно они решают, совпадает ли график с днями
 * календаря и считается ли «было/стало» за равные окна. Маршруты требуют Postgres, поэтому их
 * форма проверяется типом, а арифметика — здесь.
 *
 * Переменные окружения выставляются до импорта: admin-store читает тип хранилища и каталог данных
 * при загрузке модуля.
 */
process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "admin-analytics-"));

const { fillDays, periodStart, previousPeriod } = await import("./admin-analytics.js");

test("ряд содержит ровно days точек и заканчивается сегодняшним днём", () => {
  const points = fillDays([], 7, "2026-10-26");
  assert.equal(points.length, 7);
  assert.equal(points[0].date, "2026-10-20");
  assert.equal(points[points.length - 1].date, "2026-10-26");
});

test("день без расхода приходит нулями, а не выпадает из ряда", () => {
  const filled = fillDays(
    [
      { date: "2026-10-24", prompt: 120, completion: 45, runs: 2 },
      { date: "2026-10-26", prompt: 10, completion: 5, runs: 1 },
    ],
    3,
    "2026-10-26",
  );
  assert.deepEqual(filled.map(point => point.date), ["2026-10-24", "2026-10-25", "2026-10-26"]);
  assert.deepEqual(filled[1], { date: "2026-10-25", prompt: 0, completion: 0, runs: 0 });
  assert.equal(filled[2].prompt, 10);
});

test("окно из days дней начинается за days-1 дней до конца", () => {
  assert.equal(periodStart(7, new Date("2026-10-26T12:00:00Z")), "2026-10-20");
  assert.equal(periodStart(1, new Date("2026-10-26T12:00:00Z")), "2026-10-26");
});

test("предыдущее окно той же длины заканчивается днём до текущего", () => {
  // Текущее окно при days=7 и from=2026-10-20 — это 20..26, значит предыдущее — 13..19.
  assert.deepEqual(previousPeriod("2026-10-20", 7), { prevFrom: "2026-10-13", prevTo: "2026-10-19" });
  assert.deepEqual(previousPeriod("2026-10-26", 1), { prevFrom: "2026-10-25", prevTo: "2026-10-25" });
});
