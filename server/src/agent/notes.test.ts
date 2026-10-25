import test from "node:test";
import assert from "node:assert/strict";
import {
  NOTES_MAX_CHARS,
  NOTES_MAX_LINES,
  NOTES_PREFIX,
  findNoteLines,
  formatNoteLine,
  normalizeNoteTags,
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

test("теги приводятся к одному виду и не дублируются", () => {
  assert.deepEqual(normalizeNoteTags(["#UI", "auth", "UI", " deploy ", "плохой тег!"]), ["ui", "auth", "deploy"]);
  assert.deepEqual(normalizeNoteTags("ui, auth deploy"), ["ui", "auth", "deploy"]);
  assert.deepEqual(normalizeNoteTags(["a", "b", "c", "d", "e", "f"]), ["a", "b", "c", "d", "e"]);
});

test("строка заметки сохраняет тип и метки", () => {
  assert.equal(formatNoteLine("decision", "  тёмная палитра  ", ["ui"]), "- [решено] тёмная палитра · #ui");
  assert.equal(formatNoteLine("fact", "шрифт Inter"), "- [факт] шрифт Inter");
});

test("поиск по тексту и точной метке возвращает свежие совпадения", () => {
  const lines = [
    "- [решено] палитра тёмная · #ui",
    "- [факт] шрифт Inter · #ui #type",
    "- [решено] авторизация через телефон · #auth",
  ];
  assert.deepEqual(findNoteLines(lines, "палитра").lines, [lines[0]]);
  assert.deepEqual(findNoteLines(lines, "", "ui").lines, [lines[0], lines[1]]);
  assert.deepEqual(findNoteLines(lines, "", "uix").lines, [], "метка не совпадает по префиксу");
  assert.deepEqual(findNoteLines(lines, "inter", "ui", 1).lines, [lines[1]]);
});
