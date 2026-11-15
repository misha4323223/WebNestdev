import test from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "../types.js";
import type { Provider } from "../provider.js";
import { runAgentStep } from "./step-runner.js";
import { parseReviewResult, reviewFeedback, reviewNeeded, reviewerMessages, staticReview } from "./reviewer.js";

const base = {
  task: "добавь заказы",
  files: ["src/orders.ts"],
  checks: ["сборка: пройдена", "тесты: пройдены"],
};

test("reviewer обязателен только выше порога", () => {
  assert.equal(reviewNeeded(5, 150, 50), false);
  assert.equal(reviewNeeded(6, 0, 0), true);
  assert.equal(reviewNeeded(1, 150, 51), true);
});

test("статический reviewer видит секрет только в добавленных строках", () => {
  const added = staticReview({ ...base, patch: "+const token = \"ghp_" + "a".repeat(32) + "\";\n" });
  assert.equal(added.some(item => item.severity === "error" && item.title === "Секрет в diff"), true);

  const removed = staticReview({ ...base, patch: "-const token = \"ghp_" + "a".repeat(32) + "\";\n+const token = readToken();\n" });
  assert.equal(removed.some(item => item.title === "Секрет в diff"), false);
});

test("статический reviewer ловит only, skip, опасный SQL и файл вне scope", () => {
  const findings = staticReview({
    ...base,
    files: ["src/orders.ts", "src/other.ts"],
    expectedFiles: ["src/orders.ts"],
    patch: [
      "+it.only(\"заказ\", () => {});",
      "+it.skip(\"старый\", () => {});",
      "+await db.query(\"DROP TABLE orders\");",
      "+await db.query(\"DELETE FROM orders\");",
    ].join("\n"),
  });
  assert.ok(findings.some(item => item.title === "Тест оставлен в режиме only" && item.severity === "error"));
  assert.ok(findings.some(item => item.title === "Тест пропускается" && item.severity === "warning"));
  assert.ok(findings.some(item => item.title === "Разрушительный SQL" && item.severity === "error"));
  assert.ok(findings.some(item => item.title === "DELETE без WHERE" && item.severity === "error"));
  assert.ok(findings.some(item => item.title === "Файл вне scope плана" && item.file === "src/other.ts"));
});

test("многострочный DELETE с WHERE не считается опасным", () => {
  const findings = staticReview({
    ...base,
    patch: "+await db.query(`DELETE FROM orders\n+WHERE id = $1;`);\n",
  });
  assert.equal(findings.some(item => item.title === "DELETE без WHERE"), false);
});

test("статическая ошибка не отменяется словом pass от модели", () => {
  const staticFindings = staticReview({ ...base, patch: "+it.only(\"x\", () => {});\n" });
  const parsed = parseReviewResult(JSON.stringify({ verdict: "pass", summary: "всё хорошо", findings: [] }), staticFindings);
  assert.equal(parsed.verdict, "fail");
  assert.equal(parsed.findings.some(item => item.title === "Тест оставлен в режиме only"), true);
});

test("reviewer принимает JSON в fence и нормализует findings", () => {
  const parsed = parseReviewResult("```json\n" + JSON.stringify({
    verdict: "fail",
    summary: "потеряна ошибка",
    findings: [{ severity: "error", title: "Нет обработки ошибки", detail: "fetch может упасть", file: "src/orders.ts", line: 12 }],
  }) + "\n```");
  assert.equal(parsed.verdict, "fail");
  assert.equal(parsed.findings[0]?.line, 12);
  assert.match(reviewFeedback(parsed), /Нет обработки ошибки/);
});

test("reviewer отвечает pass только валидным JSON с verdict", () => {
  assert.equal(parseReviewResult('{"verdict":"pass","summary":"ok","findings":[]}').verdict, "pass");
  assert.throws(() => parseReviewResult(""), /пустой/);
  assert.throws(() => parseReviewResult("не json"), /не JSON/);
  assert.throws(() => parseReviewResult('{"summary":"ok"}'), /verdict/);
});

test("чистый контекст reviewer не содержит истории основного запуска", () => {
  const messages = reviewerMessages({
    ...base,
    patch: "--- a/src/orders.ts\n+++ b/src/orders.ts\n+export const orders = [];\n",
    staticFindings: [],
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[1]?.role, "user");
  assert.match(messages[1]?.content ?? "", /добавь заказы/);
  assert.match(messages[1]?.content ?? "", /DIFF/);
});

test("reviewer проходит runAgentStep без инструментов, usage доходит до результата", async () => {
  let captured: { messages: ChatMessage[]; tools?: unknown[] } | null = null;
  const provider: Provider = {
    async *stream(messages, _model, tools) {
      captured = { messages, ...(tools ? { tools } : {}) };
      yield { type: "text", text: '{"verdict":"pass","summary":"ok","findings":[]}' };
      yield { type: "usage", promptTokens: 12, completionTokens: 7 };
    },
  };
  const step = await runAgentStep(provider, reviewerMessages({
    ...base,
    patch: "--- a/src/orders.ts\n+++ b/src/orders.ts\n+export const orders = [];\n",
    staticFindings: [],
  }), "reviewer-test", {
    runId: "run",
    request: { projectId: "project", userId: "user", messages: [] },
    emit: () => {},
    toolNames: [],
  });
  assert.ok(captured);
  const seen = captured as { messages: ChatMessage[]; tools?: unknown[] };
  assert.equal(seen.tools?.length, 0);
  assert.equal(seen.messages.length, 2);
  assert.equal(step.calls.length, 0);
  assert.deepEqual(step.usage, { promptTokens: 12, completionTokens: 7, cachedPromptTokens: 0, cacheWritePromptTokens: 0, estimated: false });
  assert.equal(parseReviewResult(step.text).verdict, "pass");
});
