import test from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "../types.js";
import {
  WORKING_STATE_PREFIX,
  createWorkingMemory,
  recordWorkingChange,
  recordWorkingCheck,
  setWorkingCheck,
  setWorkingPlan,
  withWorkingState,
  workingStateText,
} from "./working-memory.js";

const plan = {
  items: [
    { title: "Разобрать макет", status: "done" as const },
    { title: "Собрать страницу", status: "in_progress" as const },
    { title: "Проверить в браузере", status: "pending" as const },
  ],
  updatedAt: "2026-11-03T00:00:00.000Z",
};

test("рабочее состояние несёт цель, план, изменения и проверки", () => {
  const memory = createWorkingMemory("сделай лендинг для клиники");
  setWorkingPlan(memory, plan);
  recordWorkingChange(memory, "src/App.tsx", "записан, 1200 Б");
  recordWorkingCheck(memory, "сборка: пройдена");

  const text = workingStateText(memory);
  assert.match(text, /^\[ТЕКУЩЕЕ СОСТОЯНИЕ\]/);
  assert.match(text, /Цель: сделай лендинг для клиники/);
  assert.match(text, /\[сейчас\] Собрать страницу/);
  assert.match(text, /Сейчас: Собрать страницу/);
  assert.match(text, /Следующий шаг: Проверить в браузере/);
  assert.match(text, /src\/App\.tsx/);
  assert.match(text, /сборка: пройдена/);
});

test("предыдущий блок заменяется, а не копится в конце промпта", () => {
  let memory = createWorkingMemory("первая цель");
  const first = withWorkingState([
    { role: "system", content: "промпт" },
    { role: "user", content: "задача" },
  ], memory);
  assert.equal(first.at(-1)?.content.startsWith(WORKING_STATE_PREFIX), true);

  memory = createWorkingMemory("вторая цель");
  const second = withWorkingState([...first, { role: "assistant", content: "шаг" } as ChatMessage], memory);
  assert.equal(second.filter(message => message.content.startsWith(WORKING_STATE_PREFIX)).length, 1);
  assert.equal(second.at(-1)?.content.includes("вторая цель"), true);
  // Всё, что было до состояния, остаётся байт-в-байт: префикс кэша DeepSeek не меняется.
  assert.deepEqual(second.slice(0, first.length - 1), first.slice(0, -1));
});

test("план с прошлого этапа помечается, чтобы новая задача его заменила", () => {
  const memory = createWorkingMemory("продолжить", plan);
  memory.planFromPreviousRun = true;
  assert.match(workingStateText(memory), /сохранён с прошлого этапа/);
});

test("изменения и проверки ограничены, а повтор проверки не дублируется", () => {
  const memory = createWorkingMemory("задача");
  for (let index = 0; index < 30; index++) recordWorkingChange(memory, "file" + index + ".ts", "записан");
  assert.equal(memory.changed.size, 12);
  assert.equal(memory.changed.has("file29.ts"), true);
  assert.equal(memory.changed.has("file0.ts"), false);

  for (let index = 0; index < 20; index++) recordWorkingCheck(memory, "проверка " + index);
  recordWorkingCheck(memory, "проверка 19");
  assert.equal(memory.checks.length, 8);
  assert.equal(memory.checks.at(-1), "проверка 19");
  assert.equal(memory.checks.filter(item => item === "проверка 19").length, 1);

  setWorkingCheck(memory, "сборка", "пройдена");
  setWorkingCheck(memory, "сборка", "ошибка");
  assert.equal(memory.checks.filter(item => item.startsWith("сборка:")).length, 1);
  assert.equal(memory.checks.at(-1), "сборка: ошибка");
});
