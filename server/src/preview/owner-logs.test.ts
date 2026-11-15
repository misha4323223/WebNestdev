import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fetchPreviewLogsFromApi, fetchPreviewLogsFromOwner } from "./owner-logs.js";

type Seen = { url: string; method: string; authorization: string; body: string };

async function logsServer(response: { status?: number; body?: unknown; invalidJson?: boolean } = {}) {
  const seen: Seen[] = [];
  const server = createServer((request, reply) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk as Buffer));
    request.on("end", () => {
      seen.push({
        url: request.url ?? "",
        method: request.method ?? "",
        authorization: String(request.headers.authorization ?? ""),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      reply.writeHead(response.status ?? 200, { "content-type": "application/json" });
      reply.end(response.invalidJson ? "{" : JSON.stringify(response.body ?? { running: true, logs: "build output" }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    base: "http://127.0.0.1:" + port,
    owner: "127.0.0.1:" + port,
    seen,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

test("логи hybrid/static запрашиваются у двери владельца с внутренним токеном", async t => {
  const app = await logsServer();
  t.after(() => app.close());
  const result = await fetchPreviewLogsFromOwner("project-1", app.owner, { token: "internal-token" });
  assert.deepEqual(result, { running: true, logs: "build output" });
  assert.equal(app.seen[0]?.url, "/__internal/preview/logs");
  assert.equal(app.seen[0]?.method, "POST");
  assert.equal(app.seen[0]?.authorization, "Bearer internal-token");
  assert.deepEqual(JSON.parse(app.seen[0]?.body ?? "{}"), { projectId: "project-1" });
});

test("вынесенная дверь читает логи из API своего узла", async t => {
  const app = await logsServer();
  t.after(() => app.close());
  const result = await fetchPreviewLogsFromApi("project-2", { base: app.base, token: "internal-token" });
  assert.deepEqual(result, { running: true, logs: "build output" });
  assert.equal(app.seen[0]?.url, "/api/internal/preview/logs");
  assert.equal(app.seen[0]?.authorization, "Bearer internal-token");
  assert.deepEqual(JSON.parse(app.seen[0]?.body ?? "{}"), { projectId: "project-2" });
});

test("ошибка владельца не превращается в пустые логи", async t => {
  const app = await logsServer({ status: 502, body: { error: "Docker недоступен" } });
  t.after(() => app.close());
  await assert.rejects(
    () => fetchPreviewLogsFromOwner("project-3", app.owner, { token: "internal-token" }),
    /HTTP 502: Docker недоступен/,
  );
});

test("некорректный адрес владельца и отсутствие токена отклоняются явно", async () => {
  await assert.rejects(
    () => fetchPreviewLogsFromOwner("project-4", "https://example.com/path", { token: "internal-token" }),
    /Некорректный адрес/,
  );
  await assert.rejects(
    () => fetchPreviewLogsFromOwner("project-4", "127.0.0.1:8788", { token: "" }),
    /WEBNESTDEV_ENCRYPTION_KEY/,
  );
});

test("некорректный JSON владельца не считается успешным ответом", async t => {
  const app = await logsServer({ invalidJson: true });
  t.after(() => app.close());
  await assert.rejects(
    () => fetchPreviewLogsFromOwner("project-5", app.owner, { token: "internal-token" }),
    /не JSON/,
  );
});
