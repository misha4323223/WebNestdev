import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { getProject } from "../project-store.js";
import { previewStatus } from "../preview-manager.js";
import { execFetchPreview, type ExecFetchResult } from "./exec-proxy.js";
import { previewHostTarget, previewPublicDomain, previewPublicUrl } from "./preview-host.js";
import { proxyPreviewRequest, withoutPlatformCookies, type PreviewDoor } from "./preview-proxy.js";
import { PREVIEW_SESSION_PATH, PREVIEW_TICKET_COOKIE, PREVIEW_TICKET_PARAM, previewTicketProject, previewTicketTtlMs } from "./preview-ticket.js";
import { PICK_BRIDGE_PATH, canInjectPickBridge, injectPickBridge, pickBridgeResponse } from "./pick-bridge.js";
import { setPreviewExecOnly, unsettlePreview } from "./preview-store.js";
import { sessionCookieSecure } from "../auth/auth.js";
import type { PreviewStatus } from "./types.js";
import type { FastifyRequest } from "fastify";

/**
 * Публичный адрес предпросмотра отдаётся отдельным слушателем внутри процесса сервера.
 *
 * Почему отдельный, а не маршрут в основном приложении: основной сервер обслуживает панель, API и
 * WebSocket агента, и его маршруты принадлежат платформе. Приложение пользователя занимает на своём
 * поддомене ВЕСЬ путь — включая `/api/…`, который ему нужен для собственных запросов, — а живая
 * перезагрузка приходит по WebSocket с произвольного пути. Подстановочный WebSocket-маршрут в
 * Fastify занял бы тот же `/*`, что и раздача панели, и сломал бы её. Поэтому дверь предпросмотра —
 * маленький независимый слушатель: HTTP-запросы к нему идут через общее ядро прокси
 * (preview/preview-proxy.ts), а обновление соединения до WebSocket передаётся приложению как есть,
 * байт в байт, без разбора протокола.
 *
 * Слушатель поднимается только тогда, когда задан `PREVIEW_PUBLIC_DOMAIN`, и не публикуется на
 * хост: до него доходит реверс-прокси (Caddy) по внутренней сети. Порт — `PREVIEW_HOST_PORT`.
 */

const DEFAULT_PORT = 8788;
/** Сколько тела запроса принимает эта дверь: столько же, сколько разбирает основной сервер. */
const MAX_BODY_BYTES = 2_000_000;
/** Тело обмена билета — это один JSON с билетом: всё, что больше, читать незачем. */
const MAX_SESSION_BODY_BYTES = 8_192;

/**
 * Потолки двери. Публичный адрес смотрит в интернет, а держать соединение до приложения — это
 * память и файловые дескрипторы сервера: без потолка сотня открытых вкладок с HMR выедает их
 * у всех проектов сразу. Значения — на весь слушатель, а не на проект: цель — не дать одному
 * клиенту занять сервер, а не считать честную квоту.
 */
export type PreviewHostLimits = {
  maxConnections: number;
  maxUpgrades: number;
  upgradeTimeoutMs: number;
};

function positiveInt(raw: string | undefined, fallback: number) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function previewHostLimits(): PreviewHostLimits {
  return {
    maxConnections: positiveInt(process.env.PREVIEW_HOST_MAX_CONNECTIONS, 256),
    maxUpgrades: positiveInt(process.env.PREVIEW_HOST_MAX_UPGRADES, 64),
    upgradeTimeoutMs: positiveInt(process.env.PREVIEW_HOST_UPGRADE_TIMEOUT_MS, 10_000),
  };
}

export function previewHostPort(): number {
  const raw = Number(process.env.PREVIEW_HOST_PORT);
  return Number.isFinite(raw) && raw > 0 && raw < 65_536 ? Math.floor(raw) : DEFAULT_PORT;
}

