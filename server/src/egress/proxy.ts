import { lookup } from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import { describeEgressDeny, type EgressDecision } from "./allowlist.js";

/**
 * Egress-прокси для кода проекта (пункт 5.1 плана масштабирования).
 *
 * Зачем прокси, если можно закрыть выход правилами Docker. Правила закрывают обход, но не отвечают
 * на вопрос «куда и кто ходил»: iptables видит только IP. Прокси видит имя домена до соединения,
 * поэтому даёт allowlist по домену, журнал отказов и счётчик трафика — то, из-за чего этот пункт
 * плана вообще существует. Работают они вместе: прокси пускает по правилам, правила не дают пройти
 * мимо прокси.
 *
 * Прокси намеренно ничего не расшифровывает: HTTPS идёт туннелем CONNECT, байты приложения
 * не читаются и не пишутся в журнал. В журнал попадают только домен, порт, причина отказа, адрес
 * источника и (если API его знает) проект.
 *
 * Решения принимает снаружи (`check`), адрес резолвится до проверки и используется для соединения:
 * проверка и подключение не могут разойтись на разных DNS-ответах.
 */

export type EgressDenyEntry = {
  at: number;
  host: string;
  port: number;
  reason: string;
  source: string;
  projectId: string | null;
};

export type EgressStats = {
  startedAt: number;
  requests: number;
  allowed: number;
  denied: number;
  failed: number;
  bytesUp: number;
  bytesDown: number;
  denies: EgressDenyEntry[];
  deniedByHost: Record<string, number>;
  deniedByReason: Record<string, number>;
};

export function createEgressStats(now: number = Date.now()): EgressStats {
  return {
    startedAt: now,
    requests: 0,
    allowed: 0,
    denied: 0,
    failed: 0,
    bytesUp: 0,
    bytesDown: 0,
    denies: [],
    deniedByHost: {},
    deniedByReason: {},
  };
}

export type EgressProxyOptions = {
  /** Решение по соединению: домен, порт и уже разрешённый адрес. */
  check: (host: string, port: number, address: string) => EgressDecision;
  /** Резолвер адреса; подменяется в тестах, в бою — системный. */
  resolve?: (host: string) => Promise<string>;
  /** Адрес источника → проект. Медленный и необязательный: отказ не должен задерживать ответ. */
  identify?: (source: string) => Promise<string | null>;
  stats?: EgressStats;
  onDeny?: (entry: EgressDenyEntry) => void;
  onAllowed?: (entry: { host: string; port: number; source: string }) => void;
  /** Сколько ждать установки туннеля и сколько держать простаивающее соединение. */
  timeoutMs?: number;
  now?: () => number;
  /** Сколько последних отказов хранить для health; остальное остаётся в счётчиках. */
  maxDenies?: number;
};

export type EgressProxy = {
  server: http.Server;
  stats: EgressStats;
  /** Сколько соединений открыто прямо сейчас: без этого health не отличит простой от утечки. */
  connections: () => number;
  close: () => Promise<void>;
};

/** `host:port` из строки CONNECT; IPv6 приходит в квадратных скобках. */
export function parseConnectTarget(raw: string): { host: string; port: number } | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const close = value.lastIndexOf("]");
  if (value.startsWith("[") && close > 0) {
    const host = value.slice(1, close);
    const port = Number(value.slice(close + 1).replace(/^:/, ""));
    return host && Number.isInteger(port) && port > 0 ? { host, port } : null;
  }
  const colon = value.lastIndexOf(":");
  if (colon <= 0) return null;
  const host = value.slice(0, colon);
  const port = Number(value.slice(colon + 1));
  return host && Number.isInteger(port) && port > 0 && port < 65_536 ? { host, port } : null;
}

function clientAddress(socket: net.Socket): string {
  return (socket.remoteAddress ?? "").replace(/^::ffff:/, "") || "unknown";
}

/** Заголовки, которые прокси обязан снять: они описывают соединение с прокси, а не с сервером. */
const HOP_HEADERS = new Set(["proxy-authorization", "proxy-connection", "connection", "keep-alive", "upgrade"]);

function forwardHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_HEADERS.has(key.toLowerCase())) continue;
    if (value === undefined) continue;
    result[key] = value;
  }
  return result;
}

const STATUS_TEXT: Record<number, string> = { 400: "Bad Request", 403: "Forbidden", 502: "Bad Gateway" };

function writeProxyResponse(socket: net.Socket, status: number, reason: string, body: string) {
  const payload = Buffer.from(body, "utf8");
  socket.end(
    "HTTP/1.1 " + String(status) + " " + (STATUS_TEXT[status] ?? "Error") + "\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      "Content-Length: " + String(payload.length) + "\r\n" +
      "X-Egress-Deny: " + reason + "\r\n" +
      "Connection: close\r\n\r\n" + body,
  );
}

const DEFAULT_TIMEOUT_MS = 120_000;

