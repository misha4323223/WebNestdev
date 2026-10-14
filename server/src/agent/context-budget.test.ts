import test from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "../types.js";
import {
  ContextBudgetError,
  boundToolOutput,
  calibrateCharsPerToken,
  clip,
  contextBudgetTokens,
  estimateTokens,
  groupMessages,
  messageChars,
  trimMessagesToBudget,
} from "./context-budget.js";

/** An assistant turn with a tool call plus the tool result that answers it. */
function exchange(size: number, index = 0): ChatMessage[] {
  return [
    { role: "assistant", content: "шаг " + index, tool_calls: [{ id: "call-" + index, name: "terminal.exec", arguments: { command: "npm run build" } }] },
    { role: "tool", content: "x".repeat(size), tool_call_id: "call-" + index },
  ];
}

test("бюджет контекста берётся из окружения и всегда оставляет место ответу", () => {
  const before = { tokens: process.env.AGENT_CONTEXT_TOKENS, reserve: process.env.AGENT_CONTEXT_OUTPUT_RESERVE };
  try {
    process.env.AGENT_CONTEXT_TOKENS = "100000";
    process.env.AGENT_CONTEXT_OUTPUT_RESERVE = "20000";
    assert.equal(contextBudgetTokens(), 80000);
    // Вырожденная настройка не должна оставить бюджет без места на ответ вовсе.
    process.env.AGENT_CONTEXT_TOKENS = "5000";
    process.env.AGENT_CONTEXT_OUTPUT_RESERVE = "4900";
    assert.equal(contextBudgetTokens(), 4000);
  } finally {
    if (before.tokens === undefined) delete process.env.AGENT_CONTEXT_TOKENS;
    else process.env.AGENT_CONTEXT_TOKENS = before.tokens;
    if (before.reserve === undefined) delete process.env.AGENT_CONTEXT_OUTPUT_RESERVE;
    else process.env.AGENT_CONTEXT_OUTPUT_RESERVE = before.reserve;
  }
});

test("вывод инструмента обрезается по краям, а не теряет конец", () => {
  const output = { ok: true, stdout: "start" + "ы".repeat(50000) + "error: last line" };
  const bounded = boundToolOutput("terminal.exec", output);
  assert.ok(bounded.length <= 6100, "вывод не больше лимита, а равен " + bounded.length);
  assert.match(bounded, /сокращён/);
  assert.match(bounded, /start/);
  // Конец вывода — то, ради чего терминал вызывают: ошибки живут в хвосте.
  assert.match(bounded, /error: last line/);
});

test("маленький вывод инструмента проходит без изменений", () => {
  const bounded = boundToolOutput("fs.write", { ok: true, path: "index.html" });
  assert.equal(bounded, JSON.stringify({ ok: true, path: "index.html" }));
});

test("группировка сохраняет пару «вызов инструмента + его результат»", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "промпт" },
    { role: "user", content: "задача" },
    ...exchange(10, 1),
  ];
  const groups = groupMessages(messages);
  assert.equal(groups.length, 3);
  assert.equal(groups[2].messages.length, 2);
  assert.equal(groups[2].index, 2);
});

test("история в пределах бюджета не меняется", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "промпт" },
    { role: "user", content: "сделай лендинг" },
    ...exchange(500, 1),
  ];
  const { messages: trimmed, report } = trimMessagesToBudget(messages, { budgetTokens: 100000 });
  assert.deepEqual(trimmed, messages);
  assert.equal(report.compacted, 0);
  assert.equal(report.dropped, 0);
});

test("огромное сообщение пользователя сокращается, но не выбрасывается", () => {
  const pasted = "начало задачи " + "к".repeat(60000) + " конец задачи";
  const messages: ChatMessage[] = [
    { role: "system", content: "промпт" },
    { role: "user", content: pasted },
  ];
  // Бюджет настоящий, но заметно меньше вставленного текста: сокращения достаточно.
  const { messages: trimmed, report } = trimMessagesToBudget(messages, { budgetTokens: 3000 });
  assert.equal(report.compacted, 1);
  const user = trimmed.find(message => message.role === "user");
  assert.ok(user, "сообщение пользователя остаётся в истории");
  assert.ok(user.content.length < pasted.length);
  assert.match(user.content, /начало задачи/);
  assert.match(user.content, /конец задачи/);
});

