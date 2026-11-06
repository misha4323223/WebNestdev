import { previewDoorToken } from "./door-token.js";
import type { PreviewStatus } from "./types.js";

/**
 * Дверь отдельным процессом: как она узнаёт, что делать с запросом.
 *
 * Раньше дверь жила в процессе API и читала `preview-store` напрямую — карту живых
 * предпросмотров. Отдельный процесс эту карту не видит, поэтому состояние спрашивается у API по
 * внутреннему адресу (маршрут `routes/preview-door.ts`, закрыт общим токеном).
 *
 * Почему запрос, а не копия состояния: копия рассинхронизируется молча. Предпросмотр
 * перезапускается, порт меняется, проект удаляется — и дверь продолжает держать старый адрес,
 * пока кто-то не догадается перезапустить её. Запрос к API всегда отвечает по факту, а короткий
 * кеш убирает лишние вызовы на каскаде файлов приложения (один экран — это десятки запросов).
 */

export type PreviewLookup = { exists: boolean; status: PreviewStatus };

export type DoorClientOptions = {
  /** База внутреннего API; по умолчанию соседний процесс в том же контейнере. */
  base?: string;
  token?: string | null;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  cacheMs?: number;
};

const CACHE_LIMIT = 2_000;

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Адрес API состояния. В контейнере это loopback: дверь и API — соседи. */
export function previewDoorApiBase(raw = process.env.PREVIEW_DOOR_API_URL): string {
  const base = (raw ?? "").trim() || "http://127.0.0.1:8787";
  return base.replace(/\/+$/, "");
}

/** Сколько живёт ответ в кеше: каскад файлов приложения не должен стоить запроса на каждый файл. */
export function previewDoorCacheMs(raw = process.env.PREVIEW_DOOR_CACHE_MS): number {
  return positiveInt(raw, 1_000);
}

type CacheEntry = { at: number; value: PreviewLookup };

/**
 * Кеш положительных ответов на процесс. Отрицательные не кешируются: проект могли только что
 * открыть, и секунда «не найден» на первом заходе выглядела бы как поломка.
 */
const cache = new Map<string, CacheEntry>();

/** Только для тестов: между проверками состояние процесса не должно переезжать. */
export function resetPreviewLookupCache() {
  cache.clear();
}

async function requestLookup(projectId: string, options: DoorClientOptions): Promise<PreviewLookup> {
  const token = options.token ?? previewDoorToken();
  if (!token) {
    throw new Error("дверь не может прочитать состояние предпросмотра: WEBNESTDEV_ENCRYPTION_KEY не задан");
  }
  const doFetch = options.fetch ?? fetch;
  const response = await doFetch(previewDoorApiBase(options.base) + "/api/internal/preview/lookup", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ projectId }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 2_000),
  });
  if (!response.ok) {
    throw new Error("API состояния предпросмотра ответил " + response.status);
  }
  const body = (await response.json()) as { exists?: unknown; status?: unknown };
  const status = body.status;
  const running = typeof status === "object" && status !== null && (status as { running?: unknown }).running === true;
  return {
    exists: body.exists === true,
    // Форма ответа проверяется, а не принимается на веру: дверь проксирует байты приложения, и
    // «running: "yes"» из будущей версии не должно превратиться в адрес `undefined`.
    status: running ? (status as PreviewStatus) : { running: false },
  };
}

/** Состояние проекта и его предпросмотра; бросает, когда API недоступен (дверь ответит 503). */
export async function lookupPreview(projectId: string, options: DoorClientOptions = {}): Promise<PreviewLookup> {
  const now = (options.now ?? Date.now)();
  const cacheMs = options.cacheMs ?? previewDoorCacheMs();
  const cached = cache.get(projectId);
  if (cached && now - cached.at < cacheMs) return cached.value;
  const value = await requestLookup(projectId, options);
  if (value.exists) {
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(projectId, { at: now, value });
  } else {
    cache.delete(projectId);
  }
  return value;
}

