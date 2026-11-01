import { z } from "zod";
import { PLAN_CATALOG, type PlanId } from "../account/plans.js";
import { getPlatformEnv, savePlatformEnv } from "../platform/platform-env.js";

/**
 * Настройки витрины тарифов, которые владелец меняет без выкатки: название, описание, пункты,
 * базовая цена и скидка. Значения живут в том же шифрованном хранилище, что ключи платформы,
 * но отдельным ключом `PLAN_SETTINGS`: это не секрет, а конфигурация, и её не нужно
 * подмешивать в формы паролей.
 *
 * Цена в настройках — базовая, до скидки. Итоговую считает robokassa.ts: так витрина,
 * счёт и чек всегда говорят одну и ту же сумму, а перечёркнутая цена остаётся честной.
 */
export const PLAN_SETTINGS_ENV = "PLAN_SETTINGS";

export type PaidPlanId = Exclude<PlanId, "free">;
export type PlanSettingsValues = {
  name: string;
  description: string;
  /** Пункты карточки тарифа; пустой список означает «взять каталог». */
  features: string[];
  /** Базовая цена в рублях до скидки. */
  priceRub: number;
  /** Скидка в процентах: 0 — без скидки, 90 — максимальная. */
  discountPercent: number;
};
export type PlanOverrides = Partial<PlanSettingsValues>;

type StoredPlanSettings = {
  version: 1;
  plans: Partial<Record<PaidPlanId, PlanOverrides>>;
};

const planFieldSchema = z.object({
  name: z.string().trim().min(1, "Название не может быть пустым").max(48, "Название — до 48 символов"),
  description: z.string().trim().min(1, "Описание не может быть пустым").max(180, "Описание — до 180 символов"),
  features: z.array(z.string().trim().min(1, "Пункт не может быть пустым").max(80, "Пункт — до 80 символов"))
    .max(10, "Не больше 10 пунктов")
    .default([]),
  priceRub: z.coerce.number().int("Цена — целое число рублей").min(1, "Цена должна быть больше нуля").max(10_000_000, "Слишком большая цена"),
  discountPercent: z.coerce.number().int("Скидка — целое число процентов").min(0, "Скидка не может быть отрицательной").max(90, "Скидка — не больше 90%").default(0),
});

/** Полный набор значений, который приходит из админки: оба платных тарифа сразу. */
export const planSettingsSchema = z.object({
  pro: planFieldSchema,
  team: planFieldSchema,
});
export type PlanSettingsInput = z.infer<typeof planSettingsSchema>;

function emptySettings(): StoredPlanSettings {
  return { version: 1, plans: {} };
}

function optionalText(value: unknown, max: number) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, max) : undefined;
}

function optionalPrice(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 10_000_000 ? number : undefined;
}

function optionalDiscount(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 90 ? number : undefined;
}

/** Испорченный JSON не должен отдавать на витрину не-строки или сотни пунктов. */
function optionalFeatures(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === "string")
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 10)
    .map(item => item.slice(0, 80));
}

/** Старые цены каталога до текущей акции: их больше не показываем как ручную настройку. */
const LEGACY_DEFAULT_PRICES: Record<PaidPlanId, number> = { pro: 990, team: 2_990 };

/** Даже ручная правка JSON в хранилище не должна отдавать на витрину мусор. */
function normalizeEntry(value: unknown, plan: PaidPlanId): PlanOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const features = optionalFeatures(raw.features);
  const price = optionalPrice(raw.priceRub);
  const discount = optionalDiscount(raw.discountPercent);
  // Старая настройка 990/2 990 без скидки — это прежняя цена каталога, а не осознанный отказ
  // от акции. Убираем её, чтобы ниже подставились новые базовая цена и процент скидки.
  const legacyDefault = price === LEGACY_DEFAULT_PRICES[plan] && (discount === undefined || discount === 0);
  return {
    ...(optionalText(raw.name, 48) ? { name: optionalText(raw.name, 48) } : {}),
    ...(optionalText(raw.description, 180) ? { description: optionalText(raw.description, 180) } : {}),
    ...(features ? { features } : {}),
    ...(price && !legacyDefault ? { priceRub: price } : {}),
    ...(discount !== undefined && !legacyDefault ? { discountPercent: discount } : {}),
  };
}

let cachedRaw: string | null | undefined;
let cached: StoredPlanSettings = emptySettings();

/**
 * JSON читается один раз на изменение строки: цены и названия спрашивают витрина, счёт,
 * письма и админка, и разбирать файл на каждый запрос незачем.
 */
function readSettings(): StoredPlanSettings {
  const raw = (getPlatformEnv(PLAN_SETTINGS_ENV) ?? "").trim();
  if (raw === cachedRaw) return cached;
  cachedRaw = raw;
  if (!raw) {
    cached = emptySettings();
    return cached;
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; plans?: Record<string, unknown> };
    cached = {
      version: 1,
      plans: {
        pro: normalizeEntry(parsed.plans?.pro, "pro"),
        team: normalizeEntry(parsed.plans?.team, "team"),
      },
    };
  } catch {
    // Испорченное значение не должно ронять оплату: работает каталог по умолчанию.
    cached = emptySettings();
  }
  return cached;
}

