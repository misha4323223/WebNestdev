import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Журнал безопасности проверяется на JSON-хранилище: временный каталог, никакой базы.
 * `WEBNESTDEV_DATA_DIR` выставляется до импорта — путь к файлу журнала считается из окружения.
 */
const root = await mkdtemp(path.join(tmpdir(), "wnd-security-audit-"));
process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = root;

const { auditJournalFile, cleanAuditDetails, listAudit, recordAudit } = await import("./audit-journal.js");
const { hashAuditIp } = await import("../secrets/secret-audit.js");

test("журнал хранит действие и подробности, но не значения секретов", async () => {
  await recordAudit({
    action: "platform.keys.updated",
    actorType: "user",
    actorId: "u1",
    actorLabel: "admin@example.test",
    ip: "203.0.113.5",
    details: {
      saved: "GITHUB_CLIENT_SECRET,YANDEX_CLOUD_ID",
      // Объект и функция не должны попасть в журнал даже случайно.
      request: { password: "super-secret" },
      handler: () => "nope",
      long: "x".repeat(400),
    },
  });
  await recordAudit({
    action: "project.deleted",
    actorType: "user",
    actorId: "u2",
    actorLabel: "client@example.test",
    target: "p1",
    targetLabel: "Интернет-магазин",
    ip: "203.0.113.6",
  });

  const raw = await readFile(auditJournalFile(), "utf8");
  assert.doesNotMatch(raw, /super-secret/);
  assert.match(raw, /GITHUB_CLIENT_SECRET/);
  // IP не хранится открытым: только хеш.
  assert.doesNotMatch(raw, /203\.0\.113\.5/);
  assert.match(raw, new RegExp(hashAuditIp("203.0.113.5")));

  const entries = await listAudit();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].action, "project.deleted");
  assert.equal(entries[0].targetLabel, "Интернет-магазин");
  assert.equal(entries[1].details.saved, "GITHUB_CLIENT_SECRET,YANDEX_CLOUD_ID");
  assert.equal(entries[1].details.long, "x".repeat(300));
  assert.equal(entries[1].details.request, undefined);
  assert.equal(entries[1].details.handler, undefined);
});

test("фильтры по действию и актору не смешивают события", async () => {
  const byAction = await listAudit({ action: "project.deleted" });
  assert.deepEqual(byAction.map(entry => entry.action), ["project.deleted"]);

  const byActor = await listAudit({ actorId: "u1" });
  assert.equal(byActor.length, 1);
  assert.equal(byActor[0].action, "platform.keys.updated");

  const byUnknown = await listAudit({ action: "admin.login.failed" });
  assert.deepEqual(byUnknown, []);
});

test("будущее окно не показывает старые события, а limit ограничивает ответ", async () => {
  const recent = await listAudit({ days: 1 });
  assert.equal(recent.length, 2);
  const limited = await listAudit({ limit: 1 });
  assert.equal(limited.length, 1);
  // Порядок — новые сверху, поэтому в одном событии остаётся последнее.
  assert.equal(limited[0].action, "project.deleted");
});

test("повреждённая строка журнала не скрывает остальные события", async () => {
  const file = auditJournalFile();
  const raw = await readFile(file, "utf8");
  await writeFile(file, "{не json}\n" + raw, { mode: 0o600 });

  const entries = await listAudit();
  assert.equal(entries.length, 2);
});

test("очистка подробностей отбрасывает небезопасные имена и значения", () => {
  const cleaned = cleanAuditDetails({
    "good-key": "ok",
    "ключ с пробелами": "нет",
    count: 3,
    enabled: true,
    nan: Number.NaN,
    data: { nested: true },
  });
  assert.deepEqual(cleaned, { "good-key": "ok", count: 3, enabled: true });
});
