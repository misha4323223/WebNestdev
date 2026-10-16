import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerHealthRoutes } from "./health.js";

/**
 * По этому ответу открытая вкладка панели понимает, что устарела (см. src/lib/app-build.ts), поэтому
 * он обязан быть дешёвым: ни Docker, ни базы, ни метрик — одна строка с номером сборки. Проверка
 * идёт с каждой вкладки регулярно, и всё лишнее здесь платилось бы на каждом её открытии.
 */
test("the version endpoint answers with the build id alone", async () => {
  const previous = process.env.WEBNESTDEV_BUILD;
  process.env.WEBNESTDEV_BUILD = "sha-probe";
  const app = Fastify();
  try {
    await registerHealthRoutes(app);
    await app.ready();
    const response = await app.inject({ method: "GET", url: "/api/version" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true, build: "sha-probe" });
  } finally {
    if (previous === undefined) delete process.env.WEBNESTDEV_BUILD;
    else process.env.WEBNESTDEV_BUILD = previous;
    await app.close();
  }
});

test("a build without a baked-in sha still answers, so the check only compares strings", async () => {
  const previous = process.env.WEBNESTDEV_BUILD;
  delete process.env.WEBNESTDEV_BUILD;
  const app = Fastify();
  try {
    await registerHealthRoutes(app);
    await app.ready();
    const response = await app.inject({ method: "GET", url: "/api/version" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().build, "dev");
  } finally {
    if (previous !== undefined) process.env.WEBNESTDEV_BUILD = previous;
    await app.close();
  }
});
