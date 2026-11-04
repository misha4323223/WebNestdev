import test from "node:test";
import assert from "node:assert/strict";
import { createReasoningBlock, reasoningBlockTitle } from "./reasoning-blocks.js";

test("подпись шага показывает действие, а не только номер", () => {
  assert.equal(reasoningBlockTitle(1, [{ name: "fs.read" }]), "Шаг 1 · чтение файла");
  assert.equal(reasoningBlockTitle(2, [{ name: "terminal.exec" }]), "Шаг 2 · команда");
  assert.match(reasoningBlockTitle(3, [{ name: "fs.write" }, { name: "terminal.exec" }]), /Шаг 3 · запись файла \+1/);
  assert.equal(reasoningBlockTitle(4), "Шаг 4 · ответ");
});

test("узел шага сохраняет запуск, номер и статус", () => {
  const block = createReasoningBlock({
    runId: "run-1",
    step: 2,
    text: "сначала прочитаю файл",
    calls: [{ name: "fs.read" }],
    startedAt: "2026-11-04T10:00:00.000Z",
    finishedAt: "2026-11-04T10:00:01.000Z",
  });
  assert.equal(block.runId, "run-1");
  assert.equal(block.step, 2);
  assert.equal(block.status, "done");
  assert.equal(block.title, "Шаг 2 · чтение файла");
  assert.equal(block.parentId, undefined);
  assert.equal(block.startedAt, "2026-11-04T10:00:00.000Z");
  assert.equal(block.finishedAt, "2026-11-04T10:00:01.000Z");
});

test("узел может быть ребёнком другого узла", () => {
  const block = createReasoningBlock({
    runId: "run-1",
    step: 3,
    text: "проверяю гипотезу",
    parentId: "step-2",
    kind: "subagent",
  });
  assert.equal(block.parentId, "step-2");
  assert.equal(block.kind, "subagent");
});
