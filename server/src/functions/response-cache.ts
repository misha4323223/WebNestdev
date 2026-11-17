import type { FunctionResponse } from "./invoke.js";

/**
 * Ответный кеш двери функций.
 *
 * Функция попадает сюда только по явному `cache.ttlSeconds` в `nestdev.functions.json`.
 * По умолчанию кеша нет: заказы, корзина, вход и платёжные запросы не должны получить
 * чужой ответ. Авторизованные запросы и запросы с cookie обходят кеш даже при включённой
 * политике — исключение делается только на уровне явного контракта функции, а не двери.
 *
 * Кеш живёт в памяти процесса. На двух нодах у каждой свой экземпляр; это осознанно для
 * первого этапа, пока TTL короткий. Общая инвалидация между нодами будет отдельным этапом.
 */

export type FunctionResponseCacheOptions = {
  enabled: boolean;
  maxEntries: number;
  maxBytes: number;
};

type CacheEntry = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  expiresAt: number;
  bytes: number;
};

export type FunctionResponseCacheStats = {
  entries: number;
  bytes: number;
  inflight: number;
};

function positiveInt(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function functionResponseCacheOptions(env: NodeJS.ProcessEnv = process.env): FunctionResponseCacheOptions {
  const disabled = (env.FUNCTIONS_CACHE_ENABLED ?? "").trim().toLowerCase();
  return {
    enabled: disabled !== "0" && disabled !== "false" && disabled !== "off" && disabled !== "no",
    maxEntries: positiveInt(env.FUNCTIONS_CACHE_MAX_ENTRIES, 512, 1, 10_000),
    maxBytes: positiveInt(env.FUNCTIONS_CACHE_MAX_BYTES, 16 * 1024 * 1024, 1, 256 * 1024 * 1024),
  };
}

/**
 * Один ключ на сайт, релиз, функцию, метод, точный query и базовое согласование контента.
 * `Accept`/`Accept-Language` включены, чтобы публичная функция не отдала JSON вместо HTML
 * или русский ответ англоязычному запросу. Остальные заголовки кеш не различает: политика
 * `cache` — обещание функции, что ответ публичный и не зависит от пользователя.
 */
export function functionCacheKey(input: {
  siteId: string;
  releaseId: string;
  functionName: string;
  method: string;
  path: string;
  search: string;
  accept?: string;
  acceptLanguage?: string;
}) {
  return [
    input.siteId,
    input.releaseId,
    input.functionName,
    input.method,
    input.path,
    input.search,
    input.accept ?? "",
    input.acceptLanguage ?? "",
  ].join("\0");
}

/** Cookie и Authorization делают ответ потенциально персональным: такой запрос не кешируем. */
export function requestAllowsResponseCache(headers: { authorization?: string | string[]; cookie?: string | string[] }) {
  return !headers.authorization && !headers.cookie;
}

export class FunctionResponseCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<FunctionResponse>>();
  private bytes = 0;
  private readonly options: FunctionResponseCacheOptions;

  constructor(options: FunctionResponseCacheOptions = functionResponseCacheOptions()) {
    this.options = options;
  }

  get enabled() {
    return this.options.enabled;
  }

  lookup(key: string, now = Date.now()): FunctionResponse | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
      this.remove(key);
      return null;
    }
    // Map хранит порядок вставки: свежий вход переносим в конец, чтобы вытеснялся старый.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return {
      status: entry.status,
      headers: { ...entry.headers },
      body: entry.body,
    };
  }

  store(
    key: string,
    response: FunctionResponse,
    ttlSeconds: number,
    now = Date.now(),
  ): boolean {
    if (!this.options.enabled || ttlSeconds <= 0) return false;
    // Не кешируем ошибки, задания и персональные ответы. 2xx — только успешный публичный ответ.
    if (response.status < 200 || response.status >= 300) return false;
    if (response.jobs?.length) return false;
    if (Object.keys(response.headers).some(name => name.toLowerCase() === "set-cookie")) return false;
    const control = Object.entries(response.headers).find(([name]) => name.toLowerCase() === "cache-control")?.[1] ?? "";
    if (/no-store|private/i.test(control)) return false;
    if (Object.entries(response.headers).some(([name, value]) => name.toLowerCase() === "vary" && value.trim() === "*")) return false;
    const bytes = response.body.byteLength;
    if (bytes > this.options.maxBytes) return false;

    const previous = this.entries.get(key);
    if (previous) this.remove(key);
    this.entries.set(key, {
      status: response.status,
      headers: { ...response.headers },
      body: response.body,
      expiresAt: now + ttlSeconds * 1_000,
      bytes,
    });
    this.bytes += bytes;
    this.evict(now);
    return true;
  }

  /**
   * Один вызов на одинаковый ключ. Пока первый запрос выполняет контейнер, остальные ждут
   * его результат и не занимают второй слот. Ошибка не запоминается: следующий запрос снова
   * попробует выполнить функцию.
   */
  async load(key: string, loader: () => Promise<FunctionResponse>): Promise<FunctionResponse> {
    const running = this.inflight.get(key);
    if (running) return running;
    const promise = loader().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  clearSite(siteId: string) {
    const prefix = siteId + "\0";
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.remove(key);
    }
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }

  stats(): FunctionResponseCacheStats {
    return { entries: this.entries.size, bytes: this.bytes, inflight: this.inflight.size };
  }

  private remove(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes = Math.max(0, this.bytes - entry.bytes);
  }

  private evict(now: number) {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.remove(key);
    }
    while (this.entries.size > this.options.maxEntries || this.bytes > this.options.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }
}

export const functionResponseCache = new FunctionResponseCache();

/** Тестам нужен чистый экземпляр; production сбрасывает кеш только перезапуском. */
export function resetFunctionResponseCacheForTests() {
  functionResponseCache.clear();
}