/** Адрес, к которому подключается реверс-прокси: по умолчанию все интерфейсы контейнера. */
export function previewHostBind(): string {
  return (process.env.PREVIEW_HOST_BIND ?? "0.0.0.0").trim() || "0.0.0.0";
}

/** Что дверь умеет: всё внешнее берётся отсюда, поэтому дверь проверяется тестом без Docker. */
export type PreviewHostDeps = {
  target: (host: string | undefined) => { projectId: string } | null;
  getProject: (projectId: string) => Promise<{ id: string; userId: string } | null>;
  previewStatus: (projectId: string) => Promise<PreviewStatus>;
  execPreview: (input: { containerId: string; port: number; path: string; method: string; headers: Record<string, string>; body?: Buffer; timeoutMs: number }) => Promise<ExecFetchResult | null>;
  unsettle: (projectId: string) => void;
  setExecOnly: (projectId: string, execOnly: boolean) => void;
  ticketProject: (ticket: string | undefined | null, now?: number) => string;
  /** Флаг Secure у cookie доступа — по схеме самого запроса (за прокси её сообщает `x-forwarded-proto`). */
  secureCookie: (request: IncomingMessage) => boolean;
};

const defaultDeps: PreviewHostDeps = {
  target: previewHostTarget,
  getProject,
  previewStatus,
  execPreview: execFetchPreview,
  unsettle: unsettlePreview,
  setExecOnly: setPreviewExecOnly,
  ticketProject: previewTicketProject,
  secureCookie: request => sessionCookieSecure(request as unknown as FastifyRequest),
};

type Access = { ok: true } | { ok: false; status: number; message: string };

export const PREVIEW_ACCESS_MESSAGE =
  "Доступ к предпросмотру закрыт: откройте его из панели проекта — ссылка действует ограниченное время.";

/** Cookie запроса как карта: у двери предпросмотра нет разборщика cookie основного сервера. */
export function requestCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    const value = part.slice(index + 1).trim();
    // `decodeURIComponent` бросает на битой последовательности (`%zz`): заголовок приходит от
    // клиента, а дверь не должна падать от одного запроса с мусором в cookie.
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

/**
 * Доступ к предпросмотру проекта: только cookie, которую поставил обмен билета (см. обмен в
 * handleRequest). Билет в строке запроса не принимается: строка запроса попадает в журналы и в
 * `Referer`, а билет — это ключ ко всему предпросмотру. Cookie сессии панели здесь не принимается
 * и в приложение не передаётся — она выставляется для домена панели, а расширять её до всего
 * домена нельзя: прокси отдаёт приложению заголовки запроса, то есть cookie платформы попал бы в
 * код пользователя.
 */
export function previewAccess(input: {
  cookies: Record<string, string>;
  projectId: string;
  ticketProject: (ticket: string | undefined | null, now?: number) => string;
  now?: number;
}): Access {
  const fromCookie = input.cookies[PREVIEW_TICKET_COOKIE];
  if (fromCookie && input.ticketProject(fromCookie, input.now) === input.projectId) return { ok: true };
  return { ok: false, status: 401, message: PREVIEW_ACCESS_MESSAGE };
}

/**
 * Заголовки запроса для приложения: без cookie платформы, остальное — как есть. Правило про cookie
 * живёт в одном месте (preview-proxy.ts): и путь в панели, и публичный адрес не должны отдавать код
 * пользователя доступ к сессии платформы.
 */
export function forwardableHeaders(headers: IncomingMessage["headers"]): Record<string, string | string[] | undefined> {
  const copy: Record<string, string | string[] | undefined> = { ...headers };
  if (copy.cookie === undefined) return copy;
  const kept = withoutPlatformCookies(String(copy.cookie));
  if (kept) copy.cookie = kept;
  else delete copy.cookie;
  return copy;
}

