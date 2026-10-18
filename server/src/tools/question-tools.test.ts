import test from "node:test";
import assert from "node:assert/strict";
import "./question-tools.js";
import { getTool } from "../tool-registry.js";
import { findPendingQuestion, resolvePendingQuestion } from "../questions/pending-questions.js";
import type { AgentEvent } from "../types.js";

/** Вызов инструмента так, как его зовёт рантайм: события идут в поток, ответ — отдельным путём. */
function callQuestion(input: unknown, events: AgentEvent[]) {
  const tool = getTool("question.ask");
  assert.ok(tool?.execute, "инструмент question.ask зарегистрирован");
  return tool.execute!(input, { projectId: "p1", runId: "r1", userId: "u1", emit: event => events.push(event) });
}

test("инструмент открывает окно, ждёт ответа и возвращает его модели", async () => {
  const events: AgentEvent[] = [];
  const execution = callQuestion({
    question: "Какую тему сделать?",
    options: [{ label: "Тёмная" }, { label: "Светлая", description: "Как в документации" }],
  }, events);

  const asked = events.find(event => event.type === "question.asked");
  assert.ok(asked && asked.type === "question.asked", "панель получает событие вопроса");
  assert.equal(asked.question, "Какую тему сделать?");
  assert.deepEqual(asked.options.map(option => option.label), ["Тёмная", "Светлая"]);
  assert.equal(asked.multiSelect, false);
  assert.equal(asked.allowCustom, true, "свой вариант предлагается по умолчанию");
  assert.ok(asked.expiresAt > Date.now());
  assert.ok(findPendingQuestion(asked.requestId));

  resolvePendingQuestion(asked.requestId, { ok: true, selected: ["Светлая"], custom: "И крупный шрифт" });
  const result = await execution as { ok: boolean; answer: string; custom?: string };
  assert.equal(result.ok, true);
  assert.equal(result.answer, "Светлая; И крупный шрифт");
  assert.equal(result.custom, "И крупный шрифт");
  assert.equal(findPendingQuestion(asked.requestId), null);
});

test("пропуск возвращает отказ и просьбу выбрать вариант самому, а не повторить вопрос", async () => {
  const events: AgentEvent[] = [];
  const execution = callQuestion({ question: "Какой шрифт?", options: [{ label: "Inter" }, { label: "Manrope" }] }, events);
  const asked = events.find(event => event.type === "question.asked");
  assert.ok(asked && asked.type === "question.asked");
  resolvePendingQuestion(asked.requestId, { ok: false, cancelled: true });

  const result = await execution as { ok: boolean; cancelled?: boolean; note: string };
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.match(result.note, /Не повторяй/);
});

test("одинаковые варианты не принимаются: ответ был бы неоднозначным", async () => {
  const events: AgentEvent[] = [];
  await assert.rejects(
    callQuestion({ question: "Что выбрать?", options: [{ label: "Да" }, { label: "Да" }] }, events),
    /отличаться/,
  );
  assert.equal(events.length, 0, "окно даже не открывается");
});

test("меньше двух вариантов — не вопрос, а утверждение", async () => {
  await assert.rejects(
    callQuestion({ question: "Что выбрать?", options: [{ label: "Да" }] }, []),
    /запрос|options|too_small/i,
  );
});
