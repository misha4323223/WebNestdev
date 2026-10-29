import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildHealthChecks, type HealthInput } from "./thresholds.js";

const base: HealthInput = {
  diskUsedPercent: 10,
  memoryUsedPercent: 10,
  swapUsedPercent: 10,
  swapConfigured: true,
  archiveErrorsLastHour: 0,
  backupApplicable: true,
  backupAgeHours: 1,
};
const good = () => buildHealthChecks(base);
const badDisk = () => buildHealthChecks({ ...base, diskUsedPercent: 91 });

const { resetAlerts, runAlertCycle, alertEmail, alertEmailSource, confirmAlertRecipient } = await import("./alerts.js");

test("первое письмо, пауза, напоминание и восстановление", async () => {
  resetAlerts();
  let now = Date.parse("2026-10-29T12:00:00.000Z");
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  let checks = badDisk();
  const deps = {
    checks: async () => checks,
    email: () => "ops@example.test",
    send: async (mail: { to: string; subject: string; text: string }) => { sent.push(mail); },
    now: () => now,
    reminderMs: 6 * 60 * 60 * 1000,
    log: () => {},
  };

  assert.equal((await runAlertCycle(deps)).sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "ops@example.test");
  assert.match(sent[0].subject, /Алерт: Диск/);
  assert.match(sent[0].text, /Диск: 91%/);

  // Тот же сбой через минуту — письма нет.
  now += 60_000;
  assert.equal((await runAlertCycle(deps)).sent, false);
  assert.equal((await runAlertCycle(deps)).reason, "cooldown");
  assert.equal(sent.length, 1);

  // Прошло окно напоминания — снова письмо.
  now += 6 * 60 * 60 * 1000;
  assert.equal((await runAlertCycle(deps)).sent, true);
  assert.equal(sent.length, 2);

  // Восстановление — отдельное письмо.
  checks = good();
  now += 60_000;
  assert.equal((await runAlertCycle(deps)).sent, true);
  assert.equal(sent.length, 3);
  assert.match(sent[2].subject, /Восстановление: Диск/);

  // После восстановления состояние пустое: следующий сбой снова новое письмо.
  checks = badDisk();
  now += 60_000;
  assert.equal((await runAlertCycle(deps)).sent, true);
  assert.equal(sent.length, 4);
});

test("без ALERT_EMAIL письма не отправляются и состояние не меняется", async () => {
  resetAlerts();
  let now = Date.parse("2026-10-29T13:00:00.000Z");
  let attempts = 0;
  const deps = {
    checks: async () => badDisk(),
    email: () => null,
    send: async () => { attempts++; },
    now: () => now,
    reminderMs: 60_000,
    log: () => {},
  };
  const result = await runAlertCycle(deps);
  assert.equal(result.sent, false);
  assert.equal(result.reason, "no-email");
  assert.equal(attempts, 0);

  // Адрес появился — первая же проверка отправляет, хотя сбой был давно.
  now += 24 * 60 * 60 * 1000;
  const withEmail = { ...deps, email: () => "ops@example.test" };
  assert.equal((await runAlertCycle(withEmail)).sent, true);
  assert.equal(attempts, 1);
});

test("ошибка отправки не считается отправкой и повторяется", async () => {
  resetAlerts();
  let attempts = 0;
  const deps = {
    checks: async () => badDisk(),
    email: () => "ops@example.test",
    send: async () => {
      attempts++;
      if (attempts === 1) throw new Error("smtp down");
    },
    now: () => Date.parse("2026-10-29T14:00:00.000Z"),
    reminderMs: 6 * 60 * 60 * 1000,
    log: () => {},
  };
  assert.equal((await runAlertCycle(deps)).reason, "send-failed");
  assert.equal((await runAlertCycle(deps)).sent, true);
  assert.equal(attempts, 2);
  resetAlerts();
});

test("без ALERT_EMAIL получатель — адрес администратора", () => {
  const alertBefore = process.env.ALERT_EMAIL;
  const adminBefore = process.env.ADMIN_BOOTSTRAP_EMAIL;
  try {
    delete process.env.ALERT_EMAIL;
    process.env.ADMIN_BOOTSTRAP_EMAIL = "owner@example.test";
    assert.equal(alertEmail(), "owner@example.test");
    assert.equal(alertEmailSource(), "ADMIN_BOOTSTRAP_EMAIL");

    // Явный адрес важнее адреса администратора.
    process.env.ALERT_EMAIL = "ops@example.test";
    assert.equal(alertEmail(), "ops@example.test");
    assert.equal(alertEmailSource(), "ALERT_EMAIL");

    // Опечатка в явном адресе не подменяется молча адресом администратора.
    process.env.ALERT_EMAIL = "не адрес";
    assert.equal(alertEmail(), null);
    assert.equal(alertEmailSource(), null);

    delete process.env.ALERT_EMAIL;
    delete process.env.ADMIN_BOOTSTRAP_EMAIL;
    assert.equal(alertEmail(), null);
  } finally {
    if (alertBefore === undefined) delete process.env.ALERT_EMAIL;
    else process.env.ALERT_EMAIL = alertBefore;
    if (adminBefore === undefined) delete process.env.ADMIN_BOOTSTRAP_EMAIL;
    else process.env.ADMIN_BOOTSTRAP_EMAIL = adminBefore;
  }
});

test("подтверждение канала уходит один раз на адрес", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "alerts-confirm-"));
  const stateFile = path.join(root, "health", "alert-recipient.txt");
  const sent: string[] = [];
  const logs: string[] = [];
  let email = "owner@example.test";
  const deps = {
    email: () => email,
    send: async (mail: { to: string; subject: string; text: string }) => { sent.push(mail.to); },
    stateFile,
    log: (message: string) => { logs.push(message); },
  };
  try {
    // Первый запуск: адрес не подтверждён — письмо и запись адреса.
    assert.deepEqual(await confirmAlertRecipient(deps), { sent: true, reason: "changed" });
    assert.deepEqual(sent, ["owner@example.test"]);
    assert.equal((await readFile(stateFile, "utf8")).trim(), "owner@example.test");

    // Повторный запуск с тем же адресом молчит.
    assert.deepEqual(await confirmAlertRecipient(deps), { sent: false, reason: "unchanged" });
    assert.equal(sent.length, 1);

    // Смена адреса снова подтверждается.
    email = "ops@example.test";
    assert.deepEqual(await confirmAlertRecipient(deps), { sent: true, reason: "changed" });
    assert.deepEqual(sent, ["owner@example.test", "ops@example.test"]);

    // Ошибка отправки не запоминает новый адрес: следующий запуск повторит.
    email = "third@example.test";
    await assert.rejects(confirmAlertRecipient({ ...deps, send: async () => { throw new Error("smtp down"); } }), /smtp down/);
    assert.equal((await readFile(stateFile, "utf8")).trim(), "ops@example.test");
    assert.match(logs.join("\n"), /канал подтверждён/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
