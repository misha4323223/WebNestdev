import { apiJson } from "./api";

export type PlanId = "free" | "pro" | "team";
export type PlanLimits = { projects: number; agentRunsPerDay: number; browserChecksPerDay: number; storageBytes?: number };
export type Plan = {
  id: PlanId;
  name: string;
  /** Price of the plan. Paid plans read «Скоро» while payment is not connected yet. */
  priceLabel: string;
  tagline: string;
  description: string;
  audience: string;
  recommended: boolean;
  limits: PlanLimits;
  features: string[];
  details: string[];
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
/** The plan catalog, the limits of the account's own plan and today's usage. */
export type BillingData = {
  plans: Plan[];
  limits: PlanLimits;
  usage: Usage;
  storage?: Storage;
  cost: Cost;
};

export const getBilling = () => apiJson<BillingData>("/api/billing");

/**
 * Оплата ещё не подключена, поэтому платные тарифы включить нельзя: выбранный тариф хранится
 * как пожелание (src/lib/plan-choice.ts), а действующий всегда бесплатный. Этой строкой
 * состояние объясняется одинаково на всех экранах.
 */
export const paymentsPendingNotice = "Оплата ещё не подключена: платные тарифы включим вместе с ней, сейчас работает бесплатный.";

export const dateLabel = (value: string | null) => value ? new Date(value).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }) : "—";
export const moneyLabel = (value: number | null, currency: string) => value == null ? "—" : (value < 0.01 ? value.toFixed(4) : value.toFixed(2)) + " " + currency;
