import { getPlatformEnv } from "../platform/platform-env.js";

/**
 * Кредиты — единица стоимости работы модели, а не ещё один счётчик токенов.
 *
 * У каждой модели своя цена входа и выхода, поэтому один и тот же объём токенов у Max и Mini
 * стоит по-разному. Кредит нормализует эту разницу: пользователь видит один бюджет, а списание
 * зависит от тарифа конкретной модели. Один кредит на основной модели — это примерно 10 000
 * токенов при обычной смеси 90 % входа и 10 % выхода.
 */
export type CreditRates = {
  /** Сколько кредитов стоит 1 млн входных токенов. */
  inputPerMillion: number;
  /** Сколько кредитов стоит 1 млн выходных токенов; reasoning тоже считается выходом. */
  outputPerMillion: number;
  /** Минимум за один запуск, чтобы короткая задача не стоила ноль. */
  minimumPerRun: number;
};

/** Базовая модель: 5 000 кредитов ≈ 50 млн токенов при смеси 90/10. */
export const BASE_CREDIT_RATES: CreditRates = {
  inputPerMillion: 50,
  outputPerMillion: 510,
  minimumPerRun: 1,
};

/**
 * Стартовые ставки дополнительных моделей. Администратор может изменить их через API:
 * это ориентир, а не жёстко зашитая цена провайдера.
 */
export const DEFAULT_MODEL_CREDIT_RATES: Record<string, CreditRates> = {
  max: { inputPerMillion: 250, outputPerMillion: 2_550, minimumPerRun: 2 },
  mini: { inputPerMillion: 25, outputPerMillion: 255, minimumPerRun: 1 },
};

const MAX_RATE = 1_000_000;
const MAX_MINIMUM = 10_000;

function finiteRate(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_RATE) return fallback;
  // Четыре знака достаточно для пересчёта из цены провайдера; больше — шум в JSON.
  return Math.round(parsed * 10_000) / 10_000;
}

/** Ставки по id: max/mini получают свои значения, остальные — базовые. */
export function defaultCreditRatesFor(id: string): CreditRates {
  return { ...(DEFAULT_MODEL_CREDIT_RATES[id] ?? BASE_CREDIT_RATES) };
}

/**
 * Слияние частичного обновления с уже сохранёнными ставками. Пустое поле не обнуляет ставку:
 * PATCH может прислать только `minimumPerRun`, не переписывая цены токенов.
 */
export function normalizeCreditRates(input: Partial<CreditRates> | null | undefined, fallback: CreditRates): CreditRates {
  const source = input ?? {};
  const minimum = typeof source.minimumPerRun === "number" ? Math.round(source.minimumPerRun) : fallback.minimumPerRun;
  return {
    inputPerMillion: finiteRate(source.inputPerMillion, fallback.inputPerMillion),
    outputPerMillion: finiteRate(source.outputPerMillion, fallback.outputPerMillion),
    minimumPerRun: Number.isFinite(minimum) ? Math.max(0, Math.min(MAX_MINIMUM, minimum)) : fallback.minimumPerRun,
  };
}

/** Проверка перед записью: нулевые ставки не должны появляться у платной модели случайно. */
export function creditRatesProblem(rates: CreditRates): string | null {
  if (!Number.isFinite(rates.inputPerMillion) || rates.inputPerMillion < 0 || rates.inputPerMillion > MAX_RATE) {
    return "creditRates.inputPerMillion: от 0 до 1 000 000";
  }
  if (!Number.isFinite(rates.outputPerMillion) || rates.outputPerMillion < 0 || rates.outputPerMillion > MAX_RATE) {
    return "creditRates.outputPerMillion: от 0 до 1 000 000";
  }
  if (!Number.isInteger(rates.minimumPerRun) || rates.minimumPerRun < 0 || rates.minimumPerRun > MAX_MINIMUM) {
    return "creditRates.minimumPerRun: целое от 0 до 10 000";
  }
  if (rates.inputPerMillion === 0 && rates.outputPerMillion === 0) {
    return "creditRates: хотя бы одна ставка должна быть больше нуля";
  }
  return null;
}

/**
 * Сколько кредитов списать за фактический usage. Округление вверх до целого: пользователь не
 * должен видеть дробные кредиты, а платформа не должна терять доли на каждом шаге.
 */
export function creditsForUsage(rates: CreditRates, promptTokens: number, completionTokens: number): number {
  const prompt = Math.max(0, Number(promptTokens) || 0);
  const completion = Math.max(0, Number(completionTokens) || 0);
  const raw = (prompt / 1_000_000) * rates.inputPerMillion
    + (completion / 1_000_000) * rates.outputPerMillion;
  return Math.max(rates.minimumPerRun, Math.ceil(raw));
}

/** Во сколько раз модель дороже основной по входу: это подпись «×5» в выборе модели. */
export function creditMultiplier(rates: CreditRates, base: CreditRates = BASE_CREDIT_RATES): number {
  if (base.inputPerMillion <= 0) return 1;
  const ratio = rates.inputPerMillion / base.inputPerMillion;
  return Math.round(Math.max(0, ratio) * 10) / 10;
}

/**
 * Ставки основной модели читаются из platform env: значение, сохранённое админ-приложением,
 * важнее переменной окружения, а без сохранённого значения работает прежний env/базовый набор.
 * Явный `env` нужен тестам и расчётам без общего хранилища.
 */
export function mainCreditRates(env?: NodeJS.ProcessEnv): CreditRates {
  const read = (name: string) => env ? env[name] : getPlatformEnv(name);
  const envNumber = (name: string) => {
    const raw = (read(name) ?? "").trim();
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  const input = envNumber("PLATFORM_AI_CREDITS_INPUT_PER_MILLION");
  const output = envNumber("PLATFORM_AI_CREDITS_OUTPUT_PER_MILLION");
  const minimum = envNumber("PLATFORM_AI_CREDITS_MINIMUM_PER_RUN");
  return normalizeCreditRates({
    ...(input !== undefined ? { inputPerMillion: input } : {}),
    ...(output !== undefined ? { outputPerMillion: output } : {}),
    ...(minimum !== undefined ? { minimumPerRun: minimum } : {}),
  }, BASE_CREDIT_RATES);
}
