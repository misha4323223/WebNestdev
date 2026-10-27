import { apiJson } from "./api";

export type PlanId = "free" | "pro" | "team";
export type PlanLimits = {
  projects: number;
  agentRunsPerDay: number;
  browserChecksPerDay: number;
  webSearchesPerDay: number;
  storageBytes?: number;
  /** Пул токенов встроенной модели на месяц; 0 или отсутствие — пула нет, работает дневной лимит. */
  agentTokensPerMonth?: number;
};
export type Plan = {
  id: PlanId;
  name: string;
  /** Цена с сервера: сумма и подпись приходят из одного места, интерфейс их не хранит. */
  priceLabel: string;
  priceRub?: number;
  tagline: string;
  description: string;
  audience: string;
  recommended: boolean;
  limits: PlanLimits;
  features: string[];
  details: string[];
};
export type Usage = { date: string; agentRuns: number; browserChecks: number; webSearches: number };
/** Расход месячного пула: `limit: 0` — у тарифа пула нет, шкала не рисуется. */
export type TokenBudget = { month: string; used: number; limit: number; remaining: number };
/** Состояние квоты считает сервер: пороги 80% и 100% должны совпадать на всех экранах. */
export type StorageState = "ok" | "warning" | "full";
export type StorageProject = { id: string; name: string; sizeBytes: number; measuredAt: string | null };
export type Storage = {
  usedBytes: number;
  limitBytes: number;
  state?: StorageState;
  measuredAt?: string | null;
  projects?: StorageProject[];
};
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
/** Один день истории: из него складывается график трат и список последних дней. */
export type BillingHistoryDay = {
  date: string;
  agentRuns: number;
  browserChecks: number;
  webSearches: number;
  runs: number;
  promptTokens: number;
  completionTokens: number;
  costEstimate: number | null;
};
export type BillingHistory = { currency: string; pricesConfigured: boolean; days: BillingHistoryDay[] };
/**
 * Подписка: `status: "canceled"` значит «действует до renewsAt, но автопродление выключено».
 * `paymentConnected` говорит, настроен ли приём денег — без него кнопки оплаты не показываются.
 */
export type Subscription = {
  plan: PlanId;
  planName: string;
  priceLabel: string;
  status: "active" | "canceled";
  startedAt: string;
  renewsAt: string | null;
  paymentConnected: boolean;
  autoRenew: boolean;
  amountRub: number;
  recurringAvailable: boolean;
};
export type Balance = { amount: number; currency: string; paymentsConnected: boolean };
export type PaymentStatus = "pending" | "paid" | "failed";
export type BillingPayment = {
  invId: number;
  plan: PlanId;
  planName: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  kind: "initial" | "renewal";
  createdAt: string;
  paidAt: string | null;
};
/** The plan catalog, the limits of the account's own plan and today's usage. */
export type BillingData = {
  plans: Plan[];
  plan?: PlanId;
  limits: PlanLimits;
  usage: Usage;
  tokens?: TokenBudget;
  storage?: Storage;
  cost: Cost;
  subscription?: Subscription;
  balance?: Balance;
  history?: BillingHistory;
  payments?: BillingPayment[];
  paymentsEnabled?: boolean;
};
export type Checkout = { invId: number; paymentUrl: string; amount: number; currency: string; test: boolean };

export const getBilling = () => apiJson<BillingData>("/api/billing");

/**
 * Ручной пересчёт размера хранилища. Нужен после удаления файлов или `node_modules`:
 * ночная сверка обновит число только завтра, а человек ждёт ответа сразу.
 */
export const refreshStorage = () => apiJson<{ projects: number; measured: number; storage: Storage }>(
  "/api/account/storage/refresh", { method: "POST" });

/** Единый формат байтов для квоты: настройки, колонка и страница подписки должны читать одно и то же. */
export function bytesLabel(value: number): string {
  // Целые гигабайты и мегабайты печатаются без «.0»: лимит тарифа читается как «700 МБ», а не «700.0 МБ».
  const size = (amount: number) => amount.toFixed(1).replace(/\.0$/, "");
  if (value < 1024) return value + " Б";
  if (value < 1024 * 1024) return Math.round(value / 1024) + " КБ";
  if (value < 1024 * 1024 * 1024) return size(value / 1024 / 1024) + " МБ";
  return size(value / 1024 / 1024 / 1024) + " ГБ";
}

/**
 * Счёт на оплату: сумму и ссылку на платёжную страницу считает сервер, а `autoRenew` — отдельное
 * согласие человека на регулярные списания; без него счёт разовый.
 */
export const startCheckout = (plan: "pro" | "team", autoRenew: boolean) => apiJson<Checkout>("/api/billing/checkout", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ plan, autoRenew }),
});

/** Автопродление: сервер сам проверяет, доступно ли оно для подписки. */
export const updateAutoRenew = (autoRenew: boolean) => apiJson<{ subscription: Subscription }>("/api/billing/subscription", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ autoRenew }),
});

/**
 * Оплата пока не подключена. Это единственный случай, когда выбранный тариф остаётся пожеланием —
 * строка объясняет состояние одинаково на всех экранах и не показывает внутреннюю настройку сервера.
 */
export const paymentsPendingNotice = "Оплата скоро: сейчас доступен бесплатный тариф.";

export const paymentNotice = (billing: BillingData | null | undefined) => billing?.paymentsEnabled
  ? "Оплата картой или через СБП на защищённой странице оплаты. Тариф включается сразу после подтверждения платежа."
  : paymentsPendingNotice;

/** Токены в человеческом виде: «50 млн», а не «50000000» — так их читают в сравнении тарифов. */
export function tokensLabel(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return (Number.isInteger(millions) ? String(millions) : millions.toFixed(1).replace(".", ",")) + " млн";
  }
  if (value >= 1_000) return Math.round(value / 1_000) + " тыс.";
  return String(value);
}

export const dateLabel = (value: string | null) => value ? new Date(value).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }) : "—";
export const moneyLabel = (value: number | null, currency: string) => value == null ? "—" : (value < 0.01 ? value.toFixed(4) : value.toFixed(2)) + " " + currency;
/** Баланс — в рублях и без копеек: это счёт аккаунта, а не оценка расхода модели. */
export const balanceLabel = (balance: Balance | undefined) => {
  if (!balance) return "—";
  const amount = balance.amount.toLocaleString("ru-RU");
  return balance.currency === "RUB" ? amount + " ₽" : amount + " " + balance.currency;
};
/** Сумма платежа — в рублях, без копеек: подписка стоит целое число рублей. */
export const rubLabel = (value: number) => value.toLocaleString("ru-RU") + " ₽";
export const paymentStatusLabel = (status: PaymentStatus) => status === "paid" ? "оплачен" : status === "failed" ? "не прошёл" : "ожидает оплаты";
/** Короткая дата дня истории: «20 окт». */
export const shortDayLabel = (date: string) => new Date(date + "T00:00:00Z").toLocaleDateString("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });
