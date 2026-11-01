import { z } from "zod";
import { getPlatformEnv, savePlatformEnv } from "../platform/platform-env.js";

/**
 * Настройки докупки кредитов.
 *
 * Кредиты продаются не фиксированными пакетами, а любым количеством от минимума: цена считается
 * от ставки за 1000 кредитов. Ставка и границы живут в шифрованном хранилище платформы и
 * меняются через API админки без выкатки. Старые `packId` остаются только для совместимости:
 * их цена тоже считается по текущей ставке, иначе старый клиент мог бы обойти новую цену.
 */
export const CREDIT_SETTINGS_ENV = "CREDIT_SETTINGS";
export const CREDIT_CURRENCY = "RUB";
export const CREDIT_SETTINGS_VERSION = 1;
export const MIN_CREDIT_AMOUNT = 1_000;
export const MAX_CREDIT_AMOUNT = 1_000_000;
export const MAX_CREDIT_PRICE_PER_1000 = 1_000_000;

export type CreditSettings = {
  version: typeof CREDIT_SETTINGS_VERSION;
  pricePer1000Rub: number;
  minCredits: number;
  maxCredits: number;
};

export type PublicCreditTopUp = {
  pricePer1000Rub: number;
  pricePer1000Label: string;
  minCredits: number;
  maxCredits: number;
  minAmountRub: number;
  maxAmountRub: number;
  currency: typeof CREDIT_CURRENCY;
};

export type CreditTopUpExample = {
  credits: number;
  amountRub: number;
  priceLabel: string;
};

/** Цена одного кредита не хранится: она всегда выводится из ставки за 1000. */
export const DEFAULT_CREDIT_SETTINGS: CreditSettings = {
  version: CREDIT_SETTINGS_VERSION,
  pricePer1000Rub: 290,
  minCredits: MIN_CREDIT_AMOUNT,
  maxCredits: 100_000,
};

function integerInRange(value: unknown, min: number, max: number): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

/** Испорченное значение не должно ломать оплату: каждая граница отдельно возвращается к норме. */
function normalizeSettings(raw: unknown): CreditSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_CREDIT_SETTINGS };
  const value = raw as Record<string, unknown>;
  const minCredits = integerInRange(value.minCredits, MIN_CREDIT_AMOUNT, MAX_CREDIT_AMOUNT)
    ?? DEFAULT_CREDIT_SETTINGS.minCredits;
  // Если сохранённый максимум ниже минимума, верхняя граница поднимается до минимума:
  // «от 10 000 до 5 000» — не настройка, а противоречие.
  const maxCredits = Math.max(
    minCredits,
    integerInRange(value.maxCredits, MIN_CREDIT_AMOUNT, MAX_CREDIT_AMOUNT)
      ?? DEFAULT_CREDIT_SETTINGS.maxCredits,
  );
  return {
    version: CREDIT_SETTINGS_VERSION,
    pricePer1000Rub: integerInRange(value.pricePer1000Rub, 1, MAX_CREDIT_PRICE_PER_1000)
      ?? DEFAULT_CREDIT_SETTINGS.pricePer1000Rub,
    minCredits,
    maxCredits,
  };
}

let cachedRaw: string | null | undefined;
let cached: CreditSettings = { ...DEFAULT_CREDIT_SETTINGS };

function readSettings(): CreditSettings {
  const raw = (getPlatformEnv(CREDIT_SETTINGS_ENV) ?? "").trim();
  if (raw === cachedRaw) return cached;
  cachedRaw = raw;
  if (!raw) {
    cached = { ...DEFAULT_CREDIT_SETTINGS };
    return cached;
  }
  try {
    cached = normalizeSettings(JSON.parse(raw));
  } catch {
    // Опечатка в JSON не должна превращать оплату в 500: работают значения по умолчанию.
    cached = { ...DEFAULT_CREDIT_SETTINGS };
  }
  return cached;
}

export function creditSettings(): CreditSettings {
  return { ...readSettings() };
}

/** Целое число рублей: копейки не выставляются, поэтому сумма всегда округляется вверх. */
export function creditPriceRub(credits: number, settings: CreditSettings = readSettings()): number {
  const amount = Math.max(1, Math.trunc(credits));
  return Math.max(1, Math.ceil(amount * settings.pricePer1000Rub / 1_000));
}

function rubLabel(amount: number) {
  return amount.toLocaleString("ru-RU") + " ₽";
}

export function publicCreditTopUp(settings: CreditSettings = readSettings()): PublicCreditTopUp {
  return {
    pricePer1000Rub: settings.pricePer1000Rub,
    pricePer1000Label: rubLabel(settings.pricePer1000Rub),
    minCredits: settings.minCredits,
    maxCredits: settings.maxCredits,
    minAmountRub: creditPriceRub(settings.minCredits, settings),
    maxAmountRub: creditPriceRub(settings.maxCredits, settings),
    currency: CREDIT_CURRENCY,
  };
}

/** Примеры для админки: по ним сразу видно, во что превращается ставка. */
export function creditTopUpExamples(settings: CreditSettings = readSettings()): CreditTopUpExample[] {
  const wanted = [settings.minCredits, 5_000, 15_000, 50_000];
  return [...new Set(wanted)]
    .filter(credits => credits >= settings.minCredits && credits <= settings.maxCredits)
    .map(credits => {
      const amountRub = creditPriceRub(credits, settings);
      return { credits, amountRub, priceLabel: rubLabel(amountRub) };
    });
}

export const creditSettingsPatchSchema = z.object({
  pricePer1000Rub: z.coerce.number().int("Цена — целое число рублей")
    .min(1, "Цена должна быть больше нуля")
    .max(MAX_CREDIT_PRICE_PER_1000, "Слишком большая цена")
    .optional(),
  minCredits: z.coerce.number().int("Минимум — целое число кредитов")
    .min(MIN_CREDIT_AMOUNT, "Минимальная докупка — 1 000 кредитов")
    .max(MAX_CREDIT_AMOUNT, "Слишком большой минимум")
    .optional(),
  maxCredits: z.coerce.number().int("Максимум — целое число кредитов")
    .min(MIN_CREDIT_AMOUNT, "Максимум не может быть меньше 1 000 кредитов")
    .max(MAX_CREDIT_AMOUNT, "Слишком большой максимум")
    .optional(),
}).strict().refine(value => Object.keys(value).length > 0, "Передайте хотя бы одно поле");

export type CreditSettingsPatch = z.infer<typeof creditSettingsPatchSchema>;

/**
 * Сохранение полного набора после слияния с текущим. `savePlatformEnv` обновляет кэш процесса,
 * поэтому новые счета сразу считаются по новой ставке, а уже выставленные счета не меняются.
 */
export async function saveCreditSettings(settings: CreditSettings): Promise<void> {
  if (settings.minCredits > settings.maxCredits) {
    throw new Error("Минимум не может быть больше максимума");
  }
  const normalized = normalizeSettings(settings);
  const result = await savePlatformEnv({
    [CREDIT_SETTINGS_ENV]: JSON.stringify(normalized),
  });
  const skipped = result.skipped.find(item => item.name === CREDIT_SETTINGS_ENV);
  if (skipped) throw new Error(skipped.message);
}
