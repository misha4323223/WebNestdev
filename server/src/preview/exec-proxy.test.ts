import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { execFetchPreview, execFetchScript, execProxyQueueStats, parseExecFetchResult } from "./exec-proxy.js";
import type { DockerExecResult } from "./types.js";

type Upstream = { server: Server; port: number; close: () => Promise<void>; received: Buffer[] };

async function upstream(handler: (request: { url: string; body: Buffer }) => { body: Buffer; contentType?: string; headers?: Record<string, string>; status?: number }): Promise<Upstream> {
  const received: Buffer[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      received.push(body);
      const result = handler({ url: request.url ?? "/", body });
      response.writeHead(result.status ?? 200, { "content-type": result.contentType ?? "text/html; charset=utf-8", ...(result.headers ?? {}) });
      response.end(result.body);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, port, received, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

/**
 * Так `docker exec` выглядит со стороны сервера: строки вышли, код вернулся. Запуск скрипта тем же
 * Node, что стоит в контейнере песочницы, проверяет настоящий путь, а не его описание.
 */
function nodeProvider(containerId = "c1") {
  const calls: string[][] = [];
  const docker = async (args: string[]): Promise<DockerExecResult> => {
    calls.push(args);
    assert.equal(args[0], "exec");
    assert.equal(args[1], containerId);
    assert.deepEqual(args.slice(2, 4), ["node", "-e"]);
    const child = spawn(process.execPath, ["-e", args[4]]);
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk: Buffer) => stdout += chunk.toString());
    child.stderr.on("data", (chunk: Buffer) => stderr += chunk.toString());
    const code = await new Promise<number>(resolve => child.once("close", value => resolve(value ?? 1)));
    return { code, stdout, stderr };
  };
  return { docker, calls };
}

test("a request is carried into the container and the answer comes back with its headers", async () => {
  const site = await upstream(() => ({ body: Buffer.from("<!doctype html><html><body>ok</body></html>"), headers: { etag: "abc" } }));
  const { docker, calls } = nodeProvider();
  try {
    const result = await execFetchPreview({ containerId: "c1", port: site.port, path: "/index.html?v=2" }, { docker });
    assert.ok(result, "приложение ответило через exec");
    assert.equal(result.status, 200);
    assert.equal(result.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(result.headers.etag, "abc");
    assert.equal(result.body.toString("utf8"), "<!doctype html><html><body>ok</body></html>");
    // Адрес внутри контейнера — петля: приложение, слушающее только 127.0.0.1, тоже доступно.
    assert.match(calls[0][4], /fetch\("http:\/\/127\.0\.0\.1:\d+\/index\.html\?v=2"/);
  } finally {
    await site.close();
  }
});

test("a binary body survives the trip in both directions", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255, 128, 7]);
  const site = await upstream(request => request.url === "/echo"
    ? { body: request.body, contentType: "application/octet-stream" }
    : { body: png, contentType: "image/png" });
  const { docker } = nodeProvider();
  try {
    const image = await execFetchPreview({ containerId: "c1", port: site.port, path: "/logo.png" }, { docker });
    assert.ok(image);
    assert.equal(image.headers["content-type"], "image/png");
    assert.deepEqual(image.body, png);

    const upload = Buffer.from([0, 1, 2, 250, 251, 252]);
    const echoed = await execFetchPreview({
      containerId: "c1",
      port: site.port,
      path: "/echo",
      method: "POST",
      headers: { "content-type": "application/octet-stream", cookie: "session=1" },
      body: upload,
    }, { docker });
    assert.ok(echoed);
    assert.deepEqual(echoed.body, upload, "тело запроса и ответа не портится base64-передачей");
  } finally {
    await site.close();
  }
});

test("GET carries no body and HEAD is treated the same way", () => {
  const script = execFetchScript({ url: "http://127.0.0.1:3000/", method: "GET", headers: {}, bodyBase64: "AAAA", timeoutMs: 1000, bodyMaxBytes: 100 });
  assert.doesNotMatch(script, /body:Buffer\.from/);
  assert.match(script, /method:"GET"/);
  const head = execFetchScript({ url: "http://127.0.0.1:3000/", method: "HEAD", headers: {}, timeoutMs: 1000, bodyMaxBytes: 100 });
  assert.doesNotMatch(head, /body:Buffer\.from/);
  const post = execFetchScript({ url: "http://127.0.0.1:3000/", method: "POST", headers: { "content-type": "application/json" }, bodyBase64: "e30=", timeoutMs: 1000, bodyMaxBytes: 100 });
  assert.match(post, /body:Buffer\.from\("e30=","base64"\)/);
});

