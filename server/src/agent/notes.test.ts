import test from "node:test";
import assert from "node:assert/strict";
import {
  NOTES_MAX_CHARS,
  NOTES_MAX_LINES,
  NOTES_PREFIX,
  formatNoteLine,
  notesFile,
  notesNotice,
  trimNoteLines,
} from "./notes.js";

test("запись заметки называет её тип до текста и не хранит переводы строк", () => {
  assert.equal(formatNoteLine("decision", "  палитра   #0E1A16\nшрифт Inter "), "- [решено] палитра #0E1A16 шрифт Inter");
  assert.equal(formatNoteLine("rejected", "тёмный герой"), "- [отклонено] тёмный герой");
  assert.equal(formatNoteLine("open", "нет телефона для футера"), "- [открыто] нет телефона для футера");
  assert.equal(formatNoteLine("fact", "клиент — Анна"), "- [факт] клиент — Анна");
});

test("заметки принадлежат разговору, а без него — проекту", () => {
  assert.equal(notesFile("abc-123"), ".webnestdev/notes-abc-123.md");
  assert.equal(notesFile(undefined), ".webnestdev/notes.md");
  // Идентификатор приходит из URL и не должен уводить путь наружу.
  assert.equal(notesFile("../../etc/passwd"), ".webnestdev/notes-etcpasswd.md");
});

test("старые записи вытесняются по числу строк", () => {
  const lines = Array.from({ length: NOTES_MAX_LINES + 10 }, (_, index) => "- [решено] решение " + index);
  const kept = trimNoteLines(lines);
  assert.equal(kept.length, NOTES_MAX_LINES);
  assert.equal(kept[0], "- [решено] решение 10");
  assert.equal(kept.at(-1), "- [решено] решение " + (NOTES_MAX_LINES + 9));
});

test("гигантские записи не раздувают файл сверх предела", () => {
  const lines = Array.from({ length: 40 }, (_, index) => "- [факт] " + index + " " + "я".repeat(300));
  const kept = trimNoteLines(lines);
  assert.ok(kept.join("\n").length <= NOTES_MAX_CHARS, "заметка уложилась в предел: " + kept.join("\n").length);
  assert.ok(kept.length > 1, "последние записи остаются, а не вытесняются все");
  assert.match(kept.at(-1) ?? "", /39/, "самая свежая запись на месте");
});

test("модель видит и пустую заметку, и заполненную — без путаницы с срезом истории", () => {
  const empty = notesNotice([]);
  assert.match(empty, new RegExp(NOTES_PREFIX));
  assert.match(empty, /note\.remember/, "без записей модель знает, что делать");

  const filled = notesNotice(["- [решено] палитра #0E1A16", "- [отклонено] тёмный герой"]);
  assert.match(filled, /^ПРИНЯТЫЕ РЕШЕНИЯ/);
  assert.match(filled, /палитра #0E1A16/);
  assert.match(filled, /не переспрашивай/, "согласованное не переспрашивают");
  assert.match(filled, /потому что|Новое решение/, "новая договорённость тоже записывается");
});
