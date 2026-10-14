import test from "node:test";
import assert from "node:assert/strict";
import { conversationSummaries } from "./projects.js";
import type { Conversation } from "../project-store.js";

function conversation(overrides: Partial<Conversation> & { id: string }): Conversation {
  const now = "2026-10-14T10:00:00.000Z";
  return { projectId: "project-1", title: "Новая сессия", messages: [], plan: null, createdAt: now, updatedAt: now, ...overrides };
}

test("a chat is labelled by its first question and previewed by the last answer", () => {
  const [summary] = conversationSummaries([conversation({
    id: "c1",
    updatedAt: "2026-10-14T11:00:00.000Z",
    messages: [
      { role: "user", content: "Сделай лендинг\nс тёмной темой" },
      { role: "assistant", content: "Начал", tool_calls: [{ id: "t1", name: "fs.write", arguments: {} }] },
      { role: "tool", content: "{\"ok\":true}", tool_call_id: "t1" },
      { role: "assistant", content: "Готово: страница собрана." },
    ],
  })]);
  assert.equal(summary.id, "c1");
  assert.equal(summary.projectId, "project-1");
  assert.equal(summary.label, "Сделай лендинг");
  assert.equal(summary.preview, "Готово: страница собрана.");
  assert.equal(summary.messageCount, 3);
  assert.equal(summary.updatedAt, "2026-10-14T11:00:00.000Z");
});

test("no stored turns still yields a row: the title is the label and tool output never becomes a preview", () => {
  const [summary] = conversationSummaries([conversation({
    id: "c2",
    title: "Пустая сессия",
    messages: [{ role: "tool", content: "{\"ok\":true}", tool_call_id: "t1" }],
  })]);
  assert.equal(summary.label, "Пустая сессия");
  assert.equal(summary.preview, "");
  assert.equal(summary.messageCount, 0);
});

test("a long question is cut to one readable line", () => {
  const [summary] = conversationSummaries([conversation({ id: "c3", messages: [{ role: "user", content: "a".repeat(200) }] })]);
  assert.equal(summary.label.length, 81);
  assert.ok(summary.label.endsWith("…"));
});

test("the picker is bounded and keeps the newest chats the store ordered first", () => {
  const summaries = conversationSummaries(Array.from({ length: 60 }, (_, index) => conversation({ id: "c" + index })), 5);
  assert.equal(summaries.length, 5);
  assert.equal(summaries[0].id, "c0");
});
