import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { previewOwnerTarget } from "./preview-owner.js";

/**
 * Запрос публичного адреса, который обслуживает другая реплика.
 *
 * NLB не различает, где запущен preview, и каждая новая TCP-сессия может попасть на любую
 * дверь. Пока preview был контейнером на чужом Docker-мосту, такая дверь не могла до него
 * дойти. Теперь запись preview несёт `owner_address`; дверь, которая не является владельцем,
 * передаёт запрос по приватной сети двери-владельцу. Владелец уже видит свой контейнер или
 * static-слушатель и отдаёт приложение как обычно. Это работает и для HTTP, и для HMR
 * WebSocket, а ticket/cookie остаются обычной авторизацией на обеих дверях.
 */

/** Заголовки одного соединения: их нельзя передавать дальше как есть. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function peerHeaders(request: IncomingMessage): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  return headers;
}

/** Исходный upgrade-запрос: Host, cookie и Sec-WebSocket-* обязаны дойти до владельца. */
function rawUpgradeRequest(request: IncomingMessage): string {
  const lines = [request.method + " " + (request.url ?? "/") + " HTTP/1.1"];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    lines.push(request.rawHeaders[index] + ": " + request.rawHeaders[index + 1]);
  }
  return lines.join("\r\n") + "\r\n\r\n";
}

export function peerPreviewTarget(owner: string) {
  const target = previewOwnerTarget(owner);
  if (!target) throw new Error("Неверный адрес двери-владельца предпросмотра");
  return target;
}

/**
 * Проксирует обычный запрос владельцу и отдаёт его ответ байт в байт. Не буферизует тело ответа,
 * поэтому SSE и потоковые ответы приложения работают так же, как на локальной двери.
 */
export async function forwardPreviewHttp(
  request: IncomingMessage,
  response: ServerResponse,
  owner: string,
  body: Buffer | undefined,
): Promise<void> {
  const target = peerPreviewTarget(owner);
  await new Promise<void>((resolve, reject) => {
    const upstream = http.request(
      {
        host: target.host,
        port: target.port,
        method: request.method,
        path: request.url ?? "/",
        headers: peerHeaders(request),
        timeout: 60_000,
      },
      incoming => {
        // Владелец уже применил no-store и вставил скрипт выбора элемента; здесь ничего не
        // переписываем, иначе повторная вставка сломала бы страницу.
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.on("error", reject);
        incoming.pipe(response);
        response.once("finish", () => resolve());
        response.once("close", () => resolve());
      },
    );
    upstream.on("timeout", () => upstream.destroy(new Error("Дверь-владелец предпросмотра не ответила вовремя")));
    upstream.on("error", reject);
    if (body?.length) upstream.end(body);
    else upstream.end();
  });
}

/**
 * Проксирует upgrade до двери-владельца. Сюда попадает HMR dev-сервера и любые WebSocket
 * приложения; платформа не разбирает протокол, только передаёт байты.
 */
export function forwardPreviewUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  owner: string,
  onError: (error: Error) => void,
): void {
  let target: { host: string; port: number };
  try {
    target = peerPreviewTarget(owner);
  } catch (error) {
    onError(error instanceof Error ? error : new Error(String(error)));
    return;
  }
  const upstream = connect(target.port, target.host);
  upstream.setTimeout(10_000, () => upstream.destroy(new Error("Дверь-владелец не приняла WebSocket вовремя")));
  upstream.once("error", onError);
  upstream.once("connect", () => {
    upstream.setTimeout(0);
    upstream.removeListener("error", onError);
    // После установления соединения ошибка сокета не должна ронять процесс: закрываем пару.
    upstream.on("error", () => socket.destroy());
    upstream.write(rawUpgradeRequest(request));
    if (head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
    upstream.once("close", () => socket.destroy());
  });
  const close = () => upstream.destroy();
  socket.once("close", close);
  socket.once("error", close);
}
