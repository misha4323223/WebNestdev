import test from "node:test";
import assert from "node:assert/strict";
import { approveMutation, mutationApprovalDetails, mutationApprovalQuestion } from "./mutation-approval.js";
import { resolvePendingQuestion } from "../questions/pending-questions.js";

const baseContext = {
  projectId: "project-1",
  userId: "user-1",
  runId: "run-1",
};

test("карточка подтверждения называет провайдера, метод, ресурс и тело", () => {
  const question = mutationApprovalQuestion({
    provider: "Timeweb Cloud",
    method: "DELETE",
    resource: "/api/v1/servers/42",
    body: { name: "web-1" },
  });
  assert.match(question, /Timeweb Cloud/);
  assert.match(question, /DELETE \/api\/v1\/servers\/42/);
  assert.match(question, /web-1/);
  assert.ok(question.length <= 400);
});

test("структурированная карточка форматирует тело и убирает пустой объект", () => {
  const details = mutationApprovalDetails({
    provider: "Timeweb Cloud",
    method: "POST",
    resource: "/api/v1/servers",
    body: { name: "web-1" },
  });
  assert.equal(details.kind, "mutation");
  assert.equal(details.provider, "Timeweb Cloud");
  assert.equal(details.method, "POST");
  assert.match(details.body ?? "", /"name": "web-1"/);
  assert.equal("body" in mutationApprovalDetails({
    provider: "Timeweb Cloud",
    method: "POST",
    resource: "/api/v1/servers",
    body: {},
  }), false);
});

test("без панели мутация не выполняется (fail closed)", async () => {
  const approved = await approveMutation(baseContext, {
    provider: "Timeweb Cloud",
    method: "POST",
    resource: "/api/v1/servers",
  });
  assert.equal(approved, false);
});

test("пользователь разрешил — мутация проходит", async () => {
  const events: Array<{ type: string; requestId: string; approval?: { kind: string; provider: string } }> = [];
  const pending = approveMutation(
    { ...baseContext, emit: (event: unknown) => events.push(event as { type: string; requestId: string }) },
    { provider: "Yandex Cloud", method: "DELETE", resource: "compute/v1/instances/abc" },
  );
  assert.equal(events[0]?.type, "question.asked");
  assert.equal(events[0]?.approval?.kind, "mutation");
  assert.equal(events[0]?.approval?.provider, "Yandex Cloud");
  assert.equal(resolvePendingQuestion(events[0]!.requestId, { ok: true, selected: ["Разрешить изменение"] }), true);
  assert.equal(await pending, true);
});

test("пользователь отклонил — мутация не проходит", async () => {
  const events: Array<{ type: string; requestId: string }> = [];
  const pending = approveMutation(
    { ...baseContext, emit: (event: unknown) => events.push(event as { type: string; requestId: string }) },
    { provider: "Beget", method: "POST", resource: "zone/update_records" },
  );
  assert.equal(resolvePendingQuestion(events[0]!.requestId, { ok: true, selected: ["Отклонить"] }), true);
  assert.equal(await pending, false);
});
