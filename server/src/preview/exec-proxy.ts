import { createLimiter, positiveInt, type LimiterStats } from "../concurrency.js";
import { dockerExec } from "./docker-exec.js";
import type { DockerExecResult } from "./types.js";

/**
 * Запрос приложения изнутри его контейнера — вторая дверь к предпросмотру.
 *
 * Прямой путь (сервер обращается к адресу контейнера) самый быстрый и единственный, который отдаёт
 * поток: он уходит как есть, вместе с websocket живого HMR. Но он требует, чтобы сервер и контейнер
 * стояли на одной Docker-сети, а Docker изолирует bridge-сети друг от друга. Тогда приложение живо,
 * отвечает внутри контейнера, а сервер и панель до него не доходят: предпросмотр числится
 * запущенным, а кадр в панели белый, и «Прокси предпросмотра не сработал: fetch failed» — всё, что
 * видит тот, кто разбирается с этим через браузер.
 *
 * `docker exec` не зависит от сети вовсе — именно им платформа уже спрашивает приложение о готовности
 * (`previewAppAnswers` в preview/app-http.ts). Поэтому тот же путь используется и как ответ панели: медленнее
 * (на каждый файл приложения — отдельный процесс в контейнере) и без горячей перезагрузки, но
 * приложение видно, а не «белый экран при живом предпросмотре». Прямой путь остаётся основным и
 * берётся снова, как только адрес контейнера подтверждается (см. preview-address.ts).
 */

/** Бюджет одного запроса: это ответ приложения, а не ожидание старта, поэтому он короче прокси. */
const DEFAULT_TIMEOUT_MS = 25_000;
/**
 * Сколько тела возвращается из контейнера. Через `docker exec` тело едет строкой в base64 (в трубе
 * нет двоичного потока), поэтому предел конечен: 25 МБ хватает собранному приложению и картинке в
 * ответе, а ответ больше этого сигнализирует о себе флагом `truncated`.
 */
const DEFAULT_BODY_MAX_BYTES = 25_000_000;

/**
 * Сколько запросов к приложению идут внутрь контейнера одновременно. Каждый — отдельный процесс
 * Node внутри контейнера предпросмотра (десятки мегабайт), а панель грузит десятки файлов
 * приложения параллельно: без предела одна загрузка страницы порождала бы столько процессов,
 * сколько в ней модулей, и контейнер (а на маленькой ВМ — вместе с сервером) уходил бы в OOM.
 * Очередь конечна и во время ожидания отвечает отказом: «приложение не ответило» — это то же
 * состояние, что и при исчерпанном лимите, и панель говорит о нём словами.
 */
const limiter = createLimiter(() => ({
  limit: positiveInt(process.env.PREVIEW_EXEC_MAX_CONCURRENT, 4),
  queueLimit: positiveInt(process.env.PREVIEW_EXEC_MAX_QUEUE, 64),
  waitTimeoutMs: positiveInt(process.env.PREVIEW_EXEC_QUEUE_TIMEOUT_MS, 60_000),
  busyLabel: "Предпросмотр через docker exec",
}));

/** Сколько таких запросов идёт сейчас и сколько ждёт — для /api/health (activity.previews.exec). */
export function execProxyQueueStats(): LimiterStats {
  return limiter.stats();
}

export type ExecFetchInput = {
  containerId: string;
  /** Порт внутри контейнера: приложение слушает его на петле или на всех адресах — оба видны отсюда. */
  port: number;
  /** Путь с запросом, например `/src/main.tsx?v=1`. */
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer;
  timeoutMs?: number;
  bodyMaxBytes?: number;
};

export type ExecFetchResult = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Buffer;
  /** Тело приложения оказалось больше предела чтения: ответ отдан частично. */
  truncated: boolean;
};

/**
 * Скрипт для `node -e` внутри контейнера: один JSON в stdout (статус, заголовки, тело в base64),
 * поэтому двоичный ответ не ломает разбор. Тело отправляется так же в base64 — иначе двоичный
 * запрос (загрузка файла) дошёл бы искажённым.
 */
