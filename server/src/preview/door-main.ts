import { createServer, type Server } from "node:http";
import type { FastifyRequest } from "fastify";
import { sessionCookieSecure } from "../auth/auth.js";
import { dockerForNode } from "./docker-exec.js";
import { lookupPreview, reportPreviewEvent, waitForDoorApi } from "./door-client.js";
import { previewDoorToken } from "./door-token.js";
import { execFetchPreview } from "./exec-proxy.js";
import { previewHostTarget, previewPublicDomain } from "./preview-host.js";
import {
  createPreviewHostServer,
  previewHostBind,
  previewHostLimits,
  previewHostPort,
  type PreviewHostDeps,
} from "./preview-host-server.js";
import { previewTicketProject } from "./preview-ticket.js";

/**
 * Дверь публичных адресов отдельным процессом (пункт 6.1 плана масштабирования).
 *
 * Зачем. Публичный адрес предпросмотра держит соединение до приложения на каждую открытую вкладку
 * и каждый HMR-сокет. Пока дверь живёт в процессе API, эти соединения — память и файловые
 * дескрипторы того же процесса, который обслуживает панель: шестьдесят открытых предпросмотров
 * упираются в общий потолок (256 соединений, 64 WebSocket) и добавляют RSS API.
 *
 * Что делает этот файл. Он поднимает тот же слушатель (`createPreviewHostServer`), но в своём
 * процессе и со своими лимитами, а состояние предпросмотра спрашивает у API по внутреннему
 * каналу (`routes/preview-door.ts`): карта живых предпросмотров принадлежит процессу API и в
 * другом процессе её нет.
 *
 * Почему отдельный процесс, а не отдельный контейнер. Второй контейнер в compose — это вторая
 * точка, которую выкатка обязана уметь откатывать: Caddy смотрел бы на новый адрес, а предыдущий
 * образ двери не содержит вовсе, и автоматический откат после неудачной проверки здоровья оставил
 * бы предпросмотры без апстрима. Здесь апстрим не меняется (`webnestdev-server:8788`), а старый
 * образ просто не запускает этот процесс — поведение прежнее. Настоящая изоляция ресурсов
 * появится вместе с отдельным узлом (этап 3 плана), куда дверь переедет как есть.
 *
 * Лимиты — на процесс, а не на API: `PREVIEW_HOST_MAX_CONNECTIONS` (256) и
 * `PREVIEW_HOST_MAX_UPGRADES` (64) считаются здесь, и их значения видны в `/api/health` через
 * собственный health-слушатель ниже.
 */

/** Health двери: внутренний порт, наружу его не публикует ни Caddy, ни compose. */
const DEFAULT_HEALTH_PORT = 8789;

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function previewDoorHealthPort(raw = process.env.PREVIEW_DOOR_HEALTH_PORT): number {
  return positiveInt(raw, DEFAULT_HEALTH_PORT);
}

/**
 * Соучастники двери в отдельном процессе. Отличия от `defaultDeps` ровно в одном: всё, что
 * раньше читалось из памяти API (`getProject`, `previewStatus`, отметки о деградации), теперь
 * спрашивается у API. Проксирование и `docker exec` остаются локальными — байты приложения не
 * должны идти через API, иначе смысл разделения теряется.
 */
export function previewDoorDeps(): PreviewHostDeps {
  return {
    target: previewHostTarget,
    async getProject(projectId) {
      const lookup = await lookupPreview(projectId);
      return lookup.exists ? { id: projectId, userId: "" } : null;
    },
    async previewStatus(projectId) {
      return (await lookupPreview(projectId)).status;
    },
    execPreview: input => execFetchPreview(input, { docker: dockerForNode(input.node) }),
    unsettle: projectId => {
      void reportPreviewEvent(projectId, "unsettle");
    },
    setExecOnly: (projectId, execOnly) => {
      void reportPreviewEvent(projectId, "exec-only", execOnly);
    },
    ticketProject: previewTicketProject,
    secureCookie: request => sessionCookieSecure(request as unknown as FastifyRequest),
  };
}

