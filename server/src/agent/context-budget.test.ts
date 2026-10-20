import test from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "../types.js";
import {
  CUT_NOTE_CHARS,
  ContextBudgetError,
  DEFAULT_MAX_MESSAGES,
  boundToolOutput,
  calibrateCharsPerToken,
  clip,
  clipToolCallArgs,
  contextBudgetTokens,
  contextMaxMessages,
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
  assert.equal(report.messages, messages.length);
  assert.equal(report.maxMessages, DEFAULT_MAX_MESSAGES);
});

test("предел числа сообщений берётся из окружения и не опускается ниже рабочего минимума", () => {
  const before = process.env.AGENT_CONTEXT_MAX_MESSAGES;
  try {
    delete process.env.AGENT_CONTEXT_MAX_MESSAGES;
    assert.equal(contextMaxMessages(), DEFAULT_MAX_MESSAGES);
    process.env.AGENT_CONTEXT_MAX_MESSAGES = "200";
    assert.equal(contextMaxMessages(), 200);
    // Вырожденная настройка оставила бы запрос без места на промпт и текущий шаг.
    process.env.AGENT_CONTEXT_MAX_MESSAGES = "2";
    assert.equal(contextMaxMessages(), 8);
  } finally {
    if (before === undefined) delete process.env.AGENT_CONTEXT_MAX_MESSAGES;
    else process.env.AGENT_CONTEXT_MAX_MESSAGES = before;
  }
});

// Провайдер ограничивает не только размер промпта: короткая история из сотни шагов весит немного,
// а массив длиннее, чем он принимает, и запрос отклоняется валидатором тела.
test("число сообщений ограничено отдельно от размера: старые шаги уходят целиком", () => {
  const messages: ChatMessage[] = [{ role: "system", content: "промпт" }];
  for (let index = 0; index < 60; index++) messages.push(...exchange(50, index));
  const { messages: trimmed, report } = trimMessagesToBudget(messages, { budgetTokens: 1000000, maxMessages: 20 });
  assert.equal(report.maxMessages, 20);
  assert.ok(report.messages <= 20, "в запросе не больше предела: " + report.messages);
  assert.ok(report.dropped > 0, "часть старых шагов выброшена");
  assert.match(trimmed.map(message => message.content).join("\n"), /сокращены/);
  // Результат инструмента без своего вызова провайдер отклонит, поэтому пара не разрывается.
  const announced = new Set<string>();
  for (const message of trimmed) {
    if (message.role === "assistant") for (const call of message.tool_calls ?? []) announced.add(call.id);
    if (message.role === "tool") assert.ok(announced.has(message.tool_call_id), "результат " + message.tool_call_id + " без вызова");
  }
});

/** Просьбы пользователя — это требования, а не мусор: их сворачивают, а не выбрасывают молча. */
test("старые сообщения пользователя сворачиваются в заметку, а задача остаётся целой", () => {
  const messages: ChatMessage[] = [{ role: "system", content: "промпт" }];
  for (let index = 0; index < 30; index++) messages.push({ role: "user", content: "задача номер " + index + " — сделай что-то полезное в проекте" });
  const { messages: trimmed, report } = trimMessagesToBudget(messages, { budgetTokens: 1000000, maxMessages: 12 });
  assert.ok(report.messages <= 12, "в запросе не больше предела: " + report.messages);
  const text = trimmed.map(message => message.content).join("\n");
  assert.match(text, /пользователь уже просил: «задача номер 0/, "начало старой просьбы видно модели");
  const lastUser = [...trimmed].reverse().find(message => message.role === "user");
  assert.equal(lastUser?.content, "задача номер 29 — сделай что-то полезное в проекте", "текущая задача не сокращается");
  assert.ok(trimmed.some(message => message.role === "system" && message.content === "промпт"));
});

/**
 * Обрезка без потери смысла: выводы агента и список того, что уже сделано, — это и есть знание о
 * работе, в отличие от журналов сборки, ради которых история и подрезается.
 */
test("вырезанное заменяется дайджестом: просьба, выводы и сделанное, а выводы инструментов выброшены", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "промпт" },
    { role: "user", content: "сделай страницу с формой заявки" },
  ];
  for (let index = 0; index < 40; index++) {
    messages.push({
      role: "assistant",
      content: "шаг " + index + ": форма добавлена и подключена",
      tool_calls: [{ id: "c" + index, name: "fs.write", arguments: { path: "src/Form" + index + ".tsx", content: "x" } }],
    });
    messages.push({ role: "tool", content: "z".repeat(4000), tool_call_id: "c" + index });
  }
  const { messages: trimmed } = trimMessagesToBudget(messages, { budgetTokens: 2000, keepRecent: 4 });
  const note = trimmed.find(message => message.role === "system" && message.content.includes("сокращены"))?.content ?? "";
  assert.match(note, /агент уже отвечал: «шаг /, "выводы агента остаются в дайджесте");
  assert.match(note, /уже сделано с проектом: fs\.write src\/Form/, "видно, что уже сделано с файлами");
  assert.match(note, /вывод инструментов выброшен/, "про выброшенный вывод сказано прямо");
  assert.ok(note.length <= CUT_NOTE_CHARS, "заметка ограничена по размеру: " + note.length);
  // Сама просьба пользователя не выбрасывается никогда — она дороже любого бюджета.
  assert.ok(trimmed.some(message => message.role === "user" && message.content === "сделай страницу с формой заявки"));
});