export function execFetchScript(input: {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyBase64?: string;
  timeoutMs: number;
  bodyMaxBytes: number;
}) {
  const method = input.method.toUpperCase();
  // Тело запроса у GET/HEAD запрещено самим fetch: передавать его туда — гарантированная ошибка.
  const body = input.bodyBase64 !== undefined && method !== "GET" && method !== "HEAD"
    ? `body:Buffer.from(${JSON.stringify(input.bodyBase64)},"base64"),`
    : "";
  return [
    "const controller=new AbortController();",
    `const timer=setTimeout(()=>{controller.abort()},${input.timeoutMs});`,
    "timer.unref&&timer.unref();",
    `fetch(${JSON.stringify(input.url)},{method:${JSON.stringify(method)},headers:${JSON.stringify(input.headers)},${body}redirect:"manual",signal:controller.signal}).then(async response=>{`,
    "const buffer=Buffer.from(await response.arrayBuffer());",
    `const body=buffer.subarray(0,${input.bodyMaxBytes});`,
    "const headers={};response.headers.forEach((value,name)=>{headers[name]=value});",
    "process.stdout.write(JSON.stringify({status:response.status,statusText:response.statusText,headers,bytes:buffer.length,body:body.toString(\"base64\")}));",
    "}).catch(error=>{process.stdout.write(JSON.stringify({error:String(error&&error.message||error)}));process.exitCode=1});",
  ].join("");
}

/** Разбор ответа скрипта; null — скрипт не ответил приложением (печатал причину и код возврата). */
export function parseExecFetchResult(stdout: string, bodyMaxBytes = DEFAULT_BODY_MAX_BYTES): ExecFetchResult | null {
  const line = stdout.split("\n").map(value => value.trim()).filter(Boolean).at(-1);
  if (!line) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(line) } catch { return null }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = parsed as { status?: unknown; statusText?: unknown; headers?: unknown; bytes?: unknown; body?: unknown };
  if (typeof value.status !== "number" || typeof value.body !== "string") return null;
  const headers: Record<string, string> = {};
  if (typeof value.headers === "object" && value.headers !== null) {
    for (const [name, header] of Object.entries(value.headers as Record<string, unknown>)) {
      if (typeof header === "string") headers[name] = header;
    }
  }
  const body = Buffer.from(value.body, "base64");
  const bytes = typeof value.bytes === "number" ? value.bytes : body.length;
  return {
    status: value.status,
    statusText: typeof value.statusText === "string" ? value.statusText : "",
    headers,
    body,
    // Полный размер известен только скрипту: тело обрезано тем же пределом, что указан здесь.
    truncated: bytes >= bodyMaxBytes,
  };
}

export type ExecFetchDeps = { docker?: (args: string[], timeoutMs?: number) => Promise<DockerExecResult> };

/**
 * Запрос приложения внутри его контейнера. null — приложение не ответило (нет Docker, контейнер
 * остановлен, команда не дождалась): прокси тогда говорит об этом словами, а не пустым кадром.
 */
export async function execFetchPreview(input: ExecFetchInput, deps: ExecFetchDeps = {}): Promise<ExecFetchResult | null> {
  const docker = deps.docker ?? dockerExec;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bodyMaxBytes = input.bodyMaxBytes ?? DEFAULT_BODY_MAX_BYTES;
  const script = execFetchScript({
    url: "http://127.0.0.1:" + input.port + input.path,
    method: input.method ?? "GET",
    headers: input.headers ?? {},
    bodyBase64: input.body?.toString("base64"),
    timeoutMs,
    bodyMaxBytes,
  });
  // Место в очереди берётся до обращения к контейнеру и возвращается в любом случае: занятый слот
  // без запроса останавливал бы следующий (см. limiter выше). Отказ очереди — это null, как и
  // любой другой отказ приложения: вызывающий говорит «не ответило», а не падает.
  const slot = await limiter.acquire().catch(() => null);
  if (!slot) return null;
  try {
    const result = await docker(["exec", input.containerId, "node", "-e", script], timeoutMs + 5_000).catch(() => null);
    if (!result || result.code !== 0) return null;
    return parseExecFetchResult(result.stdout, bodyMaxBytes);
  } finally {
    slot.release();
  }
}
