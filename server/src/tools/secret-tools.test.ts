import test from "node:test";
import assert from "node:assert/strict";
import { getTool } from "../tool-registry.js";
import { resolveSecretRequest } from "../secrets/pending-secrets.js";
import type { AgentEvent } from "../types.js";
import "./secret-tools.js";

const execute = getTool("secrets.request")!.execute!;

/** Ждём, пока инструмент отправит событие: оно уходит синхронно, но ответ приходит позже. */
function waitForRequest(events: AgentEvent[]) {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (events.length) return resolve();
      if (Date.now() - started > 1000) return reject(new Error("запрос ключа так и не был опубликован"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

test("инструмент отдаёт подтверждение, а значение не появляется ни в событии, ни в результате", async () => {
  const events: AgentEvent[] = [];
  const answer = execute({ variable: "STRIPE_SECRET_KEY", purpose: "Оплата подписки" }, {
    projectId: "p1",
    userId: "u1",
    runId: "r1",
    emit: event => events.push(event),
  });
  await waitForRequest(events);

  const requested = events[0];
  assert.equal(requested.type, "secret.requested");
  assert.equal(requested.type === "secret.requested" ? requested.variable : "", "STRIPE_SECRET_KEY");
  assert.equal(requested.type === "secret.requested" ? requested.file : "", ".env.local");
  assert.ok(!JSON.stringify(requested).includes("sk_live_"));

  // Маршрут записал бы значение в файл и ответил бы так; в модель уходит только подтверждение.
  const requestId = requested.type === "secret.requested" ? requested.requestId : "";
  assert.equal(resolveSecretRequest(requestId, { ok: true, variable: "STRIPE_SECRET_KEY", file: ".env.local" }), true);
  const result = await answer as Record<string, unknown>;

  assert.equal(result.ok, true);
  assert.equal(result.stored, true);
  assert.equal(result.variable, "STRIPE_SECRET_KEY");
  assert.equal(result.file, ".env.local");
  assert.ok(!JSON.stringify(result).includes("sk_live_"), "значение не должно возвращаться инструменту");
  assert.match(String(result.note), /process\.env\.STRIPE_SECRET_KEY/);
});

test("отказ пользователя доходит как отказ и запрещает просить ключ в чате", async () => {
  const events: AgentEvent[] = [];
  const answer = execute({ variable: "OPENAI_API_KEY" }, {
    projectId: "p1",
    userId: "u1",
    runId: "r2",
    emit: event => events.push(event),
  });
  await waitForRequest(events);
  const requestId = events[0].type === "secret.requested" ? events[0].requestId : "";
  resolveSecretRequest(requestId, { ok: false, cancelled: true });

  const result = await answer as Record<string, unknown>;
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.match(String(result.note), /Не проси его в чате/);
});

test("истечение ожидания и остановка запуска возвращаются как ошибка без ключа", async () => {
  const events: AgentEvent[] = [];
  const controller = new AbortController();
  const answer = execute({ variable: "TURNSTILE_SECRET" }, {
    projectId: "p1",
    userId: "u1",
    runId: "r3",
    emit: event => events.push(event),
    signal: controller.signal,
  });
  await waitForRequest(events);
  controller.abort();

  const result = await answer as Record<string, unknown>;
  assert.equal(result.ok, false);
  assert.match(String(result.error), /остановлен/);
  assert.match(String(result.note), /Не проси его в чате/);
});

test("плохое имя переменной и чужой файл отклоняются до показа окна", async () => {
  const context = { projectId: "p1", userId: "u1", runId: "r4", emit: () => {} };
  await assert.rejects(() => execute({ variable: "stripe key" }, context), /Имя переменной/);
  await assert.rejects(() => execute({ variable: "TOKEN", file: ".env/../../secret" }, context), /файл окружения/);
  await assert.rejects(() => execute({ variable: "token" }, context), /Имя переменной/);
});
