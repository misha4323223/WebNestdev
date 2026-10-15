import test from "node:test";
import assert from "node:assert/strict";
import { MAX_REQUEST_MESSAGES,newUserMessages,requestErrorMessage,runHeartbeatMs,runSchema } from "./agent-ws.js";
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

/**
 * Долгий шаг молчит — модель думает или ждёт лимит провайдера, — и молчащий сокет закрывает прокси
 * на пути; для сервера это обрыв и отмена работы. Поэтому интервал «жив» проверяется, включая
 * случай опечатки в настройке: ноль или мусор не должны выключить его совсем.
 */
test("интервал «жив» остаётся разумным даже при мусоре в настройке", () => {
  const before = process.env.AGENT_RUN_HEARTBEAT_MS;
  try {
    delete process.env.AGENT_RUN_HEARTBEAT_MS;
    assert.equal(runHeartbeatMs(), 20000);
    process.env.AGENT_RUN_HEARTBEAT_MS = "0";
    assert.equal(runHeartbeatMs(), 20000);
    process.env.AGENT_RUN_HEARTBEAT_MS = "abc";
    assert.equal(runHeartbeatMs(), 20000);
    process.env.AGENT_RUN_HEARTBEAT_MS = "5000";
    assert.equal(runHeartbeatMs(), 5000);
  } finally {
    if (before === undefined) delete process.env.AGENT_RUN_HEARTBEAT_MS;
    else process.env.AGENT_RUN_HEARTBEAT_MS = before;
  }
});

test("other failures keep their own wording", () => {
  assert.equal(requestErrorMessage(new Error("Проект не найден")), "Проект не найден");
  assert.equal(requestErrorMessage("строка"), "строка");
});
