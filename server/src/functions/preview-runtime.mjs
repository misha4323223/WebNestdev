/**
 * Исполнитель функций внутри preview-контейнера.
 *
 * Контейнер один на предпросмотр, а не на запрос. Runtime читает `manifest.json`, который
 * положил `buildFunctions`, и вызывает обработчики по пути из манифеста. Модули кешируются
 * процессом: повторный запрос не пересобирает и не перезапускает функцию.
 *
 * Это отдельный файл, а не строка в TypeScript: его копируют в каталог сборки функций и
 * запускают внутри контейнера напрямую.
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const INITIAL_ROOT = process.env.WEBNESTDEV_PREVIEW_FUNCTIONS_DIR || ".";
const SESSION_ROOT = path.dirname(path.resolve(INITIAL_ROOT));
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

let root = INITIAL_ROOT;
let manifest = await readManifest(root);
let generation = 0;
const modules = new Map();
let queue = Promise.resolve();

async function readManifest(dir) {
  return JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
}

function json(response, status, body) {
  const data = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(data.byteLength),
    "cache-control": "no-store, max-age=0",
  });
  response.end(data);
}

function safeHeaders(input) {
  const output = {};
  for (const [name, value] of Object.entries(input || {})) {
    if (!name || /[\r\n]/.test(name) || /[\r\n]/.test(String(value))) continue;
    if (/^(connection|transfer-encoding|content-length|keep-alive|set-cookie)$/i.test(name)) continue;
    output[name] = String(value);
  }
  return output;
}

function normalizeBody(value) {
  if (value === undefined || value === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value), "utf8");
}

async function normalizeResponse(result) {
  if (result instanceof Response) {
    const body = Buffer.from(await result.arrayBuffer());
    return { status: result.status, headers: safeHeaders(Object.fromEntries(result.headers.entries())), body };
  }
  if (typeof result === "string" || Buffer.isBuffer(result) || result instanceof Uint8Array) {
    return { status: 200, headers: {}, body: normalizeBody(result) };
  }
  if (!result || typeof result !== "object") {
    return { status: 204, headers: {}, body: Buffer.alloc(0) };
  }
  return {
    status: Number.isInteger(result.status) ? result.status : 200,
    headers: safeHeaders(result.headers),
    body: normalizeBody(result.body),
  };
}

async function loadFunction(fn) {
  const cached = modules.get(fn.name);
  if (cached) return cached;
  const moduleUrl = pathToFileURL(path.join(root, fn.name, "index.mjs")).href + "?v=" + generation;
  const loaded = await import(moduleUrl);
  const exportName = String(fn.handler || "").split("#")[1] || "handler";
  const handler = loaded[exportName] ?? loaded.default;
  if (typeof handler !== "function") throw new Error("Функция «" + fn.name + "» не экспортирует " + exportName);
  modules.set(fn.name, handler);
  return handler;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("Тело запроса больше 1 МиБ");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function handle(request, response, fn, url) {
  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    return json(response, 413, { error: error instanceof Error ? error.message : String(error) });
  }
  const handler = await loadFunction(fn);
  const timeoutMs = Math.max(100, Math.min(30_000, Number(fn.timeoutMs) || 10_000));
  let timer;
  try {
    const result = await Promise.race([
      handler({
        method: request.method,
        path: url.pathname,
        query: url.search,
        headers: request.headers,
        body,
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Функция не ответила за " + timeoutMs + " мс")), timeoutMs);
        timer.unref?.();
      }),
    ]);
    const normalized = await normalizeResponse(result);
    if (normalized.body.byteLength > MAX_RESPONSE_BYTES) {
      return json(response, 502, { error: "Ответ функции больше 2 МиБ" });
    }
    response.writeHead(normalized.status, {
      ...normalized.headers,
      "cache-control": "no-store, max-age=0",
      "content-length": String(normalized.body.byteLength),
    });
    response.end(normalized.body);
  } catch (error) {
    if (!response.headersSent) json(response, 502, { error: error instanceof Error ? error.message : String(error) });
    else response.destroy();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url || "/", "http://preview.local");
  if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
    return json(response, 200, { ok: true, runtime: "functions-preview", functions: manifest.functions.length });
  }
  // Внутренний reload после сохранения файлов. Снаружи он недоступен: hybrid-listener
  // проксирует только /api, а сюда приходит сам API-процесс по адресу контейнера.
  if (url.pathname === "/__preview/reload" && request.method === "POST") {
    return readBody(request)
      .then(raw => {
        const parsed = JSON.parse(raw.toString("utf8"));
        if (!parsed || typeof parsed.root !== "string") throw new Error("Не передан root функций");
        const nextRoot = path.resolve(parsed.root);
        if (nextRoot !== SESSION_ROOT && !nextRoot.startsWith(SESSION_ROOT + path.sep)) {
          throw new Error("Каталог функций вне сессии предпросмотра");
        }
        return readManifest(nextRoot).then(nextManifest => {
          root = nextRoot;
          manifest = nextManifest;
          generation += 1;
          modules.clear();
          console.log("[preview-functions] reloaded generation=" + generation);
          json(response, 200, { ok: true, generation, functions: manifest.functions.length });
        });
      })
      .catch(error => json(response, 400, { error: error instanceof Error ? error.message : String(error) }));
  }
  const fn = manifest.functions.find(entry => entry.path === url.pathname);
  if (!fn) return json(response, 404, { error: "Функция не найдена", path: url.pathname });
  if (!fn.methods.includes(request.method)) {
    response.setHeader("allow", fn.methods.join(", "));
    return json(response, 405, { error: "Метод не разрешён" });
  }
  // Один исполнитель, одна очередь: preview не должен запускать десятки обработчиков
  // одновременно на маленькой ВМ. Ошибка одного запроса не ломает очередь.
  queue = queue.then(() => handle(request, response, fn, url)).catch(error => {
    if (!response.headersSent) json(response, 502, { error: error instanceof Error ? error.message : String(error) });
    else response.destroy();
  });
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : PORT;
  console.log("[preview-functions] listening on " + HOST + ":" + actualPort + ", functions=" + manifest.functions.length);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
