import { PLAN_CATALOG, integrationLimitFor, type IntegrationKind, type PlanId } from "./plans.js";

/**
 * Лимит подключений по тарифу.
 *
 * Интеграции не стоят платформе денег напрямую, но стоят поддержки: каждая карточка — это ключ,
 * который проверяется, хранится зашифрованным и должен работать. Поэтому на «Старте» их по одной
 * на вид, а платные тарифы снимают ограничение.
 *
 * Проверяется только новое подключение. Уже существующие не отключаются при смене тарифа и не
 * блокируются: человек не должен потерять доступ к своему облаку из-за окончания подписки.
 */

const SLOT_LABEL: Record<IntegrationKind, (limit: number) => string> = {
  cloud: limit => (limit === 1 ? "один облачный аккаунт" : limit + " облачных аккаунта"),
  domains: limit => (limit === 1 ? "один кабинет регистратора" : limit + " кабинета регистраторов"),
  services: limit => limit + " сервиса с ключом",
};

export class IntegrationLimitError extends Error {
  readonly statusCode = 403;
  readonly code = "PLAN_LIMIT_REACHED";

  constructor(message: string) {
    super(message);
    this.name = "IntegrationLimitError";
  }
}

/**
 * `used` — сколько подключений этого вида уже есть, `replacing` — пересохранение того же
 * провайдера (место не занимает). Ошибка — `IntegrationLimitError` с текстом для панели.
 */
export function assertIntegrationSlot(input: {
  plan: PlanId;
  kind: IntegrationKind;
  used: number;
  replacing: boolean;
}) {
  const limit = integrationLimitFor(input.plan, input.kind);
  if (limit === null || input.replacing || input.used < limit) return;
  const plan = PLAN_CATALOG[input.plan];
  throw new IntegrationLimitError(
    "На тарифе «" + plan.name + "» можно подключить " + SLOT_LABEL[input.kind](limit) + ". " +
    "Больше — на «Плюсе» и «Премиуме»; уже подключённое при смене тарифа остаётся на месте.",
  );
}
