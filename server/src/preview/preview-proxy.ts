import { canRewritePreviewBody, previewProxyBase, rewritePreviewBody } from "./preview-rewrite.js";
import type { ExecFetchResult } from "./exec-proxy.js";
import type { PreviewStatus } from "./types.js";
import { applyNoStore } from "../routes/cache-headers.js";
import { PREVIEW_TICKET_COOKIE } from "./preview-ticket.js";
import { SESSION_COOKIE } from "../auth/auth.js";

/**
 * Одна дверь к живому приложению проекта. Их две, и обе живут здесь: путь в панели
 * (`/api/projects/<id>/preview/open/…`, где корневые ссылки приложения переписываются на префикс
 * прокси) и публичный адрес (`<проект>.preview.nestdev.ru`, где приложение стоит в корне и
 * переписывать нечего). Различие — один аргумент `rewriteBase`; всё остальное одинаково:
 * тот же бюджет ожидания, тот же порядок «прямой адрес, затем `docker exec`», тот же запрет
 * отдавать кадр из кэша.
 *
 * Отсюда же берётся поведение при отказе: причина называется словами и возвращается вызывающему
 * исключением, потому что и панель, и агент используют её как диагностику.
 */

/**
 * Сколько ждать ответа приложения на проксированный запрос.
 *
 * Без ограничения подвисший запрос приложения держит кадр панели белым до общего таймаута запроса
 * (две минуты), и пользователь видит «ничего» вместо причины: именно так выглядит белый экран
 * предпросмотра. Бюджет в 30 с — это медленный первый рендер dev-сервера, а не «никогда»;
 * `PREVIEW_PROXY_TIMEOUT_MS` меняет его в обе стороны.
 */
export function previewProxyTimeoutMs() {
  const raw = Number(process.env.PREVIEW_PROXY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 100 ? Math.floor(raw) : 30_000;
}

/**
 * Причина отказа словами. «Не ответил за N секунд» и «соединение отвергнуто» — разные диагнозы: в первом
 * случае приложение живо внутри контейнера, но недоступно снаружи (сеть/петля), во втором — на этом
 * порту никто не слушает (предпросмотр был поднят на другом порту или уже упал).
 */
export function describeProxyFailure(error: unknown, host: string, port: number, timeoutMs: number) {
  const name = error instanceof Error ? error.name : "";
  const detail = error instanceof Error ? error.message : String(error);
  if (name === "TimeoutError" || name === "AbortError") {
    const seconds = Math.max(1, Math.round(timeoutMs / 1000));
    return "адрес " + host + ":" + port + " не ответил за " + seconds + " с: приложение запущено внутри контейнера, но снаружи недоступно. Обновите статус предпросмотра (платформа подключит контейнер к сети сервера или пробросит порт) и посмотрите логи предпросмотра";
  }
  return detail;
}

/** Соучастники прокси: подставляются вызывающим, поэтому путь проверяется тестом без Docker. */
export type PreviewDoor = {
  previewStatus: (projectId: string) => Promise<PreviewStatus>;
  /** Вторая дверь к приложению — запрос изнутри его контейнера (`docker exec`). */
  execPreview: (input: { containerId: string; port: number; path: string; method: string; headers: Record<string, string>; body?: Buffer; timeoutMs: number }) => Promise<ExecFetchResult | null>;
  /** Снять подтверждение адреса: прямой путь только что не ответил. */
  unsettle: (projectId: string) => void;
  /** Переключить предпросмотр на путь через `docker exec` и обратно. */
  setExecOnly: (projectId: string, execOnly: boolean) => void;
};

export type PreviewProxyRequest = {
  projectId: string;
  /** Путь вместе со строкой запроса, например `/src/main.tsx?v=1`. */
  path: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: Buffer;
  /**
   * Префикс, на который переписываются корневые ссылки приложения. Для публичного адреса не
   * задаётся: приложение там в корне, и переписывание испортило бы его собственные ссылки.
   */
  rewriteBase?: string;
};

/**
 * Запрос приложения: прямым адресом, а если он не отвечает — изнутри контейнера. Отдаёт готовый
 * `Response` с запретом кэширования; причины отказа — исключениями.
 */
export async function proxyPreviewRequest(door: PreviewDoor, request: PreviewProxyRequest): Promise<Response> {
  const state = await door.previewStatus(request.projectId);
  if (!state.running) throw new Error("Предпросмотр не запущен");
  const host = state.host || process.env.PREVIEW_PROXY_HOST || "127.0.0.1";
  const timeoutMs = previewProxyTimeoutMs();
  const rewrite = (body: string, contentType: string) =>
    request.rewriteBase ? rewritePreviewBody(body, request.rewriteBase, contentType) : body;
  // Прямой путь первым: он отдаёт ответ потоком и работает с websocket живого HMR. Если адрес
  // контейнера уже помечен недоступным (execOnly), попытка не повторяется — иначе каждый файл
  // приложения платил бы за заведомо неудачное соединение.
  let directError: unknown = null;
  if (!state.viaExec) {
    try {
      const method = (request.method ?? "GET").toUpperCase();
      // Запрос приложению пересылается вместе с методом, телом и заголовками — иначе POST из
      // приложения доходил до него как GET без тела (панель показывала сломанный сценарий входа,
      // а приложение с собственной сессией не видело своей cookie). Тело у GET и HEAD запрещено
      // самим fetch, поэтому передаётся только для остальных методов.
      const upstream = await fetch("http://" + host + ":" + state.port + request.path, {
        method,
        headers: forwardedPreviewHeaders(request.headers),
        // `Uint8Array` вместо Buffer: тело запроса fetch принимает байтами, а Buffer — это тип Node.
        ...(request.body && method !== "GET" && method !== "HEAD" ? { body: Uint8Array.from(request.body) } : {}),
        redirect: "manual",
        // Ограниченный запрос: иначе неотвечающее приложение висит до таймаута самого сервера, а панель
        // всё это время показывает пустой белый кадр без причины (см. previewProxyTimeoutMs).
        signal: AbortSignal.timeout(timeoutMs),
      });
      const contentType = upstream.headers.get("content-type");
      const headers = sanitizedPreviewHeaders(upstream.headers);
      return !contentType || !canRewritePreviewBody(contentType)
        ? new Response(Buffer.from(await upstream.arrayBuffer()), { status: upstream.status, headers })
        : new Response(rewrite(await upstream.text(), contentType), { status: upstream.status, headers });
    } catch (error) {
      directError = error;
    }
  }
  // Вторая дверь: адрес контейнера серверу недоступен (Docker изолирует bridge-сети друг от друга),
  // но приложение живо и отвечает внутри своего контейнера — тем же путём, каким платформа
  // проверяет его готовность. Без этого живой предпросмотр оставался в панели белым кадром.
  const viaExec = await door.execPreview({
    containerId: state.containerId,
    port: state.port,
    path: request.path,
    method: request.method ?? "GET",
    headers: forwardedPreviewHeaders(request.headers),
    body: request.body,
    timeoutMs,
  }).catch(() => null);
  if (viaExec) {
    // Прямой адрес только что не ответил: подтверждение снимается, чтобы статус не показывал
    // «settled» у адреса, до которого панель больше не доходит (подтвердит заново проверка).
    door.unsettle(request.projectId);
    door.setExecOnly(request.projectId, true);
    const headers = sanitizedPreviewHeaders(new Headers(viaExec.headers));
    const contentType = viaExec.headers["content-type"] ?? null;
    return !contentType || !canRewritePreviewBody(contentType)
      // `Uint8Array.from` не только копирует: он даёт буфер, пригодный для тела ответа (Buffer из
      // другого модуля шире, чем ожидает Response).
      ? new Response(Uint8Array.from(viaExec.body), { status: viaExec.status, headers })
      : new Response(rewrite(viaExec.body.toString("utf8"), contentType), { status: viaExec.status, headers });
  }
  // Обе двери закрыты: подтверждение адреса снимается (прокси — первый, кто видит, что
  // подтверждённый адрес перестал работать), и следующая проверка статуса сводит адрес заново.
  door.unsettle(request.projectId);
  // Оба пути названы в одной строке: «fetch failed» без второй попытки не говорит, что делать,
  // а она уже сделана — приложение не ответило ни по адресу контейнера, ни внутри него.
  const reason = directError
    ? describeProxyFailure(directError, host, state.port, timeoutMs)
    : "адрес " + host + ":" + state.port + " недоступен";
  throw new Error("Прокси предпросмотра не сработал: " + reason + " — и внутри контейнера приложение тоже не ответило. Посмотрите логи предпросмотра (logs)");
}

/**
 * Служебные заголовки не пересылаются в обе стороны: соединение до приложения закрывается на
 * сервере, тело перекодируется, а кадровые запреты приложения убираются — их ставит сама платформа.
 */
export const HOP_BY_HOP_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "te", "trailer", "accept-encoding", "proxy-authorization", "proxy-connection"]);

