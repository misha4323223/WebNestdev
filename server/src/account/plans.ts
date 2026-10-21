export const PLAN_CATALOG = {
  free: {
    id: "free",
    name: "Бесплатный",
    priceLabel: "0 ₽",
    priceRub: 0,
    tagline: "Старт без оплаты",
    description: "Чтобы познакомиться с NestDev",
    audience: "Для первых проектов и знакомства с агентом.",
    recommended: false,
    // 700 МиБ, а не 700 000 000 байт: интерфейс делит на 1024 и показывает ровно «700 МБ».
    limits: { projects: 3, agentRunsPerDay: 10, browserChecksPerDay: 5, webSearchesPerDay: 25, storageBytes: 734_003_200 },
    features: ["3 проекта", "10 запусков агента в день на модели платформы", "Свой AI-провайдер — запуски без дневного лимита", "5 браузерных проверок в день", "25 поисков в интернете в день", "700 МБ хранилища"],
    details: [
      "3 проекта одновременно — каждый со своей рабочей областью и историей сессий.",
      "10 запусков агента в день считаются только для встроенной модели платформы: она отвечает за счёт платформы, поэтому её запуски ограничены.",
      "Подключите свой AI-провайдер в настройках проекта — запуски агента пойдут через ваш ключ и модель, и дневной лимит к ним не применяется.",
      "5 браузерных проверок в день: снимок страницы, консоль и ошибки сети.",
      "700 МБ хранилища — это общая квота аккаунта на все проекты: исходники, node_modules и сборка входят в неё.",
      "25 поисков в интернете в день: агент ищет и открывает найденные страницы. Поиск включается в меню «Режимы» у поля ввода — по умолчанию он выключен.",
      "Платные тарифы оплачиваются картой или через СБП на странице Робокассы; подписка на месяц включается сразу после платежа.",
    ],
  },
  pro: {
    id: "pro",
    name: "Про",
    priceLabel: "990 ₽",
    priceRub: 990,
    tagline: "Для регулярной разработки",
    description: "Для регулярной разработки",
    audience: "Для тех, кто собирает продукты постоянно, а не от случая к случаю.",
    recommended: true,
    limits: { projects: 15, agentRunsPerDay: 100, browserChecksPerDay: 50, webSearchesPerDay: 200, storageBytes: 10_737_418_240 },
    features: ["15 проектов", "100 запусков агента в день", "50 браузерных проверок в день", "200 поисков в интернете в день", "10 ГБ хранилища", "Публикация проектов и импорт из GitHub"],
    details: [
      "15 проектов одновременно и отдельная рабочая область для каждого.",
      "100 запусков агента в день с автоматической проверкой изменений после правок.",
      "50 браузерных проверок в день — хватает на итерации по интерфейсу.",
      "200 поисков в день: своя выдача на русском и больше источников, чем на бесплатном тарифе.",
      "10 ГБ хранилища — общая квота аккаунта на все 15 проектов, а не по 10 ГБ на каждый.",
      "Приоритетные возможности: публикация проектов и импорт из GitHub.",
    ],
  },
  team: {
    id: "team",
    name: "Команда",
    priceLabel: "2 990 ₽",
    priceRub: 2990,
    tagline: "Для небольшой команды",
    description: "Для небольшой команды",
    audience: "Для команд, где над одним продуктом работают несколько человек.",
    recommended: false,
    limits: { projects: 50, agentRunsPerDay: 500, browserChecksPerDay: 250, webSearchesPerDay: 500, storageBytes: 50_368_744_176 },
    features: ["50 проектов", "500 запусков агента в день", "250 браузерных проверок в день", "500 поисков в интернете в день", "50 ГБ хранилища", "Командные возможности"],
    details: [
      "50 проектов одновременно — под задачи всей команды.",
      "500 запусков агента в день на всех участников.",
      "250 браузерных проверок в день для веб-приложений.",
      "500 поисков в день на всю команду.",
      "Командные возможности: общий доступ и роли — в разработке.",
    ],
  },
} as const;
export type PlanId = keyof typeof PLAN_CATALOG;
/** Тариф аккаунта без подписки. Действующий тариф читается из оплаченной подписки (billing/store.ts). */
export const FREE_PLAN: PlanId = "free";
export type UsageKind = "agentRuns" | "browserChecks" | "webSearches";
export type UsageSnapshot = { date: string; agentRuns: number; browserChecks: number; webSearches: number };
export function limitsForPlan(plan: PlanId) { return PLAN_CATALOG[plan].limits; }

/**
 * Подписка и баланс аккаунта — то, что видит вкладка биллинга.
 *
 * `status: "canceled"` — подписка ещё действует до `renewsAt`, но автопродление выключено.
 * `paymentConnected` говорит, настроен ли приём денег; без него кнопки оплаты не показываются.
 */
export type BillingSubscription = {
  plan: PlanId;
  planName: string;
  priceLabel: string;
  status: "active" | "canceled";
  startedAt: string;
  renewsAt: string | null;
  paymentConnected: boolean;
  autoRenew: boolean;
  amountRub: number;
  /** Услуга периодических платежей включена в магазине: только тогда можно обещать автопродление. */
  recurringAvailable: boolean;
};

export type BillingBalance = { amount: number; currency: string; paymentsConnected: boolean };

/** Подписка бесплатного тарифа: у неё нет срока и автопродления. */
export function subscriptionFor(plan: PlanId, startedAt: string, extra: Partial<BillingSubscription> = {}): BillingSubscription {
  return {
    plan,
    planName: PLAN_CATALOG[plan].name,
    priceLabel: PLAN_CATALOG[plan].priceLabel,
    status: "active",
    startedAt,
    renewsAt: null,
    paymentConnected: false,
    autoRenew: false,
    amountRub: PLAN_CATALOG[plan].priceRub,
    recurringAvailable: false,
    ...extra,
  };
}

/** Баланс — сумма на счёте аккаунта. Пока оплата не подключена, на счёте ничего нет. */
export function balanceFor(): BillingBalance {
  return { amount: 0, currency: "RUB", paymentsConnected: false };
}

/**
 * Отображение тарифа: цена приходит с сервера, поэтому интерфейс не хранит суммы у себя.
 * Действующий тариф аккаунта — `accountPlanFor` в billing/store.ts: он читает оплаченную подписку.
 */
export function planView(plan: PlanId) {
  return { ...PLAN_CATALOG[plan], priceRub: PLAN_CATALOG[plan].priceRub };
}