function listen(server: Server, port: number, bind: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

/**
 * Health двери — маленький отдельный слушатель, а не маршрут публичной двери: та отдаёт чужое
 * приложение по имени хоста и не должна отвечать на служебные пути из интернета.
 */
export function createPreviewDoorHealthServer(input: {
  domain: string;
  port: number;
  limits: ReturnType<typeof previewHostLimits>;
  stats: () => { connections: number; upgrades: number };
  startedAt?: number;
}): Server {
  const startedAt = input.startedAt ?? Date.now();
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://door.local");
    if (url.pathname !== "/__health" && url.pathname !== "/healthz") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    const live = input.stats();
    const body = Buffer.from(
      JSON.stringify({
        ok: true,
        service: "preview-door",
        pid: process.pid,
        domain: input.domain,
        port: input.port,
        limits: input.limits,
        live,
        uptimeSeconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
      }),
      "utf8",
    );
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": body.length });
    response.end(body);
  });
}

async function main() {
  const domain = previewPublicDomain();
  if (!domain) {
    // Ничего не сломано: публичных адресов на этой ВМ просто нет, и панель работает своим путём.
    // Код 0, а не 1: супервизор не должен перезапускать процесс, которому нечего делать.
    console.log("[door] PREVIEW_PUBLIC_DOMAIN не задан — публичные адреса выключены, дверь не поднимается");
    return 0;
  }
  if (!previewDoorToken()) {
    console.log("[door] WEBNESTDEV_ENCRYPTION_KEY не задан — дверь не может проверить билет и спросить состояние у API");
    return 0;
  }

  const limits = previewHostLimits();
  const port = previewHostPort();
  const bind = previewHostBind();
  const door = createPreviewHostServer(previewDoorDeps(), limits);
  try {
    await listen(door.server, port, bind);
  } catch (error) {
    console.error("[door] не удалось занять порт " + port + ": " + (error instanceof Error ? error.message : String(error)));
    return 1;
  }
  const healthPort = previewDoorHealthPort();
  const health = createPreviewDoorHealthServer({ domain, port, limits, stats: door.stats });
  try {
    await listen(health, healthPort, bind);
  } catch (error) {
    console.error("[door] health-слушатель не поднялся на " + healthPort + ": " + (error instanceof Error ? error.message : String(error)));
    await door.close();
    return 1;
  }

  console.log("[door] публичные адреса проектов: " + bind + ":" + port + " (" + domain + "), health на " + healthPort);
  // Проверка внутреннего канала сразу при старте: без него дверь жива, но на каждый запрос
  // отвечает «предпросмотр не запущен», потому что состояние живёт в процессе API. Строка в логе
  // выкатки — единственное место, где это видно без терминала на ВМ. Ждём: API стартует рядом.
  const probeId = "00000000-0000-0000-0000-000000000000";
  const channel = await waitForDoorApi(() => lookupPreview(probeId));
  if (channel.ok) {
    console.log("[door] канал состояния работает: API ответил с попытки " + channel.attempts);
  } else {
    console.error(
      "[door] канал состояния недоступен после " + channel.attempts + " попыток — предпросмотры не откроются: " + (channel.error ?? "причина неизвестна"),
    );
  }
  console.log(
    "[door] лимиты: соединений " + limits.maxConnections + ", WebSocket " + limits.maxUpgrades +
      ", таймаут апгрейда " + limits.upgradeTimeoutMs + " мс",
  );

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log("[door] остановка по " + signal);
    void Promise.all([door.close(), new Promise<void>(resolve => health.close(() => resolve()))]).then(() => process.exit(0));
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  // Процесс живёт, пока его не остановят: незакрытое обещание — самый дешёвый способ не дать
  // Node выйти, не держа при этом ни таймеров, ни сокетов сверх нужных.
  await new Promise<void>(() => {});
  return 0;
}

const code = await main();
if (code !== 0) process.exit(code);
