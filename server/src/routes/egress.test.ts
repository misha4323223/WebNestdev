import assert from "node:assert/strict";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { registerEgressRoutes, type EgressRouteDeps } from "./egress.js";
import { bearerTokenValid, internalToken, previewDoorToken } from "../preview/door-token.js";
import { EGRESS_WHOIS_PURPOSE } from "../egress/config.js";

/**
 * Внутренний маршрут «чей это адрес». Он не отдаёт ничего, кроме идентификатора проекта, но именно
 * он делает журнал отказов пригодным для разбора: без токена — 401, без ключа — 503, а токен двери
 * предпросмотра к нему не подходит (назначение входит в HMAC).
 */

const KEY = "k".repeat(64);
process.env.WEBNESTDEV_ENCRYPTION_KEY = KEY;

const TOKEN = internalToken(EGRESS_WHOIS_PURPOSE, KEY) ?? "";

async function makeApp(deps: Partial<EgressRouteDeps> = {}): Promise<{ app: FastifyInstance; calls: string[] }> {
  const calls: string[] = [];
  const app = Fastify();
  await registerEgressRoutes(app, {
    projectByAddress: async address => {
      calls.push(address);
      return address === "172.31.0.7" ? "p-1" : null;
    },
    ...deps,
  });
  return { app, calls };
}

function post(app: FastifyInstance, payload: unknown, token?: string) {
  return app.inject({
    method: "POST",
    url: "/api/internal/egress/whois",
    headers: token ? { authorization: "Bearer " + token } : {},
    payload: payload as never,
  });
}

test("без токена адрес не сопоставляется и зависимость не вызывается", async () => {
  const { app, calls } = await makeApp();
  const response = await post(app, { address: "172.31.0.7" });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(calls, []);
});

test("токен двери предпросмотра к маршруту egress не подходит", async () => {
  const { app, calls } = await makeApp();
  const doorToken = previewDoorToken(KEY) ?? "";
  assert.equal(bearerTokenValid("Bearer " + doorToken, TOKEN), false);
  const response = await post(app, { address: "172.31.0.7" }, doorToken);
  assert.equal(response.statusCode, 401);
  assert.deepEqual(calls, []);
});

test("по токену отдаётся проект, незнакомый адрес — null", async () => {
  const { app, calls } = await makeApp();
  const known = await post(app, { address: "172.31.0.7" }, TOKEN);
  assert.equal(known.statusCode, 200);
  assert.deepEqual(known.json(), { ok: true, projectId: "p-1" });
  const unknown = await post(app, { address: "172.31.9.9" }, TOKEN);
  assert.deepEqual(unknown.json(), { ok: true, projectId: null });
  assert.deepEqual(calls, ["172.31.0.7", "172.31.9.9"]);
});

test("мусор вместо адреса — 400, без обращения к карте предпросмотров", async () => {
  const { app, calls } = await makeApp();
  for (const payload of [{}, { address: "" }, { address: "hello world" }, { address: 42 }]) {
    const response = await post(app, payload, TOKEN);
    assert.equal(response.statusCode, 400);
  }
  assert.deepEqual(calls, []);
});

test("без ключа шифрования маршрут отвечает 503, а не 401", async () => {
  const saved = process.env.WEBNESTDEV_ENCRYPTION_KEY;
  delete process.env.WEBNESTDEV_ENCRYPTION_KEY;
  const { app } = await makeApp();
  try {
    const response = await post(app, { address: "172.31.0.7" }, TOKEN);
    assert.equal(response.statusCode, 503);
  } finally {
    process.env.WEBNESTDEV_ENCRYPTION_KEY = saved;
  }
});
