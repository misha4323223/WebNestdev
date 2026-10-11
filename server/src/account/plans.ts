export const PLAN_CATALOG = {
  free: {
    id: "free",
    name: "Бесплатный",
    priceLabel: "0 ₽",
    tagline: "Старт без оплаты",
    description: "Чтобы познакомиться с WebNestdev",
    audience: "Для первых проектов и знакомства с агентом.",
    recommended: false,
    limits: { projects: 3, agentRunsPerDay: 10, browserChecksPerDay: 5 },
    features: ["3 проекта", "10 запусков агента в день", "5 браузерных проверок в день"],
    details: [
      "3 проекта одновременно — каждый со своей рабочей областью и историей сессий.",
      "10 запусков агента в день: агент пишет файлы, запускает терминал и проверяет результат.",
      "5 браузерных проверок в день: снимок страницы, консоль и ошибки сети.",
      "Демо-тарифы «Про» и «Команда» можно включить без оплаты на 30 дней.",
    ],
  },
  pro: {
    id: "pro",
    name: "Про",
    priceLabel: "Демо",
    tagline: "Для регулярной разработки",
    description: "Для регулярной разработки",
    audience: "Для тех, кто собирает продукты постоянно, а не от случая к случаю.",
    recommended: true,
    limits: { projects: 15, agentRunsPerDay: 100, browserChecksPerDay: 50 },
    features: ["15 проектов", "100 запусков агента в день", "50 браузерных проверок в день", "Приоритетные возможности (демо)"],
    details: [
      "15 проектов одновременно и отдельная рабочая область для каждого.",
      "100 запусков агента в день с автоматической проверкой изменений после правок.",
      "50 браузерных проверок в день — хватает на итерации по интерфейсу.",
      "Приоритетные возможности (демо): публикация проектов и импорт из GitHub.",
    ],
  },
  team: {
    id: "team",
    name: "Команда",
    priceLabel: "Демо",
    tagline: "Для небольшой команды",
    description: "Для небольшой команды",
    audience: "Для команд, где над одним продуктом работают несколько человек.",
    recommended: false,
    limits: { projects: 50, agentRunsPerDay: 500, browserChecksPerDay: 250 },
    features: ["50 проектов", "500 запусков агента в день", "250 браузерных проверок в день", "Командные возможности (демо)"],
    details: [
      "50 проектов одновременно — под задачи всей команды.",
      "500 запусков агента в день на всех участников.",
      "250 браузерных проверок в день для веб-приложений.",
      "Командные возможности (демо): общий доступ и роли — в разработке.",
    ],
  },
} as const;
export type PlanId = keyof typeof PLAN_CATALOG;
export type UsageKind = "agentRuns" | "browserChecks";
export type UsageSnapshot = { date: string; agentRuns: number; browserChecks: number };
export function limitsForPlan(plan: PlanId) { return PLAN_CATALOG[plan].limits; }
