export const PLAN_CATALOG = {
  free: { id: "free", name: "Free", priceLabel: "$0", description: "Чтобы познакомиться с WebNestdev", limits: { projects: 3, agentRunsPerDay: 10, browserChecksPerDay: 5 }, features: ["3 проекта", "10 запусков агента в день", "5 браузерных проверок в день"] },
  pro: { id: "pro", name: "Pro", priceLabel: "Демо", description: "Для регулярной разработки", limits: { projects: 15, agentRunsPerDay: 100, browserChecksPerDay: 50 }, features: ["15 проектов", "100 запусков агента в день", "50 браузерных проверок в день", "Приоритетные возможности (демо)"] },
  team: { id: "team", name: "Team", priceLabel: "Демо", description: "Для небольшой команды", limits: { projects: 50, agentRunsPerDay: 500, browserChecksPerDay: 250 }, features: ["50 проектов", "500 запусков агента в день", "250 браузерных проверок в день", "Командные возможности (демо)"] },
} as const;
export type PlanId = keyof typeof PLAN_CATALOG;
export type UsageKind = "agentRuns" | "browserChecks";
export type UsageSnapshot = { date: string; agentRuns: number; browserChecks: number };
export function limitsForPlan(plan: PlanId) { return PLAN_CATALOG[plan].limits; }