test("an app that does not answer inside the container is null, not an empty page", async () => {
  const site = await upstream(() => ({ status: 500, body: Buffer.from("boom") }));
  const { docker } = nodeProvider();
  try {
    // Порт закрыт: внутри контейнера запрос тоже не проходит — прокси должен сказать об этом словами.
    const refused = await execFetchPreview({ containerId: "c1", port: 1, path: "/" }, { docker });
    assert.equal(refused, null);
    // А ответ приложения с кодом 5xx — это ответ: его отдаёт панель, а не выдуманная ошибка.
    const failed = await execFetchPreview({ containerId: "c1", port: site.port, path: "/" }, { docker });
    assert.equal(failed?.status, 500);
    assert.equal(failed?.body.toString("utf8"), "boom");
  } finally {
    await site.close();
  }
});

test("a docker call that fails is a refusal, not a rejected promise", async () => {
  const docker = async () => ({ code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" });
  assert.equal(await execFetchPreview({ containerId: "c1", port: 3000, path: "/" }, { docker }), null);
  const throwing = async () => { throw new Error("spawn docker ENOENT") };
  assert.equal(await execFetchPreview({ containerId: "c1", port: 3000, path: "/" }, { docker: throwing }), null);
});

/**
 * Каждый такой запрос — процесс Node внутри контейнера предпросмотра, а панель грузит десятки
 * файлов приложения сразу: без предела одна загрузка страницы уводила бы маленькую ВМ в OOM.
 */
test("requests running inside the container at once are bounded, the rest wait their turn", async () => {
  const previous = process.env.PREVIEW_EXEC_MAX_CONCURRENT;
  process.env.PREVIEW_EXEC_MAX_CONCURRENT = "1";
  let running = 0, peak = 0;
  const docker = async (_args: string[]): Promise<DockerExecResult> => {
    running++;
    peak = Math.max(peak, running);
    await new Promise(resolve => setTimeout(resolve, 20));
    running--;
    return { code: 0, stdout: JSON.stringify({ status: 200, statusText: "OK", headers: {}, bytes: 0, body: "" }), stderr: "" };
  };
  try {
    const answers = await Promise.all(Array.from({ length: 4 }, (_, index) =>
      execFetchPreview({ containerId: "c1", port: 3000, path: "/" + index }, { docker })));
    assert.equal(peak, 1, "одновременно внутрь контейнера идёт один запрос");
    assert.equal(answers.filter(Boolean).length, 4, "остальные ждут, а не отказывают");
    assert.equal(execProxyQueueStats().limit, 1);
    // Место возвращается всегда: занятый слот без запроса остановил бы следующий.
    assert.equal(execProxyQueueStats().active, 0);
  } finally {
    if (previous === undefined) delete process.env.PREVIEW_EXEC_MAX_CONCURRENT;
    else process.env.PREVIEW_EXEC_MAX_CONCURRENT = previous;
  }
});

test("the answer of the script is parsed, and its failure line is not mistaken for a response", () => {
  const parsed = parseExecFetchResult(JSON.stringify({ status: 204, statusText: "No Content", headers: { "x-a": "1", "x-b": 2 }, bytes: 0, body: "" }));
  assert.deepEqual(parsed, { status: 204, statusText: "No Content", headers: { "x-a": "1" }, body: Buffer.alloc(0), truncated: false });
  assert.equal(parseExecFetchResult(JSON.stringify({ error: "fetch failed" })), null);
  assert.equal(parseExecFetchResult(""), null);
  assert.equal(parseExecFetchResult("не json"), null);
  // Тело длиннее предела приезжает обрезанным, и это видно по флагу.
  const big = parseExecFetchResult(JSON.stringify({ status: 200, headers: {}, bytes: 40, body: Buffer.alloc(10, 1).toString("base64") }), 10);
  assert.equal(big?.truncated, true);
});