function htmlMessage(status: number, message: string) {
  const title = status === 401 ? "Предпросмотр закрыт" : status === 404 ? "Проект не найден" : "Предпросмотр недоступен";
  return "<!doctype html><html lang=\"ru\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>" + title + "</title></head>" +
    "<body style=\"margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f14;color:#e8eef6;font:16px/1.5 system-ui,sans-serif\">" +
    "<main style=\"max-width:34rem;padding:2rem;text-align:center\"><h1 style=\"margin:0 0 .75rem;font-size:1.25rem\">" + title + "</h1><p style=\"margin:0;color:#9fb0c3\">" + escapeHtml(message) + "</p></main></body></html>";
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] as string);
}

function wantsJson(request: IncomingMessage) {
  return String(request.headers.accept ?? "").includes("application/json");
}

function sendMessage(request: IncomingMessage, response: ServerResponse, status: number, message: string) {
  if (wantsJson(request)) {
    const body = Buffer.from(JSON.stringify({ error: message }));
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": String(body.length) });
    response.end(body);
    return;
  }
  const body = Buffer.from(htmlMessage(status, message));
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-length": String(body.length) });
  response.end(body);
}

/**
 * Страница-дверь: единственное, что отдаётся по адресу предпросмотра без cookie.
 *
 * Билет приходит во фрагменте (`#ticket=…`), а фрагмент серверу не виден — поэтому его читает этот
 * скрипт и сам же меняет на HttpOnly-cookie запросом на тот же origin. Так билет не оказывается в
 * строке запроса, а значит и в журналах, истории и `Referer`, но продолжает открывать предпросмотр
 * в кадре и в новой вкладке.
 *
 * Скрипт и стили — с нонсом на каждый ответ: у страницы нет других ресурсов, а инлайн-скрипты в
 * ней не должны выполниться, даже если в адрес попадёт что-то похожее на разметку.
 */
function gatePage(nonce: string) {
  return "<!doctype html><html lang=\"ru\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<meta name=\"robots\" content=\"noindex,nofollow\"><title>Предпросмотр</title>" +
    "<style nonce=\"" + nonce + "\">html,body{margin:0;height:100%}body{display:grid;place-items:center;background:#0b0f14;color:#e8eef6;font:16px/1.5 system-ui,sans-serif}" +
    "main{max-width:32rem;padding:1.5rem;text-align:center}h1{margin:0 0 .75rem;font-size:1.15rem;font-weight:600}p{margin:0;color:#9fb0c3}</style></head>" +
    "<body><main><h1>Предпросмотр</h1><p id=\"note\">Проверяем ссылку…</p></main>" +
    "<script nonce=\"" + nonce + "\">(function(){" +
    "var note=document.getElementById('note');" +
    "var denied='Ссылка не подошла: она истекла или выпущена для другого проекта. Откройте предпросмотр из панели проекта.';" +
    "var ticket='';" +
    "try{ticket=new URLSearchParams(location.hash.slice(1)).get('" + PREVIEW_TICKET_PARAM + "')||''}catch(e){}" +
    "if(!ticket){note.textContent='Доступ к предпросмотру закрыт: откройте его из панели проекта — ссылка действует ограниченное время.';return}" +
    "fetch('" + PREVIEW_SESSION_PATH + "',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({ticket:ticket})})" +
    ".then(function(response){if(response.status!==204)throw new Error('denied');location.replace(location.pathname+location.search)})" +
    ".catch(function(){note.textContent=denied});" +
    "})();</script></body></html>";
}

function sendGate(response: ServerResponse) {
  const nonce = randomBytes(16).toString("base64");
  const body = Buffer.from(gatePage(nonce));
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'nonce-" + nonce + "'; script-src 'nonce-" + nonce + "'; connect-src 'self'; base-uri 'none'; form-action 'none'",
    "content-length": String(body.length),
  });
  response.end(body);
}

