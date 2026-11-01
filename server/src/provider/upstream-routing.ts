/**
 * Как выбирать upstream-провайдера внутри OpenAI-совместимого шлюза (Polza.ai, OpenRouter и
 * совместимые). Это не провайдер платформы и не ключ: настройка говорит, каких провайдеров
 * *модели* можно использовать и в каком порядке.
 *
 * Зачем это нужно. У одной модели в Polza.ai десятки провайдеров с разной ценой: у
 * `deepseek/deepseek-v4.1-flash-1017` их 43, а разница между самым дешёвым и официальным
 * DeepSeek — больше чем в 10 раз. Без `provider` в запросе шлюз выбирает сам, и это не всегда
 * дешёвый вариант. Режим `fixed` закрепляет конкретного провайдера, `cheapest` строит порядок
 * по каталогу, `auto` оставляет выбор шлюзу.
 *
 * `allowFallback` — это наш собственный fallback: каждый запрос уходит с `only: [provider]` и
 * `allow_fallbacks: false`, поэтому шлюз не подменит выбранного провайдера дорогим. Если
 * провайдер выключен или ответил отказом до первого байта, сервер сам идёт к следующему из
 * списка. `fallbackToAuto` — последняя ступень: если весь список недоступен, разрешить шлюзу
 * выбрать любого провайдера (по умолчанию выключено, чтобы не платить в 10 раз больше молча).
 */
export type UpstreamRoutingMode = "auto" | "fixed" | "cheapest";

export type UpstreamMaxPrice = {
  /** RUB за 1M входных токенов. */
  prompt?: number;
  /** RUB за 1M выходных токенов. */
  completion?: number;
};

export type UpstreamRouting = {
  mode: UpstreamRoutingMode;
  /**
   * Для `fixed` — точный порядок попыток. Для `cheapest` — белый список: если пусто,
   * рассматриваются все провайдеры модели; если задан, порядок всё равно считается по цене.
   */
  providers: string[];
  /** Переходить к следующему провайдеру из списка при отказе. */
  allowFallback: boolean;
  /** Если весь список недоступен — разрешить шлюзу выбрать самому. */
  fallbackToAuto: boolean;
  /** Профиль нагрузки для оценки «самого дешёвого»: сколько входных токенов на один выходной. */
  assumedInputPerOutput: number;
  /** Потолок цены; провайдеры дороже не выбираются. */
  maxPrice?: UpstreamMaxPrice;
};

export function defaultUpstreamRouting(): UpstreamRouting {
  return {
    mode: "auto",
    providers: [],
    allowFallback: true,
    fallbackToAuto: false,
    assumedInputPerOutput: 10,
  };
}

function finite(value: unknown, min: number, max: number): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number >= min && number <= max ? number : undefined;
}

/**
 * Приводит значение из хранилища или API к полному объекту. `null` — значение не похоже на
 * routing (не объект или неизвестный режим), и вызывающий код должен решить, что делать:
 * для сохранённой настройки это повод откатиться к `auto`, для запроса админки — 400.
 */
export function normalizeUpstreamRouting(value: unknown): UpstreamRouting | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.mode !== undefined && raw.mode !== "auto" && raw.mode !== "fixed" && raw.mode !== "cheapest") return null;

  if (raw.providers !== undefined && !Array.isArray(raw.providers)) return null;
  const providers: string[] = [];
  for (const item of Array.isArray(raw.providers) ? raw.providers : []) {
    if (typeof item !== "string") return null;
    const name = item.trim();
    if (!name || name.length > 200) return null;
    if (!providers.includes(name)) providers.push(name);
    if (providers.length > 20) return null;
  }

  let maxPrice: UpstreamMaxPrice | undefined;
  if (raw.maxPrice !== undefined && raw.maxPrice !== null) {
    if (typeof raw.maxPrice !== "object" || Array.isArray(raw.maxPrice)) return null;
    const price = raw.maxPrice as Record<string, unknown>;
    const prompt = price.prompt === undefined ? undefined : finite(price.prompt, 0, 1_000_000);
    const completion = price.completion === undefined ? undefined : finite(price.completion, 0, 1_000_000);
    if (price.prompt !== undefined && prompt === undefined) return null;
    if (price.completion !== undefined && completion === undefined) return null;
    if (prompt !== undefined || completion !== undefined) {
      maxPrice = {
        ...(prompt !== undefined ? { prompt } : {}),
        ...(completion !== undefined ? { completion } : {}),
      };
    }
  }

  return {
    mode: raw.mode === "fixed" || raw.mode === "cheapest" ? raw.mode : "auto",
    providers,
    allowFallback: raw.allowFallback !== false,
    fallbackToAuto: raw.fallbackToAuto === true,
    assumedInputPerOutput: finite(raw.assumedInputPerOutput, 1, 100) ?? 10,
    ...(maxPrice ? { maxPrice } : {}),
  };
}

/** Проверка после `normalize`: то, что нельзя молча исправить, возвращается человеку. */
export function upstreamRoutingProblem(routing: UpstreamRouting): string | null {
  if (routing.mode === "fixed" && routing.providers.length === 0) {
    return "Режим fixed требует хотя бы одного провайдера в списке";
  }
  if (routing.mode === "fixed" && !routing.allowFallback && routing.providers.length > 1) {
    return "При allowFallback: false в списке fixed должен остаться один провайдер";
  }
  return null;
}

/** JSON из `PLATFORM_AI_ROUTING`; битое значение не должно ронять сервер. */
export function parseUpstreamRouting(raw: string | undefined | null): UpstreamRouting | null {
  const text = raw?.trim();
  if (!text) return null;
  try {
    return normalizeUpstreamRouting(JSON.parse(text));
  } catch {
    return null;
  }
}

export function stringifyUpstreamRouting(routing: UpstreamRouting): string {
  return JSON.stringify(routing);
}

/** Есть ли что передавать в запрос: в `auto` поле `provider` не отправляется. */
export function isUpstreamRouted(routing: UpstreamRouting | undefined | null): boolean {
  return Boolean(routing && routing.mode !== "auto");
}