export type PreviewDoorHealth = {
  live: boolean;
  connections?: number;
  upgrades?: number;
  uptimeSeconds?: number;
  limits?: { maxConnections?: number; maxUpgrades?: number; upgradeTimeoutMs?: number };
  reason?: string;
};

/**
 * Живое состояние двери для `/api/health`: подключена ли она и сколько соединений держит.
 *
 * Опроса не жалко: он идёт раз в минуту из health панели и ни на один пользовательский запрос не
 * влияет. Короткий таймаут — чтобы зависшая дверь не задерживала весь ответ health.
 */
export async function probePreviewDoor(
  options: { url?: string; timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<PreviewDoorHealth> {
  const url = (options.url ?? process.env.PREVIEW_DOOR_HEALTH_URL ?? "http://127.0.0.1:8789/__health").trim();
  try {
    const doFetch = options.fetch ?? fetch;
    const response = await doFetch(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 500) });
    if (!response.ok) return { live: false, reason: "health двери ответил " + response.status };
    // Форма ответа разбирается по частям, а не приводится к `PreviewDoorHealth`: в её `live`
    // лежит boolean, а в ответе health — счётчики. Один и тот же тип на два разных смысла
    // компилятор не поймал бы, зато поймал бы читатель.
    const body = (await response.json()) as {
      uptimeSeconds?: unknown;
      limits?: PreviewDoorHealth["limits"];
      live?: { connections?: unknown; upgrades?: unknown };
    };
    const live = body.live ?? {};
    return {
      live: true,
      ...(typeof live.connections === "number" ? { connections: live.connections } : {}),
      ...(typeof live.upgrades === "number" ? { upgrades: live.upgrades } : {}),
      ...(typeof body.uptimeSeconds === "number" ? { uptimeSeconds: body.uptimeSeconds } : {}),
      ...(body.limits ? { limits: body.limits } : {}),
    };
  } catch (error) {
    return { live: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Дождаться, пока API ответит на внутренний запрос.
 *
 * Дверь и API стартуют одновременно (супервизор контейнера), поэтому дверь почти всегда поднимается
 * раньше, чем API занял порт — а он ещё и читает схему базы на старте. Одна попытка даёт «fetch
 * failed» в логе выкатки при полностью рабочей системе: строка, которой перестают верить. Ждём с
 * паузой, а в лог пишется итог и номер попытки.
 *
 * Бесконечно ждать нельзя: если канала нет, честнее строка «недоступен» при каждом старте, чем
 * висящий процесс без объяснения.
 */
export async function waitForDoorApi(
  probe: () => Promise<unknown>,
  options: { attempts?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ ok: boolean; attempts: number; error?: string }> {
  const attempts = Math.max(1, options.attempts ?? positiveInt(process.env.PREVIEW_DOOR_API_ATTEMPTS, 30));
  const intervalMs = Math.max(0, options.intervalMs ?? positiveInt(process.env.PREVIEW_DOOR_API_INTERVAL_MS, 2_000));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await probe();
      return { ok: true, attempts: attempt };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < attempts) await sleep(intervalMs);
    }
  }
  return { ok: false, attempts, error: lastError };
}

export type PreviewDoorEvent = "unsettle" | "exec-only";

/**
 * Сообщить API о том, что увидела дверь: адрес контейнера не отвечает (`unsettle`) или запросы
 * пошли внутрь контейнера (`exec-only`). Доставка не обязана быть надёжной — это уточнение
 * состояния, и его потеря не ломает запрос, который уже отдан клиенту.
 */
export async function reportPreviewEvent(
  projectId: string,
  event: PreviewDoorEvent,
  value?: boolean,
  options: DoorClientOptions = {},
): Promise<void> {
  const token = options.token ?? previewDoorToken();
  if (!token) return;
  const doFetch = options.fetch ?? fetch;
  try {
    await doFetch(previewDoorApiBase(options.base) + "/api/internal/preview/event", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify(value === undefined ? { projectId, event } : { projectId, event, value }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 2_000),
    });
  } catch (error) {
    console.warn("[preview] дверь: событие " + event + " не доставлено — " + (error instanceof Error ? error.message : String(error)));
  }
}
