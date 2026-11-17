/**
 * Исполнитель одной serverless-функции.
 *
 * Запускается внутри отдельного контейнера с read-only артефактом. Контракт простой:
 * stdin — JSON запроса, stdout — JSON ответа. Никакого общего состояния между запросами:
 * контейнер живёт один вызов и удаляется.
 *
 * Обработчик получает `{ method, path, query, headers, body }`, где `body` — Buffer.
 * Вернуть можно:
 * - строку или Buffer — тело ответа со статусом 200;
 * - `{ status, headers, body }`;
 * - стандартный `Response` (fetch API).
 */
import { pathToFileURL } from "node:url";

function fail(message) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(message).slice(0, 2000) }));
  process.exitCode = 1;
}

function normalizeBody(value) {
  if (value === undefined || value === null) return "";
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return Buffer.from(String(value), "utf8").toString("base64");
}

function normalizeJobs(result) {
  if (!result || typeof result !== "object" || !Array.isArray(result.jobs)) return undefined;
  return result.jobs;
}

function normalizeResponse(result) {
  if (result instanceof Response) {
    return {
      status: result.status,
      headers: Object.fromEntries(result.headers.entries()),
      body: result.body ? null : "",
      // Response.body в Node — поток; читаем его целиком с ограничением на стороне хоста.
      __stream: result.body,
    };
  }
  if (typeof result === "string" || Buffer.isBuffer(result) || result instanceof Uint8Array) {
    return { status: 200, headers: {}, body: normalizeBody(result) };
  }
  if (!result || typeof result !== "object") {
    return { status: 204, headers: {}, body: "" };
  }
  const status = Number.isInteger(result.status) ? result.status : 200;
  const headers = result.headers && typeof result.headers === "object" ? result.headers : {};
  return { status, headers, body: normalizeBody(result.body) };
}

try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const moduleUrl = pathToFileURL(process.env.WEBNESTDEV_FUNCTION_MODULE || "").href;
  const exportName = process.env.WEBNESTDEV_FUNCTION_EXPORT || "handler";
  const loaded = await import(moduleUrl);
  const handler = loaded[exportName] ?? loaded.default;
  if (typeof handler !== "function") throw new Error("Функция не экспортирует " + exportName);
  const result = await handler({
    ...request,
    body: Buffer.from(request.bodyBase64 || "", "base64"),
  });
  const response = normalizeResponse(result);
  const jobs = normalizeJobs(result);
  if (response.__stream) {
    const reader = response.__stream.getReader();
    const parts = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error("Ответ функции больше 2 МиБ");
      parts.push(Buffer.from(value));
    }
    response.body = Buffer.concat(parts).toString("base64");
    delete response.__stream;
  }
  if (response.body && response.body.length > 3 * 1024 * 1024) throw new Error("Ответ функции больше 2 МиБ");
  process.stdout.write(JSON.stringify({ ok: true, ...response, ...(jobs ? { jobs } : {}) }));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
