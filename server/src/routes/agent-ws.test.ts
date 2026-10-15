import test from "node:test";
import assert from "node:assert/strict";
import { MAX_REQUEST_MESSAGES,newUserMessages,requestErrorMessage,runSchema } from "./agent-ws.js";
import type { ChatMessage } from "../types.js";

const stored: ChatMessage[] = [
  { role: "user", content: "сделай страницу" },
  { role: "assistant", content: "Готово." },
];

test("only the messages the conversation does not hold yet are appended", () => {
  const incoming = [
    { role: "user", content: "сделай страницу" },
    { role: "assistant", content: "Готово." },
    { role: "user", content: "добавь форму" },
  ];
  assert.deepEqual(newUserMessages(stored, incoming), [{ role: "user", content: "добавь форму" }]);
});

test("the same words sent twice are stored twice, not dropped", () => {
  const incoming = [
    { role: "user", content: "сделай страницу" },
    { role: "user", content: "продолжай" },
    { role: "user", content: "продолжай" },
  ];
  assert.deepEqual(newUserMessages(stored, incoming), [
    { role: "user", content: "продолжай" },
    { role: "user", content: "продолжай" },
  ]);
});

test("a history the conversation already holds appends nothing", () => {
  assert.deepEqual(newUserMessages(stored, [{ role: "user", content: "сделай страницу" }]), []);
});

// Каждый шаг агента сохраняет ответ и результат инструмента, поэтому длинный диалог легко переходит
// сотню сообщений — раньше запуск падал на проверке схемы, и пользователь видел JSON от Zod.
test("a conversation past a hundred messages still starts", () => {
  const messages = Array.from({ length: 150 }, (_, index) => ({ role: "user" as const, content: "шаг " + index }));
  assert.equal(runSchema.parse({ projectId: "p1", messages }).messages.length, 150);
});

test("the too-long error reaches the panel as an ordinary sentence", () => {
  const messages = Array.from({ length: MAX_REQUEST_MESSAGES + 1 }, () => ({ role: "user" as const, content: "x" }));
  const result = runSchema.safeParse({ projectId: "p1", messages });
  assert.equal(result.success, false);
  if (result.success) return;
  const text = requestErrorMessage(result.error);
  assert.match(text, /слишком длинная/);
  assert.ok(!text.includes("too_big"), "служебный код не должен доходить до пользователя");
});

test("other failures keep their own wording", () => {
  assert.equal(requestErrorMessage(new Error("Проект не найден")), "Проект не найден");
  assert.equal(requestErrorMessage("строка"), "строка");
});
