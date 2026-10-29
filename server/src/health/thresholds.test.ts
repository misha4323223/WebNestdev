import test from "node:test";
import assert from "node:assert/strict";
import { buildHealthChecks, healthStatus, HEALTH_THRESHOLDS, type HealthInput } from "./thresholds.js";

const base: HealthInput = {
  diskUsedPercent: 10,
  memoryUsedPercent: 10,
  swapUsedPercent: 10,
  swapConfigured: true,
  archiveErrorsLastHour: 0,
  backupApplicable: true,
  backupAgeHours: 1,
};

const check = (input: Partial<HealthInput>, id: string) =>
  buildHealthChecks({ ...base, ...input }).find(item => item.id === id)!;

test("порог диска: 75% — уже плохо, 74.9% — ещё норма", () => {
  assert.equal(check({ diskUsedPercent: 74.9 }, "disk").ok, true);
  assert.equal(check({ diskUsedPercent: HEALTH_THRESHOLDS.diskUsedPercent }, "disk").ok, false);
  assert.equal(check({ diskUsedPercent: 91.24 }, "disk").value, 91.2);
  assert.equal(check({ diskUsedPercent: null }, "disk").ok, null, "неизмеренный диск — не «хорошо»");
});

test("порог памяти: 85% считается занятым", () => {
  assert.equal(check({ memoryUsedPercent: 84.9 }, "memory").ok, true);
  assert.equal(check({ memoryUsedPercent: 85 }, "memory").ok, false);
  assert.equal(check({ memoryUsedPercent: null }, "memory").ok, null);
});

test("swap: без swap проверка не применима, с swap порог 50%", () => {
  const absent = check({ swapUsedPercent: null, swapConfigured: false }, "swap");
  assert.equal(absent.ok, true);
  assert.equal(absent.value, null);
  assert.match(absent.detail ?? "", /не настроен/);
  assert.equal(check({ swapUsedPercent: 49.9, swapConfigured: true }, "swap").ok, true);
  assert.equal(check({ swapUsedPercent: 50, swapConfigured: true }, "swap").ok, false);
});

test("ошибки архивации: любая ошибка за час — тревога", () => {
  assert.equal(check({ archiveErrorsLastHour: 0 }, "archive").ok, true);
  assert.equal(check({ archiveErrorsLastHour: 1 }, "archive").ok, false);
  assert.equal(check({ archiveErrorsLastHour: -5 }, "archive").value, 0, "отрицательное число не бывает");
});

test("бэкап: 30 часов — граница, отсутствие манифеста — тревога", () => {
  assert.equal(check({ backupAgeHours: 30 }, "backup").ok, true);
  assert.equal(check({ backupAgeHours: 30.1 }, "backup").ok, false);
  const missing = check({ backupAgeHours: null }, "backup");
  assert.equal(missing.ok, false);
  assert.match(missing.detail ?? "", /манифест/);
  const notApplicable = check({ backupApplicable: false, backupAgeHours: null }, "backup");
  assert.equal(notApplicable.ok, true);
  assert.match(notApplicable.detail ?? "", /JSON/);
});

test("общий статус: ошибка важнее неизвестного, неизвестное важнее нормы", () => {
  const good = buildHealthChecks(base);
  assert.equal(healthStatus(good), "ok");
  assert.equal(healthStatus(buildHealthChecks({ ...base, diskUsedPercent: null })), "unknown");
  assert.equal(
    healthStatus(buildHealthChecks({ ...base, diskUsedPercent: null, memoryUsedPercent: 99 })),
    "degraded",
  );
  assert.equal(healthStatus(buildHealthChecks({ ...base, archiveErrorsLastHour: 1 })), "degraded");
});
