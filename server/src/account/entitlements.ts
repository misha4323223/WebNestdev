import type { PlanId } from "./plans.js";

/**
 * Возможности тарифа, которые проверяются на сервере в момент действия.
 *
 * Это не квоты и не цена: возможность отвечает только на вопрос «разрешено ли действие».
 * Числа (проекты, кредиты, хранилище, минуты песочницы) остаются в `plans.ts`.
 *
 * Границы важны:
 * - `interactiveTerminal` — терминал панели, который человек открывает сам. Агентские
 *   `terminal.exec`/`terminal.start` остаются инструментами сборки и не входят сюда, иначе
 *   Плюс не сможет собрать и проверить проект.
 * - `containerPreview` — dev-сервер и hybrid preview. Статический preview разрешён всем.
 * - `serverlessFunctions` — публикация и исполнение функций на своём хосте.
 * - `backgroundJobs` — очередь фоновых заданий после HTTP-ответа; отдельный пул, только «Премиум».
 * - `ownAiProvider` — проект работает через ключ и модель пользователя; на «Старте» этой
 *   возможности нет, потому что бесплатный тариф должен идти через модель платформы.
 */
export type PlanFeature =
  | "staticHosting"
  | "serverlessFunctions"
  | "backgroundJobs"
  | "interactiveTerminal"
  | "containerPreview"
  | "ownAiProvider";

export type PlanEntitlements = Readonly<Record<PlanFeature, boolean>>;

/**
 * Один источник истины для тарифной матрицы. Порядок тарифов от младшего к старшему.
 * Не выводить это из features: features — рекламный текст, который админ может переписать.
 */
const PLAN_ENTITLEMENTS: Readonly<Record<PlanId, PlanEntitlements>> = Object.freeze({
  free: Object.freeze({
    staticHosting: true,
    serverlessFunctions: false,
    backgroundJobs: false,
    interactiveTerminal: false,
    containerPreview: false,
    ownAiProvider: false,
  }),
  pro: Object.freeze({
    staticHosting: true,
    serverlessFunctions: true,
    backgroundJobs: false,
    interactiveTerminal: false,
    containerPreview: false,
    ownAiProvider: true,
  }),
  team: Object.freeze({
    staticHosting: true,
    serverlessFunctions: true,
    backgroundJobs: true,
    interactiveTerminal: true,
    containerPreview: true,
    ownAiProvider: true,
  }),
});

export const PLAN_FEATURE_LABELS: Readonly<Record<PlanFeature, string>> = Object.freeze({
  staticHosting: "статические сайты",
  serverlessFunctions: "serverless-функции",
  backgroundJobs: "фоновые задания",
  interactiveTerminal: "терминал",
  containerPreview: "контейнерный предпросмотр",
  ownAiProvider: "свой AI-провайдер",
});

/** Минимальный тариф, на котором возможность появляется. */
const REQUIRED_PLAN: Readonly<Record<PlanFeature, PlanId>> = Object.freeze({
  staticHosting: "free",
  serverlessFunctions: "pro",
  backgroundJobs: "team",
  interactiveTerminal: "team",
  containerPreview: "team",
  ownAiProvider: "pro",
});

const PLAN_NAMES: Readonly<Record<PlanId, string>> = Object.freeze({
  free: "Старт",
  pro: "Плюс",
  team: "Премиум",
});

export function entitlementsFor(plan: PlanId): PlanEntitlements {
  return PLAN_ENTITLEMENTS[plan];
}

export function planAllows(plan: PlanId, feature: PlanFeature): boolean {
  return PLAN_ENTITLEMENTS[plan][feature];
}

export function requiredPlanFor(feature: PlanFeature): PlanId {
  return REQUIRED_PLAN[feature];
}

export class PlanFeatureError extends Error {
  readonly code = "PLAN_FEATURE_REQUIRED";
  readonly statusCode = 403;

  constructor(
    readonly plan: PlanId,
    readonly feature: PlanFeature,
  ) {
    super(planFeatureMessage(plan, feature));
    this.name = "PlanFeatureError";
  }
}

export function planFeatureMessage(plan: PlanId, feature: PlanFeature): string {
  const required = REQUIRED_PLAN[feature];
  const unavailable = feature === "ownAiProvider" ? "недоступен" : "недоступны";
  const opens = feature === "ownAiProvider" ? "чтобы подключить его" : "чтобы включить их";
  return "На тарифе «" + PLAN_NAMES[plan] + "» " + PLAN_FEATURE_LABELS[feature] +
    " " + unavailable + ". Оформите «" + PLAN_NAMES[required] + "», " + opens + ".";
}

export function assertPlanFeature(plan: PlanId, feature: PlanFeature): void {
  if (!planAllows(plan, feature)) throw new PlanFeatureError(plan, feature);
}
