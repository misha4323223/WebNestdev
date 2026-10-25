import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getTool } from "../tool-registry.js";
import type { ChatMessage } from "../types.js";

/**
 * Дневная переписка проверяется на настоящем хранилище: смысл инструмента в том, что старый
 * фрагмент читается из сохранённого разговора дословно, а не из пересказа в контексте.
 * Хранилище уводится во временный каталог до импорта модулей, которые читают настройки при загрузке.
 */
const data = await mkdtemp(path.join(os.tmpdir(), "webnestdev-history-"));
process.env.WEBNESTDEV_DATA_DIR = data;
process.env.WEBNESTDEV_SANDBOX_DIR = path.join(data, "sandboxes");
const { createConversation, appendConversationMessages, createProject } = await import("../project-store.js");
await import("./history-tools.js");

type HistoryResult = {
  ok: boolean;
  matched?: number;
  returned?: number;
  truncated?: boolean;
  turns?: Array<{ role: string; text: string }>;
  tools?: Array<{ name: string; arguments: string; result: string }>;
  toolsMatched?: number;
  note?: string;
  error?: string;
};

test("chat.history ищет по всей сохранённой переписке, а не только по её хвосту", async t => {
  t.after(() => rm(data, { recursive: true, force: true }));
  const project = await createProject("История", undefined, "u-history");
  const conversation = await createConversation(project.id, "Лендинг фотографа");
  const messages: ChatMessage[] = [{ role: "user", content: "Сделай лендинг для фотографа Анны" }];
  for (let index = 0; index < 40; index++) {
    messages.push({ role: "assistant", content: "шаг " + index + ": правлю секцию", tool_calls: [{ id: "h" + index, name: "fs.write", arguments: { path: "page" + index + ".html", content: "x" } }] });
    messages.push({ role: "tool", content: "ok", tool_call_id: "h" + index });
  }
  // Отдельная проверка: результат сборки уже был в переписке, но выпал из видимого контекста.
  messages.push({ role: "assistant", content: "Собираю проект", tool_calls: [{ id: "build", name: "terminal.exec", arguments: { command: "npm run build" } }] });
  messages.push({ role: "tool", content: JSON.stringify({ ok: true, exitCode: 0, stdout: "vite v8 built in 1.7s", stderr: "" }), tool_call_id: "build" });
  messages.push({ role: "user", content: "Согласовали палитру #0E1A16 и шрифт Inter, тёмный герой отклонён" });
  messages.push({ role: "assistant", content: "Понял: палитра #0E1A16, шрифт Inter. Итог зафиксирован." });
  await appendConversationMessages(conversation.id, messages);

  const tool = getTool("chat.history");
  assert.ok(tool?.execute);
  const context = { projectId: project.id, runId: "r", userId: "u-history", conversationId: conversation.id };

  const found = (await tool.execute({ query: "палитру #0E1A16" }, context)) as HistoryResult;
  assert.equal(found.ok, true, found.error ?? "");
  assert.equal(found.matched, 1, "поиск идёт по всей переписке, хотя совпадение в самом конце");
  assert.match(found.turns?.[0]?.text ?? "", /палитру #0E1A16/);
  assert.equal(found.turns?.[0]?.role, "user");

  // Реплики идут дословно и без журнала инструментов: модели нужен смысл, а не вывод записи файлов.
  const recent = (await tool.execute({ limit: 3 }, context)) as HistoryResult;
  assert.equal(recent.ok, true);
  // Без запроса возвращаются самые свежие реплики — ровно три, в том порядке, в каком они были.
  assert.deepEqual(recent.turns?.map(turn => turn.role), ["assistant", "user", "assistant"]);
  assert.ok(recent.turns?.every(turn => !turn.text.includes("\"ok\"")), "результаты инструментов не отдаются");

  const none = (await tool.execute({ query: "вертолёт" }, context)) as HistoryResult;
  assert.equal(none.ok, true);
  assert.equal(none.returned, 0);
  assert.match(none.note ?? "", /нет реплик/);

  // По умолчанию выводы инструментов не отдаются, но с tools:true их можно найти по слову.
  assert.equal(found.tools, undefined);
  const toolHistory = (await tool.execute({ query: "built in 1.7s", tools: true }, context)) as HistoryResult;
  assert.equal(toolHistory.ok, true, toolHistory.error ?? "");
  assert.equal(toolHistory.toolsMatched, 1);
  assert.equal(toolHistory.tools?.[0]?.name, "terminal.exec");
  assert.match(toolHistory.tools?.[0]?.result ?? "", /built in 1\.7s/);
  assert.match(toolHistory.tools?.[0]?.arguments ?? "", /npm run build/);

  const otherProject = await createProject("Чужой", undefined, "u-other");
  const foreign = (await tool.execute({}, { projectId: otherProject.id, runId: "r", userId: "u-other", conversationId: conversation.id })) as HistoryResult;
  assert.equal(foreign.ok, false, "чат другого проекта этим путём не читается");
  assert.match(foreign.error ?? "", /не найден/);

  const noChat = (await tool.execute({}, { projectId: project.id, runId: "r", userId: "u-history" })) as HistoryResult;
  assert.equal(noChat.ok, false);
  assert.match(noChat.error ?? "", /нет сохранённого разговора/);
});
