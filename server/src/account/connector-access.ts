import { accountPlanFor } from "../billing/store.js";
import { FREE_PLAN, type PlanId } from "./plans.js";

/**
 * Что из интеграций открыто на бесплатном тарифе.
 *
 * Репозитории (GitHub, GitLab, GitVerse, SourceCraft) проверяются отдельно: импорт до 50 МБ
 * разрешён, отправка коммитов — нет. Здесь остаются три вида: база данных, S3-хранилище и всё
 * остальное. Одной функцией пользуются и HTTP-маршруты, и инструменты агента, чтобы правило не
 * разошлось между панелью и моделью.
 */
export type ConnectorAccessKind = "cloud" | "domain" | "service" | "database" | "yandex";

export const FREE_CONNECTOR_MESSAGE =
  "На бесплатном тарифе доступны только GitHub, GitLab, GitVerse, SourceCraft, базы данных и S3-хранилище. " +
  "Облака, домены и остальные сервисы открываются на платных тарифах.";

export class ConnectorPlanError extends Error {
  readonly statusCode = 403;
  readonly code = "PLAN_CONNECTOR_LOCKED";

  constructor(message = FREE_CONNECTOR_MESSAGE) {
    super(message);
    this.name = "ConnectorPlanError";
  }
}

/** `serviceCategory` нужен только для `service`: S3-сервисы лежат в категории `storage`. */
export function connectorAllowedForPlan(plan: PlanId, kind: ConnectorAccessKind, serviceCategory?: string) {
  if (plan !== FREE_PLAN) return true;
  if (kind === "database") return true;
  if (kind === "service") return serviceCategory === "storage";
  return false;
}

export async function assertConnectorAccess(userId: string, kind: ConnectorAccessKind, serviceCategory?: string) {
  const plan = await accountPlanFor(userId);
  if (connectorAllowedForPlan(plan, kind, serviceCategory)) return plan;
  throw new ConnectorPlanError();
}

/**
 * Ответ маршрута на закрытый коннектор. `null` — доступ есть, можно продолжать.
 * Один и тот же текст уходит и в интерфейс, и модели, поэтому причина не разъезжается.
 */
export async function connectorRefusal(userId: string, kind: ConnectorAccessKind, serviceCategory?: string) {
  const plan = await accountPlanFor(userId);
  if (connectorAllowedForPlan(plan, kind, serviceCategory)) return null;
  return { error: FREE_CONNECTOR_MESSAGE, code: "PLAN_CONNECTOR_LOCKED" } as const;
}