export function sanitizedPreviewHeaders(source: Headers) {
  const headers = new Headers(source);
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
  headers.delete("x-frame-options");
  headers.delete("content-security-policy");
  // Живой предпросмотр — это всегда последняя версия проекта: страница, перезагруженная в панели,
  // обязана показать правки, а не копию из кэша браузера или посредника (`no-store` без валидаторов,
  // см. cache-headers.ts). Плата — повторная загрузка файлов на каждый показ кадра: она осознанная,
  // потому что цена ошибки — «в панели старая версия», а именно так это и выглядело.
  return applyNoStore(headers);
}

/**
 * Заголовки запроса клиента, пригодные для передачи приложению — и по прямому адресу, и внутрь
 * контейнера: служебные заголовки соединения снимаются, а cookie платформы не пересылается никогда.
 * Cookie сессии панели даёт доступ ко всему аккаунту, а код приложения пользователя — не то место,
 * где ему место; билет предпросмотра — доказательство права на доступ и приложению тоже не нужен.
 */
export function forwardedPreviewHeaders(source: Record<string, string | string[] | undefined> | undefined) {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(source ?? {})) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  const cookie = withoutPlatformCookies(headers.cookie);
  if (cookie) headers.cookie = cookie;
  else delete headers.cookie;
  return headers;
}

/** Заголовок `cookie` без cookie платформы; остальные cookie приложения остаются на месте. */
export function withoutPlatformCookies(cookie: string | undefined): string {
  if (!cookie) return "";
  return cookie
    .split(";")
    .map(value => value.trim())
    .filter(value => {
      const name = value.split("=")[0]?.trim();
      return Boolean(name) && name !== SESSION_COOKIE && name !== PREVIEW_TICKET_COOKIE;
    })
    .join("; ");
}

/**
 * Тело запроса для второй двери. Fastify уже разобрал то, что знает (JSON и текст), поэтому
 * разобранное значение возвращается обратно в байты: страница приложения получает тот же запрос,
 * что и по прямому пути.
 */
export function previewRequestBody(request: { method?: string; body?: unknown }) {
  const method = (request.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return undefined;
  const body = request.body;
  if (body === undefined || body === null) return undefined;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body);
  return Buffer.from(JSON.stringify(body));
}

/** Префикс прокси для пути в панели — он же адрес, на который переписываются ссылки приложения. */
export { previewProxyBase };
