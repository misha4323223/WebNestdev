import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Каталог задаётся до импорта: archiveStateDir() читает окружение при каждом вызове, но
// хранилище в тестах должно быть файловым, как в локальной разработке.
const root = await mkdtemp(path.join(tmpdir(), "archive-state-"));
process.env.WEBNESTDEV_DATA_DIR = root;
process.env.WEBNESTDEV_STORAGE = "json";

const {
  archiveRecordFile,
  clearArchiveRecord,
  importArchiveRecords,
  importArchiveRecordsFromDisk,
  listArchiveRecords,
  parseArchiveRecord,
  readArchiveRecord,
  writeArchiveRecord,
} = await import("./project-archive-state.js");

after(async () => {
  await rm(root, { recursive: true, force: true });
});

function record(projectId: string, overrides: Record<string, unknown> = {}) {
  return {
    projectId,
    userId: "user-" + projectId,
    key: "test/projects/user-" + projectId + "/" + projectId + "/workspace.tar.gz",
    bytes: 1234,
    archivedAt: "2026-10-29T12:00:00.000Z",
    ...overrides,
  };
}

test("разбор отметки отбрасывает обрезанный JSON и пустые поля", () => {
  assert.deepEqual(parseArchiveRecord(record("p1")), record("p1"));
  assert.equal(parseArchiveRecord(null), null);
  assert.equal(parseArchiveRecord({}), null);
  assert.equal(parseArchiveRecord(record("p1", { projectId: "" })), null);
  assert.equal(parseArchiveRecord(record("p1", { key: "" })), null);
  assert.equal(parseArchiveRecord(record("p1", { bytes: -1 })), null);
  assert.equal(parseArchiveRecord(record("p1", { bytes: "abc" })), null);
  assert.equal(parseArchiveRecord(record("p1", { archivedAt: "не дата" })), null);
});

test("файловая отметка читается, попадает в список и снимается", async () => {
  const first = record("file-first");
  const second = record("file-second");
  await writeArchiveRecord(first);
  await writeArchiveRecord(second);

  assert.deepEqual(await readArchiveRecord(first.projectId), first);
  const listed = await listArchiveRecords();
  assert.deepEqual(listed.map(item => item.projectId).sort(), [first.projectId, second.projectId].sort());

  await clearArchiveRecord(first.projectId);
  assert.equal(await readArchiveRecord(first.projectId), null);
  await assert.rejects(() => readFile(archiveRecordFile(first.projectId)), /ENOENT/);
});

test("импорт JSON-отметок идемпотентен и не дублирует записи", async () => {
  const dir = path.join(root, "import-case");
  await mkdir(dir, { recursive: true });
  const first = record("import-first");
  const second = record("import-second");
  await writeFile(path.join(dir, "import-first.json"), JSON.stringify(first));
  await writeFile(path.join(dir, "import-second.json"), JSON.stringify(second));
  // Битый файл не должен останавливать импорт остальных.
  await writeFile(path.join(dir, "broken.json"), "{\"projectId\":");

  const inDb = new Set<string>();
  const insert = async (item: { projectId: string }) => {
    if (inDb.has(item.projectId)) return false;
    inDb.add(item.projectId);
    return true;
  };
  const logged: string[] = [];

  const firstRun = await importArchiveRecords(dir, insert, { log: message => logged.push(message) });
  assert.deepEqual(firstRun, { imported: 2, skipped: 0, failed: 1 });
  assert.deepEqual([...inDb].sort(), [first.projectId, second.projectId].sort());
  assert.match(logged.join("\n"), /broken\.json/);

  // Файлы намеренно остаются как снимок для отката: второй запуск видит их снова, но база
  // уже знает оба проекта, поэтому вставок нет.
  const secondRun = await importArchiveRecords(dir, insert, { log: () => {} });
  assert.deepEqual(secondRun, { imported: 0, skipped: 2, failed: 1 });
  assert.equal(inDb.size, 2);
});

test("в JSON-режиме стартовый импорт в базу ничего не делает", async () => {
  assert.deepEqual(await importArchiveRecordsFromDisk(), { imported: 0, skipped: 0, failed: 0 });
});
