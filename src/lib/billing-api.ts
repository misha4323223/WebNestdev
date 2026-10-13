import { apiJson } from "./api";

export type PlanId = "free" | "pro" | "team";
export type PlanStatus = "free" | "demo_active" | "demo_expired" | "demo_cancelled";
export type PlanLimits = { projects: number; agentRunsPerDay: number; browserChecksPerDay: number; storageBytes?: number };
export type Plan = {
  id: PlanId;
  name: string;
  priceLabel: string;
  tagline: string;
  description: string;
  audience: string;
  recommended: boolean;
  limits: PlanLimits;
  features: string[];
  details: string[];
};
export type Subscription = {
  plan: PlanId;
  status: PlanStatus;
  startedAt: string | null;
  expiresAt: string | null;
  updatedAt: string;
  mode: "demo";
};
export type Usage = { date: string; agentRuns: number; browserChecks: number };
export type Storage = { usedBytes: number; limitBytes: number };
export type CostRun = { model: string; promptTokens: number; completionTokens: number; exact: boolean; costEstimate: number | null; createdAt: string };
export type Cost = {
  date: string;
  runs: number;
  promptTokens: number;
  completionTokens: number;
  exact: boolean;
  pricesConfigured: boolean;
  costEstimate: number | null;
  currency: string;
  lastRun: CostRun | null;
};
export type BillingData = {
  mode: "demo";
  subscription: Subscription;
  plans: Plan[];
  limits: PlanLimits;
  usage: Usage;
  storage?: Storage;
  cost: Cost;
};

export const getBilling = () => apiJson<BillingData>("/api/billing");
export const activateDemoPlan = (plan: "pro" | "team") => apiJson<{ message: string }>("/api/billing/demo/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan }) });
export const cancelDemoPlan = () => apiJson<{ message: string }>("/api/billing/demo/cancel", { method: "POST" });

export const planDateLabel = (value: string | null) => value ? new Date(value).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }) : "—";
export const moneyLabel = (value: number | null, currency: string) => value == null ? "—" : (value < 0.01 ? value.toFixed(4) : value.toFixed(2)) + " " + currency;

/** One line that explains the current demo subscription state to the user. */
export function subscriptionSummary(subscription: Subscription): string {
  if (subscription.status === "demo_active") return "Демо действует до " + planDateLabel(subscription.expiresAt) + ".";
  if (subscription.status === "demo_cancelled") return "Демо-подписка отменена. Доступен бесплатный тариф.";
  if (subscription.status === "demo_expired") return "Срок демо закончился. Доступен бесплатный тариф.";
  return "Бесплатный режим активен. Демо-тариф можно включить на 30 дней без оплаты.";
}