/**
 * Это переход по ссылке (кадр или новая вкладка), а не запрос ресурса? Так решается, что отдать
 * без cookie: страницу-дверь или обычный отказ. `Sec-Fetch-Dest` присылают все актуальные браузеры,
 * поэтому `Accept` используется только как запасной признак.
 */
function isDocumentNavigation(request: IncomingMessage) {
  if (request.method !== "GET") return false;
  const destination = String(request.headers["sec-fetch-dest"] ?? "");
  if (destination) return destination === "document" || destination === "iframe" || destination === "frame";
  const accept = String(request.headers.accept ?? "");
  return !accept.includes("application/json") && (accept.includes("text/html") || accept === "");
}

/** Cookie доступа: HttpOnly, чтобы её не прочитал код приложения, и SameSite=Lax — одна и та же площадка. */
function accessCookie(request: IncomingMessage, ticket: string, secure: boolean) {
  return [
    PREVIEW_TICKET_COOKIE + "=" + encodeURIComponent(ticket),
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=" + Math.floor(previewTicketTtlMs() / 1000),
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

async function readBody(request: IncomingMessage, limit = MAX_BODY_BYTES) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    if (size > limit) return null;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

/**
 * Обмен билета на cookie доступа.
 *
 * Принимается только с самой страницы-двери: браузер помечает такой запрос как `Sec-Fetch-Site:
 * same-origin`, а тело обязано быть JSON. Форма с чужого сайта не может поставить этот заголовок
 * и этот тип содержимого без предварительного CORS-запроса, на который дверь не отвечает, поэтому
 * поставить cookie от чужого имени через эту точку нельзя.
 */
async function exchangeTicket(deps: PreviewHostDeps, request: IncomingMessage, response: ServerResponse, projectId: string) {
  const site = String(request.headers["sec-fetch-site"] ?? "");
  if (site && site !== "same-origin") {
    sendMessage(request, response, 403, "Билет принимается только со страницы самого предпросмотра.");
    return;
  }
  if (!String(request.headers["content-type"] ?? "").includes("application/json")) {
    sendMessage(request, response, 415, "Билет принимается только как JSON.");
    return;
  }
  const body = await readBody(request, MAX_SESSION_BODY_BYTES);
  if (body === null) {
    sendMessage(request, response, 413, "Запрос больше предела, который принимает предпросмотр.");
    return;
  }
  let ticket = "";
  try {
    const parsed = JSON.parse(body.toString("utf8")) as { ticket?: unknown };
    if (typeof parsed?.ticket === "string") ticket = parsed.ticket;
  } catch {
    ticket = "";
  }
  // Билет другого проекта не обменивается: проверка та же, что и при чтении cookie.
  if (!ticket || deps.ticketProject(ticket) !== projectId) {
    sendMessage(request, response, 401, PREVIEW_ACCESS_MESSAGE);
    return;
  }
  response.writeHead(204, { "set-cookie": accessCookie(request, ticket, deps.secureCookie(request)), "cache-control": "no-store" });
  response.end();
}

/** Ответ прокси-ядра как ответ этого слушателя: статус, заголовки (включая несколько Set-Cookie), тело. */
async function writeProxyResponse(response: ServerResponse, upstream: Response) {
  const headers: Record<string, string | string[]> = {};
  upstream.headers.forEach((value, name) => {
    if (name.toLowerCase() === "set-cookie") return;
    headers[name] = value;
  });
  // `Headers.forEach` склеивает несколько Set-Cookie в одну строку, а браузер разберёт её как одну
  // cookie с куском другой внутри: массив значений сохраняет обе.
  const cookies = upstream.headers.getSetCookie?.() ?? [];
  if (cookies.length) headers["set-cookie"] = cookies;
  let body = Buffer.from(await upstream.arrayBuffer());
  // Мост выбора элемента: доступ к документу приложения у панели есть только здесь, потому что
  // страница живёт на своём домене. Скрипт ничего не делает без команды панели (см. pick-bridge.ts).
  if (canInjectPickBridge(upstream.headers.get("content-type"), upstream.headers.get("content-encoding"))) {
    const html = body.toString("utf8");
    const injected = injectPickBridge(html);
    if (injected !== html) {
      body = Buffer.from(injected, "utf8");
      // Длина изменилась: старый `content-length` обрезал бы документ на клиенте.
      delete headers["content-length"];
    }
  }
  response.writeHead(upstream.status, headers);
  response.end(body);
}

export type PreviewHostServer = {
  server: Server;
  close: () => Promise<void>;
};

/**
 * Слушатель публичных адресов. Создаётся отдельно от запуска, чтобы тест мог поднять его на
 * свободном порту с подставленными соучастниками.
 */
export function createPreviewHostServer(deps: PreviewHostDeps = defaultDeps, limits: PreviewHostLimits = previewHostLimits()): PreviewHostServer {
  const door: PreviewDoor = {
    previewStatus: deps.previewStatus,
    execPreview: deps.execPreview,
    unsettle: deps.unsettle,
    setExecOnly: deps.setExecOnly,
  };

  let upgrades = 0;
  const server = createServer((request, response) => {
    // Обработчик асинхронный, а обещание никто не ждёт: любое исключение внутри стало бы
    // unhandled rejection, то есть упавшим сервером от одного запроса. Поэтому всё, что не
    // отдало ответ само, отвечает здесь — «предпросмотр не ответил» вместо «сервер упал».
    void handleRequest(request, response).catch(error => {
      console.error("[preview] публичный адрес: запрос не обработан — " + describeError(error));
      if (!response.headersSent) sendMessage(request, response, 503, "Предпросмотр не ответил: " + describeError(error));
      else response.end();
    });
  });
  // Соединения без запроса и медленные заголовки — самый дешёвый способ занять сокеты.
  server.maxConnections = limits.maxConnections;
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 5_000;

  async function handleRequest(request: IncomingMessage, response: ServerResponse) {
    const target = deps.target(request.headers.host);
    if (!target) {
      sendMessage(request, response, 404, "Этот адрес не обслуживает предпросмотр проекта.");
      return;
    }
    const url = new URL(request.url ?? "/", "http://preview.local");
    // Обмен билета стоит до проверки доступа: билет и есть то, чего у браузера ещё нет.
    if (url.pathname === PREVIEW_SESSION_PATH) {
      if (request.method !== "POST") {
        sendMessage(request, response, 405, "Здесь принимается только POST с билетом.");
        return;
      }
      if (!(await deps.getProject(target.projectId))) {
        sendMessage(request, response, 404, "Проект не найден — возможно, он удалён.");
        return;
      }
      await exchangeTicket(deps, request, response, target.projectId);
      return;
    }
    const access = previewAccess({ cookies: requestCookies(request.headers.cookie), projectId: target.projectId, ticketProject: deps.ticketProject });
    if (!access.ok) {
      // Переход по ссылке — в кадре или в новой вкладке — получает страницу-дверь: она возьмёт билет
      // из фрагмента и обменяет его на cookie. Запрос ресурса по-прежнему получает отказ.
      if (isDocumentNavigation(request)) sendGate(response);
      else sendMessage(request, response, access.status, access.message);
      return;
    }
    if (!(await deps.getProject(target.projectId))) {
      sendMessage(request, response, 404, "Проект не найден — возможно, он удалён.");
      return;
    }
    // Скрипт моста выбора элемента отдаёт сам слушатель, а не приложение: это ресурс платформы,
    // и он нужен даже приложению, которое не отдаёт статику вообще.
    if (url.pathname === PICK_BRIDGE_PATH) {
      const script = pickBridgeResponse();
      response.writeHead(200, script.headers);
      response.end(script.body);
      return;
    }
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readBody(request);
    if (body === null) {
      sendMessage(request, response, 413, "Запрос больше предела, который принимает предпросмотр.");
      return;
    }
    try {
      const upstream = await proxyPreviewRequest(door, {
        projectId: target.projectId,
        // Публичный адрес — корень приложения, поэтому тело отдаётся как есть: переписывать нечего,
        // а переписывание сломало бы ссылки, которые приложение строит само.
        path: request.url || "/",
        method: request.method,
        headers: forwardableHeaders(request.headers),
        body,
      });
      await writeProxyResponse(response, upstream);
    } catch (error) {
      sendMessage(request, response, 503, (error instanceof Error ? error.message : String(error)) + " Запустите предпросмотр в панели проекта.");
    }
  }

  // Обновление соединения до WebSocket передаётся приложению байт в байт. Разбирать протокол здесь
  // не нужно и вредно: живая перезагрузка dev-сервера (а также socket.io и любой другой клиент)
  // договаривается с приложением сама, платформе достаточно открыть до него соединение.
  server.on("upgrade", (request, socket, head) => {
    void handleUpgrade(request, socket as Socket, head).catch(error => {
      console.error("[preview] публичный адрес: соединение не передано приложению — " + describeError(error));
      refuseUpgrade(socket as Socket, 502, "Предпросмотр не принял соединение: " + describeError(error));
    });
  });

  async function handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer) {
    if (upgrades >= limits.maxUpgrades) {
      refuseUpgrade(socket, 503, "Слишком много открытых соединений предпросмотра: закройте лишние вкладки.");
      return;
    }
    const target = deps.target(request.headers.host);
    if (!target) {
      refuseUpgrade(socket, 404, "Not Found");
      return;
    }
    const url = new URL(request.url ?? "/", "http://preview.local");
    const access = previewAccess({ cookies: requestCookies(request.headers.cookie), projectId: target.projectId, ticketProject: deps.ticketProject });
    if (!access.ok) {
      refuseUpgrade(socket, access.status, access.message);
      return;
    }
    // Доступ даёт cookie, а не адрес, поэтому путь уходит приложению как есть: его собственные
    // query-параметры — его дело, платформа их больше не трогает.
    const upstreamPath = url.pathname + url.search;
    const state = await deps.previewStatus(target.projectId).catch(() => ({ running: false }) as PreviewStatus);
    if (!state.running) {
      refuseUpgrade(socket, 503, "Предпросмотр не запущен: запустите его в панели проекта.");
      return;
    }
    // Через `docker exec` соединение не продолжить: это отдельный процесс на каждый запрос, а не
    // поток. Честнее отказать, чем оставить клиента ждать.
    if (state.viaExec || !state.host) {
      refuseUpgrade(socket, 503, "Адрес приложения недоступен серверу (Docker изолирует сети): живая перезагрузка недоступна, страница работает без неё.");
      return;
    }
    upgrades++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      upgrades--;
    };
    const upstream = connect(state.port, state.host);
    // Приложение может не ответить вовсе (зависший dev-сервер): без таймаута сокет и счётчик
    // оставались бы занятыми навсегда.
    upstream.setTimeout(limits.upgradeTimeoutMs, () => upstream.destroy(new Error("таймаут соединения с приложением")));
    const fail = () => {
      release();
      refuseUpgrade(socket, 502, "Приложение не приняло соединение.");
    };
    upstream.once("error", fail);
    upstream.once("connect", () => {
      upstream.setTimeout(0);
      upstream.removeListener("error", fail);
      upstream.write(upgradeRequestLine(request, upstreamPath, hostWithPort(state.host, state.port)));
      if (head?.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    const close = () => {
      release();
      upstream.destroy();
    };
    socket.once("close", close);
    socket.once("error", close);
    upstream.once("close", () => socket.destroy());
  }

  return {
    server,
    // Сначала `close()` — перестать принимать новые соединения, и только потом разорвать уже
    // открытые: при обратном порядке порт ещё мгновение принимает запросы и отвечает разрывом
    // вместо отказа, а остановленный предпросмотр выглядит «сломанным», а не остановленным.
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
      }),
  };
}

/**
 * Исходный запрос апгрейда, собранный обратно из разобранных заголовков. Заголовки проходят тот же
 * фильтр, что и у обычных запросов: cookie платформы (сессия панели и билет) в приложение не уходит.
 *
 * `Host` заменяется адресом самого приложения, а не остаётся публичным именем предпросмотра.
 * Vite 8 проверяет его для HMR-соединения (`server.allowedHosts`) и на чужое имя отвечает 400,
 * хотя обычная страница уже открыта: HTTP-путь и так ходит по адресу контейнера, а WebSocket
 * раньше передавал публичный Host и ломал живую перезагрузку. Приложение, которому нужен именно
 * публичный адрес, получает его в `Origin`; подменять Host обратно нельзя, иначе проверка снова
 * увидит чужое имя.
 */
function upgradeRequestLine(request: IncomingMessage, path = request.url ?? "/", upstreamHost = "") {
  const headers = forwardableHeaders(request.headers);
  delete headers.host;
  const lines = [request.method + " " + path + " HTTP/1.1"];
  if (upstreamHost) lines.push("host: " + upstreamHost);
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) lines.push(name + ": " + item);
    else lines.push(name + ": " + value);
  }
  return lines.join("\r\n") + "\r\n\r\n";
}

