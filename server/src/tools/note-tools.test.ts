import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getTool } from "../tool-registry.js";

/**
 * Заметка решений проверяется через настоящий инструмент и настоящий файл: смысл в том, что
 * договорённость переживает следующий запуск, а не в том, что строка красиво отформатирована.
 * Хранилище и песочницы уводятся во временный каталог до импорта модулей, которые читают
 * настройки при загрузке.
 */
const data = await mkdtemp(path.join(os.tmpdir(), "webnestdev-notes-"));
process.env.WEBNESTDEV_DATA_DIR = data;
process.env.WEBNESTDEV_SANDBOX_DIR = path.join(data, "sandboxes");
const { createProject } = await import("../project-store.js");
await import("./note-tools.js");

type NoteResult = { ok: boolean; added?: boolean; file?: string; notes?: string[]; error?: string };

test("note.remember пишет заметку в проект и не дублирует её", async t => {
  t.after(() => rm(data, { recursive: true, force: true }));
  const project = await createProject("Заметки", undefined, "u-notes");
  const tool = getTool("note.remember");
  assert.ok(tool?.execute);
  const context = { projectId: project.id, runId: "r", userId: "u-notes", conversationId: "conv-1" };

  const first = (await tool.execute({ text: "палитра #0E1A16, шрифт Inter" }, context)) as NoteResult;
  assert.equal(first.ok, true, first.error ?? "");
  assert.equal(first.added, true);
  assert.equal(first.file, ".webnestdev/notes-conv-1.md");

  // Файл лежит в проекте и назван разговором: заметки разных чатов не смешиваются.
  const raw = await readFile(path.join(data, "sandboxes", project.id, ".webnestdev", "notes-conv-1.md"), "utf8");
  assert.match(raw, /- \[решено\] палитра #0E1A16, шрифт Inter/);

  const again = (await tool.execute({ text: "палитра #0E1A16,  шрифт Inter" }, context)) as NoteResult;
  assert.equal(again.added, false, "та же договорённость не дублируется");
  assert.equal(again.notes?.length, 1);

  const rejected = (await tool.execute({ text: "тёмный герой отклонён", kind: "rejected" }, context)) as NoteResult;
  assert.equal(rejected.added, true);
  assert.deepEqual(rejected.notes, ["- [решено] палитра #0E1A16, шрифт Inter", "- [отклонено] тёмный герой отклонён"]);

  const otherChat = (await tool.execute({ text: "клиент — Анна", kind: "fact" }, { ...context, conversationId: "conv-2" })) as NoteResult;
  assert.equal(otherChat.file, ".webnestdev/notes-conv-2.md");
  assert.deepEqual(otherChat.notes, ["- [факт] клиент — Анна"], "заметки другого разговора начинаются с нуля");

  const tooShort = (await tool.execute({ text: "  " }, context)) as NoteResult;
  assert.equal(tooShort.ok, false, "пустая запись — отказ с понятной причиной");
  assert.match(tooShort.error ?? "", /короткий факт/);
});
