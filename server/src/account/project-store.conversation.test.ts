import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** The stores resolve their paths on import, so the throwaway directory comes first. */
const dataDir = await mkdtemp(path.join(tmpdir(), "webnestdev-conversation-"));
process.env.WEBNESTDEV_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
delete process.env.WEBNESTDEV_STORAGE;
delete process.env.DATABASE_URL;

const { appendConversationMessages, createConversation, createProject, getConversation, saveConversationPlan } = await import("../project-store.js");

after(async () => { await rm(dataDir, { recursive: true, force: true }); });

test("a conversation keeps the answers, the thinking behind them and the tool results", async () => {
  const project = await createProject("conversation", undefined, "user-1");
  const conversation = await createConversation(project.id);
  const call = { id: "call-1", name: "fs.list", arguments: { path: "." } };

  await appendConversationMessages(conversation.id, [
    { role: "user", content: "посмотри файлы" },
    { role: "assistant", content: "Смотрю проект.", reasoning: "Сначала посмотрю список файлов.", tool_calls: [call] },
    { role: "tool", content: JSON.stringify({ files: ["package.json"] }), tool_call_id: "call-1" },
    { role: "assistant", content: "Готово.", reasoning: "Файлы проверены, менять ничего не нужно." },
  ]);

  const stored = await getConversation(conversation.id);
  assert.ok(stored, "the conversation is readable after the run");
  assert.deepEqual(stored.messages.map(message => message.role), ["user", "assistant", "tool", "assistant"]);

  const withCalls = stored.messages[1];
  assert.equal(withCalls.role === "assistant" ? withCalls.reasoning : "", "Сначала посмотрю список файлов.");
  assert.equal(withCalls.role === "assistant" ? withCalls.tool_calls?.[0]?.name : "", "fs.list");
  assert.deepEqual(withCalls.role === "assistant" ? withCalls.tool_calls?.[0]?.arguments : {}, { path: "." });

  const result = stored.messages[2];
  assert.equal(result.role === "tool" ? result.tool_call_id : "", "call-1");

  const final = stored.messages[3];
  assert.equal(final.role === "assistant" ? final.reasoning : "", "Файлы проверены, менять ничего не нужно.");
});

test("the plan is stored with the conversation, not with the browser", async () => {
  const project = await createProject("plan", undefined, "user-1");
  const conversation = await createConversation(project.id);
  await saveConversationPlan(conversation.id, {
    items: [{ title: "Собрать проект", status: "in_progress" }, { title: "Проверить сборку", status: "pending" }],
    updatedAt: new Date().toISOString(),
  });

  const stored = await getConversation(conversation.id);
  assert.equal(stored?.plan?.items.length, 2);
  assert.equal(stored?.plan?.items[0]?.title, "Собрать проект");
  assert.equal(stored?.plan?.items[0]?.status, "in_progress");
});

test("appending to a conversation keeps the stored plan", async () => {
  const project = await createProject("keep", undefined, "user-1");
  const conversation = await createConversation(project.id);
  await saveConversationPlan(conversation.id, { items: [{ title: "Шаг", status: "done" }], updatedAt: new Date().toISOString() });
  await appendConversationMessages(conversation.id, [{ role: "assistant", content: "Продолжаю." }]);

  const stored = await getConversation(conversation.id);
  assert.equal(stored?.plan?.items[0]?.title, "Шаг");
  assert.equal(stored?.messages.at(-1)?.content, "Продолжаю.");
});

test("a long tool result is stored in a readable, bounded form", async () => {
  const project = await createProject("bounded", undefined, "user-1");
  const conversation = await createConversation(project.id);
  await appendConversationMessages(conversation.id, [
    { role: "tool", content: "x".repeat(20000), tool_call_id: "call-long" },
  ]);

  const stored = await getConversation(conversation.id);
  const message = stored?.messages[0];
  assert.equal(message?.role, "tool");
  assert.ok((message?.content.length ?? 0) < 20000, "the stored copy is trimmed");
  assert.match(message?.content ?? "", /обрезан при сохранении/);
});
