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

/**
 * Переменные, которыми управляет контейнер, а не проект. Их нельзя переопределить из
 * `.env*`: `PORT`/`HOST` увели бы listener с ожидаемого адреса, `NODE_OPTIONS` повлиял бы
 * на дочерние процессы, а `HTTP_PROXY`/`HTTPS_PROXY` обошли бы egress-фильтр предпросмотра.
 */
const RESERVED_ENV = new Set([
  "PATH", "HOME", "NODE_OPTIONS", "PORT", "HOST", "CI",
  "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
  "NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy",
  "npm_config_proxy", "npm_config_https_proxy",
]);
const ENV_FILES = [".env", ".env.local", ".env.production"];

function reservedEnv(name) {
  return RESERVED_ENV.has(name) || name.startsWith("WEBNESTDEV_");
}

/**
 * Минимальный разбор `.env` в том же формате, в котором платформа пишет секреты: `export`,
 * комментарии, одинарные/двойные кавычки, экранированный `\\n` и многострочные значения.
 * Это копия правил `parseEnvFileContent` из platform-env: runtime запускается отдельным
 * файлом в контейнере и не может импортировать TypeScript сервера.
 */
function parseEnvFile(content) {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const values = [];
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*)$/);
    if (!match) continue;
    let raw = match[2];
    if (raw[0] === '"' || raw[0] === "'") {
      while (!closedQuote(raw) && index + 1 < lines.length) {
        index += 1;
        raw += "\n" + lines[index];
      }
    }
    values.push({ name: match[1], value: decodeEnvValue(raw) });
  }
  return values;
}

function closedQuote(value) {
  const quote = value[0];
  const text = value.trimEnd();
  if (text.length <= 1) return false;
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== quote) continue;
    let slashes = 0;
    for (let back = index - 1; back >= 0 && text[back] === "\\"; back -= 1) slashes += 1;
    if (slashes % 2 === 0) count += 1;
  }
  return count % 2 === 0;
}

function decodeEnvValue(raw) {
  const text = raw.trim();
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    const end = text.includes("\n") ? text.lastIndexOf(quote) : closingQuoteIndex(text, quote);
    if (end > 0) {
      const inner = text.slice(1, end);
      if (quote === "'") return inner;
      return inner.replace(/\\(n|r|t|"|\\)/g, (_, code) => (
        code === "n" ? "\n" : code === "r" ? "\r" : code === "t" ? "\t" : code === '"' ? '"' : "\\"
      ));
    }
  }
  // Незакавыченное значение: комментарий после него отбрасывается по правилам dotenv.
  const comment = text.search(/\s+#/);
  return (comment >= 0 ? text.slice(0, comment) : text).trim();
}

function closingQuoteIndex(text, quote) {
  for (let index = 1; index < text.length; index += 1) {
    if (text[index] !== quote) continue;
    let slashes = 0;
    for (let back = index - 1; back >= 0 && text[back] === "\\"; back -= 1) slashes += 1;
    if (slashes % 2 === 0) return index;
  }
  return -1;
}

/**
 * Секреты проекта приходят в контейнер как read-only `.env*` поверх `/workspace` (см.
 * preview-secrets.ts). Node сам их не читает, поэтому runtime загружает их до импорта
 * обработчиков: `process.env.DATABASE_URL` должен быть доступен и на верхнем уровне модуля.
 * Значения не логируются; при ошибке чтения остаётся только имя файла.
 */
async function loadProjectEnv() {
  for (const file of ENV_FILES) {
    let content;
    try {
      content = await readFile(path.join(process.cwd(), file), "utf8");
    } catch (error) {
      if (error && error.code !== "ENOENT") console.error("[preview-functions] env " + file + ": " + (error.message || String(error)));
      continue;
    }
    for (const entry of parseEnvFile(content)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(entry.name)) continue;
      if (reservedEnv(entry.name)) continue;
      process.env[entry.name] = entry.value;
    }
  }
}

await loadProjectEnv();

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

function queryParams(url) {
  const query = {};
  for (const [key, value] of url.searchParams) {
    query[key] = query[key] === undefined ? value : query[key] + "," + value;
  }
  return query;
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
        query: queryParams(url),
        search: url.search,
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
