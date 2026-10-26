/**
 * Цены моделей — единственное место, где токены превращаются в деньги.
 *
 * У платформы одновременно работают разные модели: бесплатная модель тарифа «Старт» (её запуски
 * пишутся как `free-model`) и платная модель платформы, у которой цена за миллион токенов своя.
 * Одна общая ставка (`PLATFORM_AI_PRICE_*`) для такой смеси даёт неверную сумму: бесплатные
 * запуски выглядели бы платными, а дорогая модель — как дешёвая.
 *
 * Поэтому цена задаётся таблицей `PLATFORM_AI_MODEL_PRICES` — JSON вида
 * `{"qwen3-235b-a22b-fp8":{"input":500,"output":500}}`. Ключ ищется как точное имя модели или как
 * часть имени: в журнале модель платформы записана целиком (`gpt://<folder>/qwen3-235b-a22b-fp8/latest`),
 * и привязывать цену к каталогу, а не к полному URI, удобнее.
 *
 * Если таблицы нет, работает прежняя общая ставка `PLATFORM_AI_PRICE_INPUT_PER_MILLION` /
 * `PLATFORM_AI_PRICE_OUTPUT_PER_MILLION`. Это сохраняет уже настроенные установки и не требует
 * выкатки только ради статистики. Бесплатная модель при этом всегда стоит ноль, пока для неё
 * явно не задана цена: её запуски платформа не оплачивает.
 *
 * Валюта одна на таблицу: `PLATFORM_AI_PRICE_CURRENCY` (по умолчанию USD, как и раньше).
 * Выручка платформы приходит в рублях через Робокассу, поэтому для сравнения расходов и дохода
 * ставки нужно задавать в рублях; админка честно скажет, если валюты не совпали, вместо того
 * чтобы сложить доллары с рублями.
 */

export type ModelPrice = { input: number; output: number };

export type ModelPriceSource = "model-prices" | "single-price" | "free-model";

export type ModelPriceRule = ModelPrice & {
  /** Ключ таблицы в нижнем регистре: точное имя модели или его часть. */
  match: string;
  source: ModelPriceSource;
};

export type ModelPriceTable = {
  currency: string;
  /** Явные правила, от самого длинного ключа к короткому. */
  rules: ModelPriceRule[];
  /** Общая ставка для моделей без отдельного правила (прежние `PLATFORM_AI_PRICE_*`). */
  catchAll: ModelPriceRule | null;
  /** Имена, которые считаются бесплатными, пока для них нет явной цены. */
  freeMatches: string[];
  source: "model-prices" | "single-price" | "none";
  /** Есть ли хоть одна цена, заданная человеком (бесплатная модель сама по себе — не в счёт). */
  configured: boolean;
  /** Сколько записей таблицы не разобрано: админка покажет это предупреждением. */
  invalidRules: number;
};

export const MODEL_PRICES_ENV = "PLATFORM_AI_MODEL_PRICES";
export const MODEL_PRICE_CURRENCY_ENV = "PLATFORM_AI_PRICE_CURRENCY";
export const INFRA_COST_ENV = "PLATFORM_INFRA_COST_PER_MONTH";

const DEFAULT_CURRENCY = "USD";
const FREE_MODEL_LABEL = "free-model";

function finitePrice(value: unknown): ModelPrice | null {
  // Число — одна ставка на вход и выход: короткая запись для моделей, где они совпадают.
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? { input: value, output: value } : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const input = Number(record.input);
  const output = Number(record.output);
  if (!Number.isFinite(input) || input < 0) return null;
  if (!Number.isFinite(output) || output < 0) return null;
  return { input, output };
}

/**
 * Разбор `PLATFORM_AI_MODEL_PRICES`. Ошибка в одной записи не отменяет остальные: иначе одна
 * опечатка в JSON обнуляла бы всю статистику, и причину пришлось бы искать по логам.
 */
export function parseModelPrices(raw: string | undefined): {
  rules: ModelPriceRule[];
  catchAll: ModelPriceRule | null;
  invalid: number;
} {
  const text = raw?.trim();
  if (!text) return { rules: [], catchAll: null, invalid: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { rules: [], catchAll: null, invalid: 1 };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { rules: [], catchAll: null, invalid: 1 };
  }

  const rules: ModelPriceRule[] = [];
  let catchAll: ModelPriceRule | null = null;
  let invalid = 0;
  for (const [rawKey, rawValue] of Object.entries(parsed as Record<string, unknown>)) {
    const match = rawKey.trim().toLowerCase();
    const price = finitePrice(rawValue);
    if (!match || !price) {
      invalid += 1;
      continue;
    }
    const rule: ModelPriceRule = { match, ...price, source: "model-prices" };
    if (match === "*") {
      catchAll = rule;
      continue;
    }
    rules.push(rule);
  }
  // Длинный ключ проверяется первым: `gpt-oss-120b` должен победить `gpt-oss`, а не зависеть
  // от порядка ключей в JSON.
  rules.sort((left, right) => right.match.length - left.match.length);
  return { rules, catchAll, invalid };
}

