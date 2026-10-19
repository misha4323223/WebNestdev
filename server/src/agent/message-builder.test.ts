import test from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "../types.js";
import { PLANNER_MODE_PROMPT, SYSTEM_PROMPT, buildInitialMessages, insertSystemNotice, storedHistory } from "./message-builder.js";

/**
 * The stored chat is the model's memory of a run, so what it hands to a provider has to be exactly
 * what a provider accepts. These tests pin the two rules that matter: the thinking is not sent back,
 * and a tool call and its result are never separated.
 */
test("история из хранилища: размышления остаются пользователю, а не провайдеру", () => {
  const stored: ChatMessage[] = [
    { role: "system", content: "промпт" },
    { role: "user", content: "сделай лендинг" },
    { role: "assistant", content: "готово", reasoning: "сначала посмотрю структуру проекта" },
  ];
  const history = storedHistory(stored);
  assert.equal(history.length, 2);
  assert.deepEqual(history[0], { role: "user", content: "сделай лендинг" });
  assert.equal(history[1].role, "assistant");
  assert.ok(!("reasoning" in history[1]), "размышление не возвращается провайдеру");
  assert.equal(history[1].content, "готово");
});

test("история из хранилища: пара «вызов + результат» сохраняется целиком", () => {
  const stored: ChatMessage[] = [
    { role: "user", content: "задача" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "fs.read", arguments: { path: "index.html" } }] },
    { role: "tool", content: "{\"content\":\"<html>\"}", tool_call_id: "c1" },
  ];
  const history = storedHistory(stored);
  assert.equal(history.length, 3);
  assert.equal(history[1].role, "assistant");
  assert.deepEqual(history[1].role === "assistant" ? history[1].tool_calls : undefined, [{ id: "c1", name: "fs.read", arguments: { path: "index.html" } }]);
  assert.equal(history[2].role, "tool");
});

// Провайдер отклоняет и результат без вызова, и вызов без результата, а прерванный посередине шага
// запуск оставляет ровно такую пару. И то и другое выбрасывается, а не «дочиняется» пустышкой.
test("история из хранилища: незакрытая пара вызова убирается, а не ломает запрос", () => {
  const stored: ChatMessage[] = [
    { role: "user", content: "задача" },
    { role: "assistant", content: "вызываю инструмент", tool_calls: [{ id: "c1", name: "terminal.exec", arguments: { command: "npm test" } }] },
  ];
  const history = storedHistory(stored);
  assert.equal(history.length, 2, "вызов без результата выброшен");
  assert.equal(history[1].role, "assistant");
  assert.ok(!(history[1].role === "assistant" && history[1].tool_calls), "у ответа не осталось висящего вызова");
  assert.equal(history[1].content, "вызываю инструмент", "текст ответа сохраняется");
});

test("история из хранилища: результат без своего вызова не отправляется", () => {
  const stored: ChatMessage[] = [
    { role: "user", content: "задача" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "fs.read", arguments: {} }, { id: "c2", name: "fs.list", arguments: {} }] },
    { role: "tool", content: "первый результат", tool_call_id: "c1" },
    { role: "tool", content: "результат без вызова", tool_call_id: "потерянный" },
  ];
  const history = storedHistory(stored);
  assert.equal(history.length, 3);
  assert.equal(history[2].role, "tool");
  assert.equal(history[2].role === "tool" ? history[2].tool_call_id : "", "c1");
  // У вызова, который остался без результата, исчезает сам вызов: пара рвётся с обеих сторон.
  const calls = history[1].role === "assistant" ? history[1].tool_calls : undefined;
  assert.deepEqual(calls?.map(call => call.id), ["c1"]);
});

test("системная заметка встаёт после промпта и контекста проекта", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "промпт" },
    { role: "system", content: "контекст проекта" },
    { role: "user", content: "задача" },
  ];
  const withNotice = insertSystemNotice(messages, "ПРОДОЛЖЕНИЕ");
  assert.deepEqual(withNotice.map(message => message.content), ["промпт", "контекст проекта", "ПРОДОЛЖЕНИЕ", "задача"]);
});

test("история из хранилища идёт после системных сообщений, а свои системы не дублируются", () => {
  const stored: ChatMessage[] = [
    { role: "system", content: "старый системный текст" },
    { role: "user", content: "задача" },
  ];
  const built = buildInitialMessages(stored, "контекст проекта", "developer");
  assert.equal(built[0].role, "system");
  assert.equal(built[1].content, "контекст проекта");
  assert.equal(built[2].content, "задача");
  assert.ok(!built.some(message => message.content === "старый системный текст"), "системные сообщения истории не переносятся");
});

/** Русский — язык размышления по умолчанию, но запрос на другом языке не должен ломаться. */
test("the agent reasons in Russian by default", () => {
  assert.match(SYSTEM_PROMPT, /reason in Russian by default/i);
  assert.match(SYSTEM_PROMPT, /write the answer in Russian/i);
});

test("an English request still gets English reasoning and answer", () => {
  assert.match(SYSTEM_PROMPT, /English request gets English reasoning and an English answer/i);
  assert.doesNotMatch(SYSTEM_PROMPT, /When the user writes in another language, answer in that language\./);
});

test("planner mode follows the language of the request", () => {
  assert.match(PLANNER_MODE_PROMPT, /in the user's language/i);
  assert.match(PLANNER_MODE_PROMPT, /Russian by default/i);
});