/** `Host` upstream: IPv6-адрес в заголовке обязан быть в квадратных скобках. */
function hostWithPort(host: string, port: number) {
  const formatted = host.includes(":") && !host.startsWith("[") ? "[" + host + "]" : host;
  return formatted + ":" + port;
}

/** Отказ на этапе апгрейда: короткий HTTP-ответ, после которого соединение закрывается. */
function refuseUpgrade(socket: Socket, status: number, message: string) {
  if (socket.destroyed) return;
  const body = Buffer.from(message, "utf8");
  socket.write(
    "HTTP/1.1 " + status + " " + statusText(status) + "\r\n" +
    "content-type: text/plain; charset=utf-8\r\n" +
    "content-length: " + body.length + "\r\n" +
    "cache-control: no-store\r\n" +
    "connection: close\r\n\r\n",
  );
  socket.end(body);
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function statusText(status: number) {
  if (status === 401) return "Unauthorized";
  if (status === 404) return "Not Found";
  if (status === 502) return "Bad Gateway";
  return "Service Unavailable";
}

let running: PreviewHostServer | null = null;

/** Поднимает дверь, если публичные адреса настроены; иначе тихо ничего не делает. */
export async function startPreviewHostServer(): Promise<{ started: boolean; port?: number; reason?: string }> {
  if (!previewPublicDomain()) return { started: false, reason: "PREVIEW_PUBLIC_DOMAIN не задан" };
  if (running) return { started: true, port: previewHostPort() };
  const created = createPreviewHostServer();
  const port = previewHostPort();
  await new Promise<void>((resolve, reject) => {
    created.server.once("error", reject);
    created.server.listen(port, previewHostBind(), () => {
      created.server.removeListener("error", reject);
      resolve();
    });
  });
  running = created;
  return { started: true, port };
}

export async function stopPreviewHostServer() {
  const current = running;
  running = null;
  if (current) await current.close();
}

/** Строка в лог при старте: по какому адресу реверс-прокси отдаёт предпросмотры. */
export function describePreviewHostServer() {
  const domain = previewPublicDomain();
  if (!domain) return "дверь публичных предпросмотров не поднимается: PREVIEW_PUBLIC_DOMAIN не задан";
  return "дверь публичных предпросмотров: " + previewHostBind() + ":" + previewHostPort() + " (проект." + domain + "), пример адреса — " + previewPublicUrl("00000000-0000-0000-0000-000000000000");
}