export function startEgressProxy(options: EgressProxyOptions): EgressProxy {
  const stats = options.stats ?? createEgressStats();
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxDenies = options.maxDenies ?? 20;
  const resolve =
    options.resolve ?? ((host: string) => lookup(host).then(result => result.address));
  const sockets = new Set<net.Socket>();
  const server = http.createServer();

  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  });

  /**
   * Проект по адресу источника: запрос к API ограничен таймаутом, а его отказ не делает отказ
   * в соединении менее понятным — в журнале останется адрес без проекта.
   */
  async function identify(source: string): Promise<string | null> {
    if (!options.identify) return null;
    try {
      const result = await options.identify(source);
      return typeof result === "string" && result ? result : null;
    } catch {
      return null;
    }
  }

  async function recordDeny(host: string, port: number, reason: string, source: string) {
    stats.denied += 1;
    stats.deniedByHost[host] = (stats.deniedByHost[host] ?? 0) + 1;
    stats.deniedByReason[reason] = (stats.deniedByReason[reason] ?? 0) + 1;
    const entry: EgressDenyEntry = { at: now(), host, port, reason, source, projectId: await identify(source) };
    stats.denies.unshift(entry);
    if (stats.denies.length > maxDenies) stats.denies.length = maxDenies;
    try {
      options.onDeny?.(entry);
    } catch {
      // Журнал не должен ронять соединение: это диагностика, а не часть протокола.
    }
  }

  /** Обычный HTTP: запрос приходит в абсолютной форме, ответ пересылается как есть. */
  async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    stats.requests += 1;
    const source = clientAddress(request.socket);
    let target: URL;
    try {
      target = new URL(String(request.url ?? ""));
    } catch {
      stats.failed += 1;
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8", "x-egress-deny": "bad-host" });
      response.end("Прокси ждёт запрос с абсолютным адресом: http://домен/путь");
      return;
    }
    const host = target.hostname;
    const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
    let address: string;
    try {
      address = await resolve(host);
    } catch {
      stats.failed += 1;
      await recordDeny(host, port, "unresolved", source);
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8", "x-egress-deny": "unresolved" });
      response.end("Не удалось разрешить имя: " + host);
      return;
    }
    const verdict = options.check(host, port, address);
    if (!verdict.allowed) {
      await recordDeny(host, port, verdict.reason, source);
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8", "x-egress-deny": verdict.reason });
      response.end(describeEgressDeny(verdict.reason, host));
      return;
    }
    stats.allowed += 1;
    options.onAllowed?.({ host, port, source });
    const upstream = http.request({
      host: address,
      port,
      method: request.method,
      path: target.pathname + target.search,
      headers: forwardHeaders(request.headers),
      agent: false,
      timeout: timeoutMs,
    });
    upstream.on("response", answer => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.on("data", chunk => {
        stats.bytesDown += chunk.length;
      });
      answer.pipe(response);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
    upstream.on("error", error => {
      stats.failed += 1;
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end("Прокси не смог достучаться до " + host + ": " + (error instanceof Error ? error.message : String(error)));
    });
    request.on("data", chunk => {
      stats.bytesUp += Buffer.byteLength(chunk);
    });
    request.pipe(upstream);
  }

  /** HTTPS и любой другой протокол: туннель CONNECT, содержимое не читается. */
  async function handleConnect(request: http.IncomingMessage, socket: net.Socket, head: Buffer) {
    stats.requests += 1;
    const source = clientAddress(socket);
    const target = parseConnectTarget(String(request.url ?? ""));
    if (!target) {
      stats.failed += 1;
      writeProxyResponse(socket, 400, "bad-host", "Прокси ждёт адрес вида домен:порт");
      return;
    }
    let address: string;
    try {
      address = await resolve(target.host);
    } catch {
      stats.failed += 1;
      await recordDeny(target.host, target.port, "unresolved", source);
      writeProxyResponse(socket, 502, "unresolved", "Не удалось разрешить имя: " + target.host);
      return;
    }
    const verdict = options.check(target.host, target.port, address);
    if (!verdict.allowed) {
      await recordDeny(target.host, target.port, verdict.reason, source);
      writeProxyResponse(socket, 403, verdict.reason, describeEgressDeny(verdict.reason, target.host));
      return;
    }
    stats.allowed += 1;
    options.onAllowed?.({ host: target.host, port: target.port, source });
    const upstream = net.connect({ host: address, port: target.port });
    upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error("timeout")));
    upstream.on("error", error => {
      stats.failed += 1;
      if (upstream.connecting) writeProxyResponse(socket, 502, "unreachable", "Прокси не смог достучаться до " + target.host + ": " + error.message);
      else socket.destroy();
    });
    upstream.on("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        stats.bytesUp += head.length;
        upstream.write(head);
      }
      socket.on("data", chunk => {
        stats.bytesUp += chunk.length;
      });
      upstream.on("data", chunk => {
        stats.bytesDown += chunk.length;
      });
      // Простаивающий туннель не держим вечно: он занимает и наш сокет, и сокет заказчика.
      socket.setTimeout(timeoutMs, () => socket.destroy());
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  }

  server.on("request", (request, response) => {
    void handleRequest(request, response);
  });
  server.on("connect", (request, socket, head) => {
    void handleConnect(request, socket as net.Socket, head);
  });

  return {
    server,
    stats,
    connections: () => sockets.size,
    close: () =>
      new Promise<void>(resolveClose => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close(() => resolveClose());
        // `close` не зовёт колбэк, пока жив хотя бы один сокет; после destroy их нет, но таймер
        // страхует от зависшего сокета, который не появился в Set (например, в момент остановки).
        setTimeout(resolveClose, 1_000).unref();
      }),
  };
}
