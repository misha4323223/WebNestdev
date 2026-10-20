import test from "node:test";
import assert from "node:assert/strict";
import { getTool } from "../tool-registry.js";
import "./web-tools.js";

/**
 * Поиск в интернете — переключатель у поля ввода, по умолчанию выключен. Выключенное состояние
 * проверяется именно здесь: оно не должно ни ходить в сеть, ни делать вид, что поиск был. Агент
 * обязан получить причину `disabled` и попросить человека включить переключатель в «Режимах».
 */

const context = { projectId: "project", runId: "run", userId: "user-off-" + process.pid };

test("web.search is refused without the switch, before any network call", async () => {
  const tool = getTool("web.search");
  assert.ok(tool?.execute);
  const result = (await tool.execute({ query: "fastify hooks" }, context)) as {
    ok?: boolean;
    code?: string;
    error?: string;
    results?: unknown[];
    provider?: string;
  };
  assert.equal(result.ok, false);
  assert.equal(result.code, "disabled");
  assert.deepEqual(result.results, []);
  assert.match(result.error ?? "", /выключен/);
  assert.match(result.error ?? "", /«Режимы»/);
  // Названия провайдеров не попадают ни в поле, ни в текст: агент не должен о них знать.
  assert.equal("provider" in result, false);
  assert.doesNotMatch(result.error ?? "", /duckduckgo|yandex|tavily/i);
});

test("web.read is refused without the switch and keeps the url in the answer", async () => {
  const tool = getTool("web.read");
  assert.ok(tool?.execute);
  const result = (await tool.execute({ url: "https://example.com/article" }, context)) as {
    ok?: boolean;
    code?: string;
    url?: string;
    error?: string;
  };
  assert.equal(result.ok, false);
  assert.equal(result.code, "disabled");
  assert.equal(result.url, "https://example.com/article");
  assert.match(result.error ?? "", /включить/);
});
