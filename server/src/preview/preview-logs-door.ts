import type { IncomingMessage, ServerResponse } from "node:http";
import { previewDoorToken, previewDoorTokenValid } from "./door-token.js";
import type { PreviewLogsSnapshot } from "./owner-logs.js";

/**
 * Внутренний маршрут логов на двери ноды-владельца.
 *
 * Дверь уже знает, что её адрес (host:port) доступен остальным репликам, и умеет отдавать
 * приложение по имени проекта. Этот маршрут не ищет host проекта и не принимает ticket: только
 * Bearer-токен внутреннего канала. Так `preview.logs` на второй ноде получает build/backend вывод
 * владельца, а не пустую локальную карту.
 *
 * Ответ — маленький JSON; тело запроса ограничено, чтобы служебный маршрут нельзя было занять
 * потоком. Ошибки возвращаются отдельным JSON, а не HTML-страницей приложения.
 */

const MAX_BODY_BYTES = 16_384;
const MAX_PROJECT_ID = 128;

export type PreviewLogsDoorDeps = {
  logs: (projectId: string) => Promise<PreviewLogsSnapshot>;
};

function sendJson(response: ServerResponse, status: number, value: unknown) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": String(body.length),
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

export async function handlePreviewLogsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: PreviewLogsDoorDeps,
): Promise<void> {
  if (request.method !== "POST") {
    response.setHeader("allow", "POST");
    sendJson(response, 405, { ok: false, error: "Здесь принимается только POST" });
    return;
  }
  const expected = previewDoorToken();
  if (!expected) {
    sendJson(response, 503, { ok: false, error: "WEBNESTDEV_ENCRYPTION_KEY не задан — внутренний канал логов закрыт" });
    return;
  }
  if (!previewDoorTokenValid(request.headers.authorization, expected)) {
    sendJson(response, 401, { ok: false, error: "Внутренний маршрут логов: нужен токен двери" });
    return;
  }
  if (!String(request.headers["content-type"] ?? "").includes("application/json")) {
    sendJson(response, 415, { ok: false, error: "Логи принимаются только с JSON-телом" });
    return;
  }
  const parsed = await readJson(request);
  const projectId = typeof parsed === "object" && parsed !== null
    ? (parsed as { projectId?: unknown }).projectId
    : undefined;
  const id = typeof projectId === "string" ? projectId.trim() : "";
  if (!id || id.length > MAX_PROJECT_ID) {
    sendJson(response, 400, { ok: false, error: "Нужен projectId" });
    return;
  }
  try {
    const snapshot = await deps.logs(id);
    sendJson(response, 200, snapshot);
  } catch (error) {
    sendJson(response, 502, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