export function planOverride(plan: PlanId): PlanOverrides {
  if (plan === "free") return {};
  return readSettings().plans[plan] ?? {};
}

export function planDisplayName(plan: PlanId): string {
  return planOverride(plan).name ?? PLAN_CATALOG[plan].name;
}

export function planDisplayDescription(plan: PlanId): string {
  return planOverride(plan).description ?? PLAN_CATALOG[plan].description;
}

/**
 * Пункты, которые сохранились в PLAN_SETTINGS до перехода на кредиты и новые лимиты проектов.
 * Старый текст продолжает перекрывать каталог на уже настроенных стендах, поэтому при чтении
 * заменяем известные устаревшие строки. Это именно миграция сохранённых значений, а не запрет
 * на редактирование: остальные пункты админки остаются как есть.
 */
const LEGACY_FEATURE_REPLACEMENTS: Record<PaidPlanId, Record<string, string>> = {
  pro: {
    "50 млн токенов агента в месяц": "5 000 кредитов на агента в месяц",
    "5 000 кредитов агента в месяц": "5 000 кредитов на агента в месяц",
    "15 проектов": "9 проектов",
  },
  team: {
    "250 млн токенов агента в месяц": "10 000 кредитов на агента в месяц",
    "25 000 кредитов агента в месяц": "10 000 кредитов на агента в месяц",
    "10 000 кредитов агента в месяц": "10 000 кредитов на агента в месяц",
    "50 проектов": "15 проектов",
  },
};

/**
 * Эти обещания больше не принадлежат тарифам: запуски на платных тарифах ограничены кредитами,
 * браузерная проверка — отдельный режим запуска, а поддержка не входит в карточку тарифа.
 * Фильтр нужен и для старых сохранённых пунктов, и для пунктов, добавленных вручную в админке.
 */
const RETIRED_FEATURE = /без дневного лимита|браузерн[\wа-яё]*\s+провер|поддержк|\d+\s+запусков агента в день/iu;

function modernFeature(plan: PaidPlanId, feature: string) {
  const normalized = feature.trim();
  if (RETIRED_FEATURE.test(normalized)) return "";
  return LEGACY_FEATURE_REPLACEMENTS[plan][normalized] ?? normalized;
}

/**
 * Пункты карточки: непустой override заменяет каталог; пустой или отсутствующий — каталог.
 * Для бесплатного тарифа каталог остаётся всегда: его условия не продаются и не редактируются.
 * Если после миграции не осталось ни одного пункта, показываем каталог, а не пустую карточку.
 */
export function planDisplayFeatures(plan: PlanId): string[] {
  if (plan === "free") return [...PLAN_CATALOG[plan].features];
  const override = planOverride(plan).features;
  if (!override?.length) return [...PLAN_CATALOG[plan].features];
  const modern = override
    .map(feature => modernFeature(plan, feature))
    .filter((feature): feature is string => Boolean(feature));
  // Две старые строки могли превратиться в одну; повтор не должен показываться дважды.
  const unique = modern.filter((feature, index) => modern.indexOf(feature) === index);
  return unique.length ? unique : [...PLAN_CATALOG[plan].features];
}

/**
 * Старый клиент админки не присылает `features`. Поле с default [] выглядит как «стереть
 * пункты», поэтому маршрут отдельно сообщает, какие стороны пришли без него, а сохранение
 * оставляет прежний override. Новый админ присылает features всегда — включая [] для возврата
 * к каталогу.
 */
export function planSettingsFeaturePresence(body: unknown): Record<PaidPlanId, boolean> {
  const source = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const has = (side: PaidPlanId) => {
    const value = source[side];
    return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
      Object.prototype.hasOwnProperty.call(value, "features");
  };
  return { pro: has("pro"), team: has("team") };
}

/**
 * Сохранение из админки. Значение проходит ту же проверку, что и форма, а `savePlatformEnv`
 * пишет его шифрованным и обновляет кэш процесса — следующим запросам уже видна новая цена.
 */
export async function savePlanSettings(
  input: PlanSettingsInput,
  options: { preserveFeatures?: Partial<Record<PaidPlanId, boolean>> } = {},
) {
  const parsed = planSettingsSchema.parse(input);
  const keepFeatures = (side: PaidPlanId, values: PlanSettingsValues) => {
    if (!options.preserveFeatures?.[side]) return values.features;
    const existing = planOverride(side).features;
    return existing ? [...existing] : values.features;
  };
  const payload: StoredPlanSettings = {
    version: 1,
    plans: {
      pro: { ...parsed.pro, features: keepFeatures("pro", parsed.pro) },
      team: { ...parsed.team, features: keepFeatures("team", parsed.team) },
    },
  };
  const result = await savePlatformEnv({ [PLAN_SETTINGS_ENV]: JSON.stringify(payload) });
  const skipped = result.skipped.find(item => item.name === PLAN_SETTINGS_ENV);
  if (skipped) throw new Error(skipped.message);
  return result;
}