test("старые шаги выкидываются целиком, а не результатами без вызова", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "промпт" },
    { role: "user", content: "задача" },
    ...exchange(40000, 1),
    ...exchange(40000, 2),
    ...exchange(40000, 3),
    ...exchange(400, 4),
  ];
  const { messages: trimmed, report } = trimMessagesToBudget(messages, { budgetTokens: 1500, keepRecent: 2 });
  assert.ok(report.dropped > 0, "часть старых сообщений выброшена");
  assert.ok(report.chars / 3.6 <= 1500, "в бюджет уложились");
  assert.ok(trimmed.some(message => message.role === "user"));
  assert.ok(trimmed.some(message => message.role === "system" && message.content === "промпт"));
  // Каждый результат инструмента обязан иметь вызов перед собой, иначе провайдер отклонит запрос.
  const announced = new Set<string>();
  for (const message of trimmed) {
    if (message.role === "assistant") for (const call of message.tool_calls ?? []) announced.add(call.id);
    if (message.role === "tool") assert.ok(announced.has(message.tool_call_id), "результат " + message.tool_call_id + " без вызова");
  }
  assert.match(trimmed.map(message => message.content).join("\n"), /сокращены/);
});

test("когда даже сокращённая история не помещается — ошибка вместо doomed-запроса", () => {
  const messages: ChatMessage[] = [{ role: "system", content: "промпт" }];
  for (let index = 0; index < 12; index++) messages.push({ role: "user", content: "у".repeat(30000) });
  assert.throws(() => trimMessagesToBudget(messages, { budgetTokens: 500 }), ContextBudgetError);
});

test("калибровка держит отношение «символы на токен» в разумных границах", () => {
  assert.equal(calibrateCharsPerToken(1000, 0), 3.6);
  assert.equal(calibrateCharsPerToken(0, 100), 3.6);
  assert.equal(calibrateCharsPerToken(3700, 1000), 3.7);
  assert.equal(calibrateCharsPerToken(100000, 1000), 8);
  assert.equal(calibrateCharsPerToken(100, 100), 1.5);
});

test("схемы инструментов входят в бюджет промпта", () => {
  const messages: ChatMessage[] = [{ role: "system", content: "промпт" }, { role: "user", content: "задача" }];
  const without = trimMessagesToBudget(messages, { budgetTokens: 5000 });
  const withSchemas = trimMessagesToBudget(messages, { budgetTokens: 5000, overheadChars: 3600 });
  assert.equal(without.report.overheadChars, 0);
  assert.equal(withSchemas.report.chars, without.report.chars + 3600);
  assert.equal(withSchemas.report.estimatedTokens, without.report.estimatedTokens + 1000);
});

test("если одни схемы инструментов больше бюджета, это тоже ошибка, а не молчание", () => {
  const messages: ChatMessage[] = [{ role: "system", content: "промпт" }];
  assert.throws(() => trimMessagesToBudget(messages, { budgetTokens: 1000, overheadChars: 200000 }), ContextBudgetError);
});

test("оценка токенов считается по символам всей истории, включая вызовы инструментов", () => {
  const messages: ChatMessage[] = [...exchange(3600, 1)];
  assert.equal(estimateTokens(messages, 3.6), Math.ceil(messageChars(messages) / 3.6));
  // Вызов инструмента тоже занимает место в промпте, а не только его результат.
  assert.ok(messageChars(messages) > 3600);
});

test("clip оставляет короткий текст без изменений", () => {
  assert.equal(clip("коротко", 100, 10, "метка"), "коротко");
});
