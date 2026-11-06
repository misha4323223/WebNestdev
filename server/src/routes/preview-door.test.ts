import assert from "node:assert/strict";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { registerPreviewDoorRoutes, type PreviewDoorRouteDeps } from "./preview-door.js";
import { previewDoorToken } from "../preview/door-token.js";

/**
 * Внутренний маршрут двери. `/api/*` виден снаружи через Caddy, поэтому «внутренний адрес» не
 * является защитой: маршрут обязан требовать токен двери и ничего не отдавать без него. Тест
 * держит и форму ответа: дверь различает «проекта нет» (404 для посетителя) и «API не ответил»
 * (503), и эти два случая не должны слипнуться в один.
 */

const KEY = "e".repeat(64);
// Ключ нужен на КАЖДОМ запросе, а не только при регистрации маршрутов: токен выводится заново,
// поэтому переменная живёт весь файл. Файл тестов идёт отдельным процессом, соседние не задеты.
process.env.WEBNESTDEV_ENCRYPTION_KEY = KEY;

type MakeAppOptions = { deps?: Partial<PreviewDoorRouteDeps> };

async function makeApp(options: MakeAppOptions = {}): Promise<{ app: FastifyInstance; calls: string[] }> {
  const calls: string[] = [];
  const app = Fastify();
  await registerPreviewDoorRoutes(app, {
    projectExists: async projectId => {
      calls.push("exists:" + projectId);
      return projectId !== "deleted";
    },
    status: async projectId => {
      calls.push("status:" + projectId);
      return { running: true, ready: true, port: 3000, host: "10.0.0.5", containerId: "c1", startedAt: 1, mode: "container" };
    },
    unsettle: projectId => {
      calls.push("unsettle:" + projectId);
      return true;
    },
    setExecOnly: (projectId, value) => {
      calls.push("exec-only:" + projectId + ":" + value);
      return true;
    },
    ...options.deps,
  });
  return { app, calls };
}

function post(app: FastifyInstance, url: string, payload: unknown, token?: string) {
  return app.inject({
    method: "POST",
    url,
    headers: token ? { authorization: "Bearer " + token } : {},
    payload: payload as never,
  });
}

test("без токена двери состояние не отдаётся и зависимости не вызываются", async () => {
  const { app, calls } = await makeApp();
  const response = await post(app, "/api/internal/preview/lookup", { projectId: "p1" });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(calls, []);
});

test("чужой токен тоже не пускается", async () => {
  const { app } = await makeApp();
  const response = await post(app, "/api/internal/preview/lookup", { projectId: "p1" }, "f".repeat(64));
  assert.equal(response.statusCode, 401);
});

test("без ключа шифрования маршрут отвечает 503 и объясняет причину", async () => {
  const { app, calls } = await makeApp();
  delete process.env.WEBNESTDEV_ENCRYPTION_KEY;
  try {
    const response = await post(app, "/api/internal/preview/lookup", { projectId: "p1" }, "whatever");
    assert.equal(response.statusCode, 503);
    assert.match(response.json().error, /WEBNESTDEV_ENCRYPTION_KEY/);
    assert.deepEqual(calls, []);
  } finally {
    process.env.WEBNESTDEV_ENCRYPTION_KEY = KEY;
  }
});

test("с токеном возвращается живой предпросмотр проекта", async () => {
  const { app, calls } = await makeApp();
  const token = previewDoorToken(KEY) ?? "";
  const response = await post(app, "/api/internal/preview/lookup", { projectId: "p1" }, token);
  assert.equal(response.statusCode, 200);
  const body = response.json() as { ok: boolean; exists: boolean; status: { running: boolean; host: string; containerId: string } };
  assert.equal(body.ok, true);
  assert.equal(body.exists, true);
  assert.equal(body.status.running, true);
  assert.equal(body.status.host, "10.0.0.5");
  assert.equal(body.status.containerId, "c1");
  assert.deepEqual(calls, ["exists:p1", "status:p1"]);
});

test("удалённый проект: exists false без запроса статуса", async () => {
  const { app, calls } = await makeApp();
  const response = await post(app, "/api/internal/preview/lookup", { projectId: "deleted" }, previewDoorToken(KEY) ?? "");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true, exists: false, status: { running: false } });
  assert.deepEqual(calls, ["exists:deleted"]);
});

test("без projectId — 400, а не поход в базу", async () => {
  const { app, calls } = await makeApp();
  const response = await post(app, "/api/internal/preview/lookup", { projectId: "   " }, previewDoorToken(KEY) ?? "");
  assert.equal(response.statusCode, 400);
  assert.deepEqual(calls, []);
});

test("событие unsettle и exec-only доводятся до состояния предпросмотра", async () => {
  const { app, calls } = await makeApp();
  const token = previewDoorToken(KEY) ?? "";
  const unsettled = await post(app, "/api/internal/preview/event", { projectId: "p1", event: "unsettle" }, token);
  assert.equal(unsettled.statusCode, 200);
  assert.equal(unsettled.json().changed, true);
  const execOnly = await post(app, "/api/internal/preview/event", { projectId: "p1", event: "exec-only", value: true }, token);
  assert.equal(execOnly.statusCode, 200);
  assert.deepEqual(calls, ["unsettle:p1", "exec-only:p1:true"]);
});

test("exec-only без value и неизвестное событие отвергаются", async () => {
  const { app, calls } = await makeApp();
  const token = previewDoorToken(KEY) ?? "";
  const withoutValue = await post(app, "/api/internal/preview/event", { projectId: "p1", event: "exec-only" }, token);
  assert.equal(withoutValue.statusCode, 400);
  const unknown = await post(app, "/api/internal/preview/event", { projectId: "p1", event: "restart" }, token);
  assert.equal(unknown.statusCode, 400);
  assert.deepEqual(calls, []);
});