/** Общая ставка из прежних переменных. `null`, если не задана ни одна из двух. */
export function legacyModelPrice(env: NodeJS.ProcessEnv = process.env): ModelPriceRule | null {
  const input = Number(env.PLATFORM_AI_PRICE_INPUT_PER_MILLION ?? "");
  const output = Number(env.PLATFORM_AI_PRICE_OUTPUT_PER_MILLION ?? "");
  const hasInput = Number.isFinite(input) && input > 0;
  const hasOutput = Number.isFinite(output) && output > 0;
  if (!hasInput && !hasOutput) return null;
  return {
    match: "*",
    input: hasInput ? input : 0,
    output: hasOutput ? output : 0,
    source: "single-price",
  };
}

/**
 * Текущая таблица цен. Читается на каждый запрос, а не один раз при импорте: значения панели и
 * окружения могут измениться без перезапуска, и статистика должна считать по новым ставкам.
 */
export function readModelPriceTable(env: NodeJS.ProcessEnv = process.env): ModelPriceTable {
  const parsed = parseModelPrices(env[MODEL_PRICES_ENV]);
  const legacy = legacyModelPrice(env);
  const catchAll = parsed.catchAll ?? legacy;

  const freeMatches = [...new Set([
    FREE_MODEL_LABEL,
    (env.PLATFORM_AI_FREE_MODEL ?? "").trim().toLowerCase(),
  ].filter(Boolean))];

  const source = parsed.rules.length > 0 || parsed.catchAll
    ? "model-prices" as const
    : legacy
      ? "single-price" as const
      : "none" as const;

  return {
    currency: (env[MODEL_PRICE_CURRENCY_ENV] ?? "").trim().toUpperCase() || DEFAULT_CURRENCY,
    rules: parsed.rules,
    catchAll,
    freeMatches,
    source,
    configured: parsed.rules.length > 0 || catchAll !== null,
    invalidRules: parsed.invalid,
  };
}

/**
 * Цена одной модели. Сначала явное правило (точное имя, затем самая длинная подстрока), потом
 * бесплатная модель, потом общая ставка. `null` — цены нет, и такие токены нельзя складывать
 * с деньгами: админка покажет их отдельным списком.
 */
export function modelPriceFor(
  model: string,
  table: ModelPriceTable,
): { price: ModelPrice; rule: ModelPriceRule } | null {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return null;

  const exact = table.rules.find(rule => rule.match === normalized);
  if (exact) return { price: { input: exact.input, output: exact.output }, rule: exact };

  const partial = table.rules.find(rule => normalized.includes(rule.match));
  if (partial) return { price: { input: partial.input, output: partial.output }, rule: partial };

  // Только точное имя: `free` внутри названия платной модели не делает её бесплатной —
  // иначе одна общая подстрока тихо обнулила бы расход целой модели.
  if (isFreeModel(normalized, table)) {
    const rule: ModelPriceRule = { match: normalized, input: 0, output: 0, source: "free-model" };
    return { price: { input: 0, output: 0 }, rule };
  }

  if (table.catchAll) {
    return {
      price: { input: table.catchAll.input, output: table.catchAll.output },
      rule: table.catchAll,
    };
  }
  return null;
}

/** Имя бесплатной модели: точное совпадение, без подстрок. */
export function isFreeModel(model: string, table: ModelPriceTable): boolean {
  return table.freeMatches.includes(model.trim().toLowerCase());
}

/** Стоимость токенов по цене за миллион. Токены приходят из журнала, поэтому только неотрицательные. */
export function costForTokens(promptTokens: number, completionTokens: number, price: ModelPrice): number {
  const prompt = Number.isFinite(promptTokens) ? Math.max(0, promptTokens) : 0;
  const completion = Number.isFinite(completionTokens) ? Math.max(0, completionTokens) : 0;
  return (prompt / 1_000_000) * price.input + (completion / 1_000_000) * price.output;
}

export type InfraCost = { monthly: number; configured: boolean };

/**
 * Постоянные расходы платформы в месяц: ВМ, диск, бакет, SMS, домен. Токены — не единственная
 * статья, и без этой суммы «цена подписки по себестоимости» занижена. Значение задаётся одним
 * числом вручную: точный счёт зависит от тарифа хостинга, и выдумывать его из метрик нельзя.
 */
export function readInfraCostMonthly(env: NodeJS.ProcessEnv = process.env): InfraCost {
  const raw = Number(String(env[INFRA_COST_ENV] ?? "").replace(",", "."));
  const monthly = Number.isFinite(raw) && raw > 0 ? raw : 0;
  return { monthly, configured: monthly > 0 };
}
