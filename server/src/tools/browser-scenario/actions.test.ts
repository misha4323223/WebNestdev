import test from "node:test";
import assert from "node:assert/strict";
import { playwrightDetail, readMs, readPoint, stepTimeoutMs } from "./actions.js";
import { readScenarioInput } from "./engine.js";
import { browserScenarioParameters } from "./schema.js";

test("playwrightDetail сохраняет последние 40 строк call log целиком", () => {
  const lines = Array.from({ length: 90 }, (_, index) => "line-" + index + " waiting for element to be visible");
  const detail = playwrightDetail(new Error("locator.click: Timeout 5000ms exceeded.\nCall log:\n" + lines.join("\n")));
  assert.match(detail, /первые 52 строк/);
  assert.match(detail, /line-89/);
  assert.match(detail, /line-50/);
  assert.doesNotMatch(detail, /line-49/);
  assert.equal(detail.split("\n").length, 41);
});

test("stepTimeoutMs ограничивает шаг общим дедлайном, а не только своим числом", () => {
  const now = Date.now();
  assert.equal(stepTimeoutMs({ timeoutMs: 60_000 }, now + 500, now), 500);
  assert.equal(stepTimeoutMs({ timeoutMs: 1_000 }, now + 60_000, now), 1_000);
  assert.equal(stepTimeoutMs({}, now + 60_000, now), 5_000);
  assert.throws(() => stepTimeoutMs({ timeoutMs: 1_000 }, now, now), /timeoutMs истёк/);
  assert.equal(readMs("bad", 25), 25);
  assert.equal(readMs(-5, 25), 25);
});

test("координаты сценария проверяются как конечные числа", () => {
  assert.deepEqual(readPoint({ x: 10, y: 20 }), { x: 10, y: 20 });
  assert.equal(readPoint({ x: "10", y: 20 }), null);
  assert.equal(readPoint(null), null);
});

test("readScenarioInput ограничивает шаги и читает setup/storage", () => {
  const input = readScenarioInput({
    path: "play",
    timeoutMs: 3_000,
    storage: { ready: "1", ignored: 2 },
    setup: [{ action: "waitForFunction", expression: "window.ready" }],
    steps: Array.from({ length: 100 }, () => ({ action: "wait", ms: 1 })),
  });
  assert.equal(input.path, "/play");
  assert.equal(input.timeoutMs, 3_000);
  assert.deepEqual(input.storage, { ready: "1" });
  assert.equal(input.setup?.length, 1);
  assert.equal(input.steps?.length, 80);
});

test("схема browser.scenario объявляет новые действия и лимит 80 шагов", () => {
  const properties = browserScenarioParameters.properties as unknown as {
    resetAttempts?: unknown;
    retry?: unknown;
    setup?: { maxItems?: number };
    steps?: { maxItems?: number; items?: { properties?: { action?: { enum?: string[] } } } };
  };
  assert.ok(properties.resetAttempts);
  assert.ok(properties.retry);
  assert.equal(properties.setup?.maxItems, 40);
  assert.equal(properties.steps?.maxItems, 80);
  const actions = properties.steps?.items?.properties?.action?.enum ?? [];
  for (const action of ["tap", "clickAt", "waitForFunction", "longPress", "expectAttribute", "expectScreenshot"]) {
    assert.ok(actions.includes(action), action);
  }
});
