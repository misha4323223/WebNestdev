import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendConversationMessages, createConversation, createProject, deleteProject, getConversation } from "./project-store.js";

/**
 * What a chat costs to keep is decided at write time, because a run writes as it goes and a session
 * is never rewritten afterwards. These tests pin the two things stored messages must satisfy: the
 * turns accumulate instead of replacing each other, and the thinking and the tool output — which
 * arrive at tens of kilobytes per step — are stored in the readable form, not in full.
 */
test("сообщения дописываются, а размышление и вывод инструмента ограничиваются при записи", async () => {
  const userId = "messages-test-" + randomUUID();
  const project = await createProject("Проверка записи", undefined, userId);
  const conversation = await createConversation(project.id, "Сессия");
  try {
    const receipt = await appendConversationMessages(conversation.id, [
      { role: "user", content: "задача" },
      { role: "assistant", content: "отвечаю", reasoning: "т".repeat(9000) },
      { role: "tool", content: "x".repeat(20000), tool_call_id: "c1" },
    ]);
    assert.equal(receipt.appended, 3);
    assert.equal(receipt.projectId, project.id);

    const second = await appendConversationMessages(conversation.id, [{ role: "user", content: "ещё задача" }]);
    assert.equal(second.appended, 1);

    const stored = await getConversation(conversation.id);
    assert.equal(stored?.messages.length, 4, "ходы дописываются к сессии, а не заменяют её");
    assert.equal(stored?.messages[0].content, "задача");
    assert.equal(stored?.messages[3].content, "ещё задача");

    const assistant = stored?.messages[1];
    const reasoning = assistant?.role === "assistant" ? assistant.reasoning ?? "" : "";
    assert.ok(reasoning.length < 4100, "размышление записано в ограниченном виде: " + reasoning.length);
    assert.match(reasoning, /размышление обрезано при сохранении/);

    const tool = stored?.messages[2];
    assert.ok((tool?.content.length ?? 0) < 8100, "вывод инструмента записан в ограниченном виде: " + (tool?.content.length ?? 0));
    assert.match(tool?.content ?? "", /вывод обрезан при сохранении/);
  } finally {
    await deleteProject(project.id, userId);
  }
});

test("короткое размышление сохраняется целиком", async () => {
  const userId = "messages-test-" + randomUUID();
  const project = await createProject("Короткое размышление", undefined, userId);
  const conversation = await createConversation(project.id, "Сессия");
  try {
    await appendConversationMessages(conversation.id, [
      { role: "assistant", content: "ответ", reasoning: "посмотрю структуру проекта" },
    ]);
    const stored = await getConversation(conversation.id);
    const assistant = stored?.messages[0];
    assert.equal(assistant?.role === "assistant" ? assistant.reasoning : "", "посмотрю структуру проекта");
  } finally {
    await deleteProject(project.id, userId);
  }
});

test("дописать сообщение в несуществующую сессию — ошибка, а не новая сессия", async () => {
  await assert.rejects(
    () => appendConversationMessages("нет-такой-сессии-" + randomUUID(), [{ role: "user", content: "привет" }]),
    /Сессия не найдена/,
  );
});
