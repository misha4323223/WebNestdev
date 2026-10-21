import test from "node:test";
import assert from "node:assert/strict";
import { projectArchiveIdleMs } from "./archive-scheduler.js";

/**
 * Порог простоя читается из окружения при каждом вызове, поэтому тест может переставлять
 * переменные и не зависеть от того, что лежит в рабочем .env. Дни сохранены ради установок,
 * которые настроили холодный ярус до появления минут.
 */
function withEnv(values: { minutes?: string; days?: string }, action: () => void) {
  const savedMinutes = process.env.PROJECT_ARCHIVE_IDLE_MINUTES;
  const savedDays = process.env.PROJECT_ARCHIVE_IDLE_DAYS;
  try {
    if (values.minutes === undefined) delete process.env.PROJECT_ARCHIVE_IDLE_MINUTES;
    else process.env.PROJECT_ARCHIVE_IDLE_MINUTES = values.minutes;
    if (values.days === undefined) delete process.env.PROJECT_ARCHIVE_IDLE_DAYS;
    else process.env.PROJECT_ARCHIVE_IDLE_DAYS = values.days;
    action();
  } finally {
    if (savedMinutes === undefined) delete process.env.PROJECT_ARCHIVE_IDLE_MINUTES;
    else process.env.PROJECT_ARCHIVE_IDLE_MINUTES = savedMinutes;
    if (savedDays === undefined) delete process.env.PROJECT_ARCHIVE_IDLE_DAYS;
    else process.env.PROJECT_ARCHIVE_IDLE_DAYS = savedDays;
  }
}

test("по умолчанию проект уходит в бакет после шести часов простоя", () => {
  withEnv({}, () => {
    assert.equal(projectArchiveIdleMs(), 6 * 60 * 60 * 1000);
  });
});

test("минуты важнее дней: старое значение в .env не перебивает новое", () => {
  withEnv({ minutes: "90", days: "14" }, () => {
    assert.equal(projectArchiveIdleMs(), 90 * 60 * 1000);
  });
});

test("старый PROJECT_ARCHIVE_IDLE_DAYS продолжает работать", () => {
  withEnv({ days: "2" }, () => {
    assert.equal(projectArchiveIdleMs(), 2 * 24 * 60 * 60 * 1000);
  });
});

test("порог не опускается ниже минуты", () => {
  withEnv({ minutes: "0" }, () => {
    assert.equal(projectArchiveIdleMs(), 60 * 1000);
  });
});
