/**
 * «Чей это адрес» — привязка отказа egress-прокси к проекту (пункт 5.1 плана масштабирования).
 *
 * Прокси живёт отдельным процессом и видит только адрес источника. Карта живых предпросмотров
 * принадлежит процессу API (как и в 6.1), поэтому проект спрашивается по внутреннему маршруту.
 * Без привязки журнал отказов отвечал бы «кто-то с 172.31.0.7 ходил на пример.рф», а разбирать
 * такой случай пришлось бы вручную.
 *
 * Запрос к API не должен задерживать отказ и не должен повторяться на каждый файл: ответ кешируется
 * на минуту, включая отрицательный — у контейнеров команд адреса нет в карте предпросмотров, и
 * спрашивать про них API каждый раз бессмысленно.
 */

export type ProjectResolverDeps = {
  lookup: (address: string) => Promise<string | null>;
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
};

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 500;

export function createProjectResolver(deps: ProjectResolverDeps): (address: string) => Promise<string | null> {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = deps.now ?? (() => Date.now());
  const cache = new Map<string, { value: string | null; expires: number }>();

  return async address => {
    const key = (address ?? "").trim();
    if (!key) return null;
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return cached.value;
    let timer: NodeJS.Timeout | undefined;
    // Таймер не `unref`-ается намеренно: разрешение гонки — часть ответа функции, и если процесс
    // успевает опустеть раньше таймера, ожидающий остаётся без ответа (так тест падал с
    // «Promise resolution is still pending»). Таймер снимается сразу после гонки, так что
    // держать им цикл событий долго не приходится.
    const timeout = new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const value = await Promise.race([deps.lookup(key).catch(() => null), timeout]);
    if (timer) clearTimeout(timer);
    cache.set(key, { value, expires: now() + ttlMs });
    return value;
  };
}

/**
 * Один запрос к API: `POST /api/internal/egress/whois` с токеном. Токен выводится из ключа
 * шифрования (см. preview/door-token.ts), поэтому отдельного секрета в `.env` не появляется.
 */
export function whoisLookup(
  apiBase: string,
  token: string | null,
  fetchImpl: typeof fetch = fetch,
): (address: string) => Promise<string | null> {
  const base = apiBase.replace(/\/+$/, "");
  return async address => {
    if (!token) return null;
    const response = await fetchImpl(base + "/api/internal/egress/whois", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ address }),
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { projectId?: unknown };
    return typeof body.projectId === "string" && body.projectId ? body.projectId : null;
  };
}
