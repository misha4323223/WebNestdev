import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerHealthRoutes } from "./health.js";

/**
 * Публичный health не должен быть картой внутреннего устройства: пути песочниц, очереди и
 * адреса предпросмотров остаются только для запроса с loopback. Заодно проверяется, что
 * `build` — по-прежнему в обоих ответах: на нём держится сверка выкатки.
 */
test("health отдаёт подробности только loopback-запросу", async () => {
  const app = Fastify();
  try {
    await registerHealthRoutes(app);
    await app.ready();

    const external = await app.inject({ method: "GET", url: "/api/health", remoteAddress: "203.0.113.10" });
    assert.equal(external.statusCode, 200, external.body);
    const publicBody = external.json() as Record<string, unknown>;
    assert.equal(typeof publicBody.build, "string");
    assert.equal(publicBody.sandbox, undefined);
    assert.equal(publicBody.activity, undefined);

    const internal = await app.inject({ method: "GET", url: "/api/health", remoteAddress: "127.0.0.1" });
    assert.equal(internal.statusCode, 200, internal.body);
    const internalBody = internal.json() as Record<string, unknown>;
    assert.equal(typeof internalBody.build, "string");
    assert.ok(internalBody.sandbox, "loopback-ответ содержит состояние песочницы");
    assert.ok(internalBody.activity, "loopback-ответ содержит метрики хоста");
  } finally {
    await app.close();
  }
});
