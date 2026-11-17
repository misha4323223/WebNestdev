import assert from "node:assert/strict";
import test from "node:test";
import { createFunctionsHostServer, type FunctionsHostDeps } from "./host-server.js";
import { FunctionInvokeError } from "./invoke.js";
import type { HostingSite } from "../hosting/types.js";
import type { FunctionReleaseManifest } from "./build.js";

const site: HostingSite = {
  id: "site-1",
  userId: "user-1",
  projectId: "project-1",
  slug: "demo",
  status: "live",
  activeReleaseId: "abcdef01",
  publishingReleaseId: null,
  nodeId: "node-1",
  lastError: "",
  suspendReason: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  publishedAt: "2026-01-01T00:00:00.000Z",
  unpublishedAt: null,
  suspendedAt: null,
};

const manifest: FunctionReleaseManifest = {
  version: 1,
  runtime: "node",
  bytes: 10,
  functions: [
    {
      name: "hello",
      path: "/api/hello",
      methods: ["GET", "POST"],
      handler: "node:functions/hello.ts#handler",
      file: "index.mjs",
      bytes: 10,
      sha256: "x",
      timeoutMs: 5000,
      memoryMb: 128,
    },
  ],
};

function deps(overrides: Partial<FunctionsHostDeps> = {}): FunctionsHostDeps {
  return {
    getSiteBySlug: async slug => (slug === "demo" ? site : null),
    getSite: async id => (id === site.id ? site : null),
    getDomainByHostname: async hostname => (hostname === "www.example.com" ? { siteId: site.id } as never : null),
    readManifest: async () => manifest,
    invoke: async () => ({ status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("ok") }),
    secrets: async () => ({ TOKEN: "secret" }),
    ...overrides,
  };
}

test("вызывает функцию по Host и пути, возвращая её ответ", async () => {
  const app = createFunctionsHostServer(deps());
  try {
    const response = await app.inject({ method: "GET", url: "/api/hello?name=x", headers: { host: "demo.host.nestdev.ru" } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, "ok");
    assert.equal(response.headers["content-type"], "text/plain");
  } finally {
    await app.close();
  }
});

test("не подменяет отсутствующий API страницей и отвечает 404", async () => {
  const app = createFunctionsHostServer(deps());
  try {
    const response = await app.inject({ method: "GET", url: "/api/missing", headers: { host: "demo.host.nestdev.ru" } });
    assert.equal(response.statusCode, 404);
    assert.match(response.body, /Функция не найдена/);
  } finally {
    await app.close();
  }
});

test("не разрешает метод вне манифеста", async () => {
  const app = createFunctionsHostServer(deps());
  try {
    const response = await app.inject({ method: "DELETE", url: "/api/hello", headers: { host: "demo.host.nestdev.ru" } });
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.allow, "GET, POST");
  } finally {
    await app.close();
  }
});

test("отдаёт 502 с именем функции, когда исполнитель упал", async () => {
  const app = createFunctionsHostServer(
    deps({ invoke: async () => { throw new FunctionInvokeError("boom", 502); } }),
  );
  try {
    const response = await app.inject({ method: "GET", url: "/api/hello", headers: { host: "demo.host.nestdev.ru" } });
    assert.equal(response.statusCode, 502);
    assert.match(response.body, /boom/);
    assert.match(response.body, /hello/);
  } finally {
    await app.close();
  }
});

test("передаёт функции исходное тело POST, включая JSON и query", async () => {
  let seen: { method?: string; path?: string; query?: string; bodyBase64?: string } = {};
  const app = createFunctionsHostServer(
    deps({
      invoke: async input => {
        seen = input.request;
        return { status: 200, headers: {}, body: Buffer.from("ok") };
      },
    }),
  );
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/hello?x=1",
      headers: { host: "demo.host.nestdev.ru", "content-type": "application/json" },
      payload: '{"name":"Ada"}',
    });
    assert.equal(response.statusCode, 200);
    assert.equal(seen.method, "POST");
    assert.equal(seen.path, "/api/hello");
    assert.equal(seen.query, "?x=1");
    assert.equal(Buffer.from(seen.bodyBase64 ?? "", "base64").toString("utf8"), '{"name":"Ada"}');
  } finally {
    await app.close();
  }
});

test("ставит задания из ответа функции в очередь до ответа клиенту", async () => {
  let seen: unknown = null;
  const app = createFunctionsHostServer(
    deps({
      invoke: async () => ({
        status: 202,
        headers: {},
        body: Buffer.from("accepted"),
        jobs: [{ name: "send-receipt", payload: { id: 1 }, idempotencyKey: "order:1" }],
      }),
      enqueueJobs: async input => {
        seen = input;
      },
    }),
  );
  try {
    const response = await app.inject({ method: "POST", url: "/api/hello", headers: { host: "demo.host.nestdev.ru" } });
    assert.equal(response.statusCode, 202);
    assert.deepEqual((seen as { requests: unknown[] }).requests, [{ name: "send-receipt", payload: { id: 1 }, idempotencyKey: "order:1" }]);
  } finally {
    await app.close();
  }
});

test("custom-domain ищет сайт по домену, а не по slug", async () => {
  const app = createFunctionsHostServer(deps());
  try {
    const response = await app.inject({ method: "GET", url: "/api/hello", headers: { host: "www.example.com" } });
    assert.equal(response.statusCode, 200);
  } finally {
    await app.close();
  }
});

test("сайт без активного релиза не вызывает функцию", async () => {
  const app = createFunctionsHostServer(
    deps({ getSiteBySlug: async () => ({ ...site, status: "draft", activeReleaseId: null }) }),
  );
  try {
    const response = await app.inject({ method: "GET", url: "/api/hello", headers: { host: "demo.host.nestdev.ru" } });
    assert.equal(response.statusCode, 404);
    assert.match(response.body, /Сайт не найден/);
  } finally {
    await app.close();
  }
});