/**
 * Согласованное обычно стоит последним абзацем ответа («Итого: берём вариант B»), а старый срез брал
 * только начало. Поэтому от ответа остаются голова и хвост.
 */
test("срез ответа хранит его итог, а не только первую фразу", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "промпт" },
    { role: "user", content: "сделай лендинг для фотографа" },
  ];
  for (let index = 0; index < 30; index++) {
    messages.push({
      role: "assistant",
      content: "шаг " + index + ": разбираю макет " + "о".repeat(400) + " ИТОГО: договорились палитра #0E1A16 и шрифт Inter",
      tool_calls: [{ id: "d" + index, name: "fs.write", arguments: { path: "page" + index + ".html", content: "x" } }],
    });
    messages.push({ role: "tool", content: "y".repeat(3000), tool_call_id: "d" + index });
  }
  const { messages: trimmed } = trimMessagesToBudget(messages, { budgetTokens: 3000, keepRecent: 4 });
  const note = trimmed.find(message => message.role === "system" && message.content.includes("сокращены"))?.content ?? "";
  assert.match(note, /ИТОГО: договорились палитра #0E1A16/, "итог ответа виден модели: " + note.slice(0, 400));
  assert.ok(note.length <= CUT_NOTE_CHARS, "заметка не растёт без предела: " + note.length);
});

/**
 * Просьбы делят заметку с выводами и действиями, а не забирают её целиком: один длинный запрос не
 * должен вытеснить всё остальное, а первый запрос диалога остаётся всегда.
 */
test("длинные просьбы не вытесняют остальную часть среза и не теряют первую", () => {
  const messages: ChatMessage[] = [{ role: "system", content: "промпт" }];
  for (let index = 0; index < 30; index++) {
    messages.push({ role: "user", content: "задача номер " + index + " — " + "требование ".repeat(80) });
  }
  const { messages: trimmed } = trimMessagesToBudget(messages, { budgetTokens: 1000000, maxMessages: 12 });
  const note = trimmed.find(message => message.role === "system" && message.content.includes("сокращены"))?.content ?? "";
  assert.match(note, /пользователь уже просил: «задача номер 0/, "первый запрос диалога не теряется");
  assert.match(note, /не поместились в срез/, "о неполноте среза сказано прямо");
  assert.ok(note.length <= CUT_NOTE_CHARS, "заметка не растёт без предела: " + note.length);
});

test("недостижимый предел сообщений — ошибка с числами, а не вечный отбор", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "промпт" },
    { role: "system", content: "контекст проекта" },
    { role: "system", content: "продолжение" },
  ];
  for (let index = 0; index < 20; index++) messages.push({ role: "user", content: "просьба " + index });
  assert.throws(
    () => trimMessagesToBudget(messages, { budgetTokens: 1000000, maxMessages: 4 }),
    (error: unknown) => {
      assert.ok(error instanceof ContextBudgetError);
      assert.match(error.message, /сообщени/);
      assert.match(error.message, /предел — 4/);
      return true;
    },
  );
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

// Аргументы вызова уезжают провайдеру с каждым запросом, и запись файла приезжает в них целиком.
// Содержимое сообщений подрезалось, а аргументы — нет, поэтому один большой fs.write убивал
// следующий шаг запросом сверх бюджета, который ни одна фаза не могла уменьшить.
test("аргументы вызова инструмента подрезаются до валидного JSON и не рвут пару с результатом", () => {
  const argumentsWithFile = { path: "src/App.tsx", content: "x".repeat(20000) };
  const clipped = clipToolCallArgs({ id: "c1", name: "fs.write", arguments: argumentsWithFile });
  assert.equal(clipped.id, "c1", "вызов сохраняет свой id, иначе результат останется без вызова");
  assert.equal(clipped.name, "fs.write");
  assert.ok(JSON.stringify(clipped.arguments).length < 2200);
  assert.match(JSON.stringify(clipped.arguments), /аргументы вызова сокращены до лимита контекста/);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(clipped.arguments)), "провайдер требует объект в arguments");
  // В пределах лимита аргументы остаются тем же объектом, а не копией.
  const small = { id: "c2", name: "fs.read", arguments: { path: "index.html" } };
  assert.equal(clipToolCallArgs(small), small);
});

test("один большой вызов инструмента не выбивает историю из бюджета", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "промпт" },
    { role: "user", content: "добавь страницу" },
    { role: "assistant", content: "пишу файл", tool_calls: [{ id: "c1", name: "fs.write", arguments: { path: "src/Page.tsx", content: "y".repeat(80000) } }] },
    { role: "tool", content: "{\"ok\":true}", tool_call_id: "c1" },
  ];
  const { messages: trimmed, report } = trimMessagesToBudget(messages, { budgetTokens: 2000, keepRecent: 4 });
  assert.ok(report.compacted > 0, "аргументы сокращены, а не отправлены как есть");
  assert.ok(report.estimatedTokens <= 2000, "история уложилась в бюджет: " + report.estimatedTokens);
  // Пара остаётся парой: результат без своего вызова провайдер отклонит.
  const assistant = trimmed.find(message => message.role === "assistant");
  const calls = assistant?.role === "assistant" ? assistant.tool_calls ?? [] : [];
  assert.deepEqual(calls.map(call => call.id), ["c1"]);
  assert.ok(trimmed.some(message => message.role === "tool" && message.tool_call_id === "c1"));
});
