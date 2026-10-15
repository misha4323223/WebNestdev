import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { containerFetchScript, parseContainerResponse, previewAppAnswers } from "./app-http.js";

/** Тот же скрипт, что едет в контейнер, но запущенный здесь: это и есть предмет проверки. */
function runScript(script: string) {
  return new Promise<{ code: number; stdout: string }>(resolve => {
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.once("close", code => resolve({ code: code ?? 1, stdout: stdout || stderr }));
  });
}

async function serve(handler: (url: string) => { status?: number; body: string; contentType?: string }) {
  const server = createServer((request, response) => {
    const result = handler(request.url ?? "/");
    response.writeHead(result.status ?? 200, { "content-type": result.contentType ?? "text/html; charset=utf-8" });
    response.end(result.body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { port, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test("the probe brings the answer back as status, type and body", async () => {
  const site = await serve(() => ({ body: "<html><body>привет</body></html>" }));
  try {
    const result = await runScript(containerFetchScript({ url: `http://127.0.0.1:${site.port}/about`, timeoutMs: 4000, bodyMaxBytes: 20_000 }));
    assert.equal(result.code, 0, result.stdout);
    const parsed = parseContainerResponse(result.stdout);
    assert.equal(parsed?.status, 200);
    assert.match(String(parsed?.contentType), /text\/html/);
    assert.match(String(parsed?.body), /привет/);
    assert.equal(parsed?.truncated, false);
  } finally {
    await site.close();
  }
});

test("a large body is cut off at the budget instead of travelling whole", async () => {
  const site = await serve(() => ({ body: "x".repeat(5000) }));
  try {
    const result = await runScript(containerFetchScript({ url: `http://127.0.0.1:${site.port}/`, timeoutMs: 4000, bodyMaxBytes: 100 }));
    const parsed = parseContainerResponse(result.stdout, 100);
    assert.equal(parsed?.body.length, 100);
    assert.equal(parsed?.truncated, true);
  } finally {
    await site.close();
  }
});

test("a dead port and a hanging app both come back as no answer", async () => {
  const site = await serve(() => ({ body: "ok" }));
  const deadPort = site.port;
  await site.close();
  const dead = await runScript(containerFetchScript({ url: `http://127.0.0.1:${deadPort}/`, timeoutMs: 2000, bodyMaxBytes: 1000 }));
  assert.notEqual(dead.code, 0);
  assert.equal(parseContainerResponse(dead.stdout), null);

  // Приложение приняло соединение и молчит: скрипт обрывает себя сам, а не ждёт docker exec.
  const hanging = createServer(() => undefined);
  await new Promise<void>(resolve => hanging.listen(0, "127.0.0.1", resolve));
  const address = hanging.address();
  const hangingPort = typeof address === "object" && address ? address.port : 0;
  try {
    const result = await runScript(containerFetchScript({ url: `http://127.0.0.1:${hangingPort}/`, timeoutMs: 300, bodyMaxBytes: 1000 }));
    assert.notEqual(result.code, 0);
    assert.equal(parseContainerResponse(result.stdout), null);
  } finally {
    hanging.closeAllConnections();
    await new Promise<void>(resolve => hanging.close(() => resolve()));
  }
});

test("readiness counts any answer below 500 as 'the app is up'", async () => {
  const site = await serve(() => ({ status: 404, body: "not found" }));
  const notFound = await runScript(containerFetchScript({ url: `http://127.0.0.1:${site.port}/`, timeoutMs: 4000, bodyMaxBytes: 0 }));
  const broken = await serve(() => ({ status: 500, body: "boom" }));
  const failed = await runScript(containerFetchScript({ url: `http://127.0.0.1:${broken.port}/`, timeoutMs: 4000, bodyMaxBytes: 0 }));
  const asDocker = (result: { code: number; stdout: string }) => async () => ({ ...result, stderr: "" });
  try {
    // 404 — это работающий сервер (страница ещё не создана), 500 — уже нет.
    assert.equal(await previewAppAnswers({ containerId: "c1", port: site.port }, asDocker(notFound)), true);
    assert.equal(await previewAppAnswers({ containerId: "c1", port: broken.port }, asDocker(failed)), false);
    // Контейнера нет или приложение не отвечает — тоже «нет».
    assert.equal(await previewAppAnswers({ containerId: "c1", port: site.port }, async () => ({ code: 1, stdout: "", stderr: "no such container" })), false);
  } finally {
    await site.close();
    await broken.close();
  }
});
