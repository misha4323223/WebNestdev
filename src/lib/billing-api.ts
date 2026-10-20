import { apiJson } from "./api";

export type PlanId = "free" | "pro" | "team";
export type PlanLimits = { projects: number; agentRunsPerDay: number; browserChecksPerDay: number; webSearchesPerDay: number; storageBytes?: number };
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

/** Счёт на оплату: сумму и ссылку на Робокассу считает сервер. */
export const startCheckout = (plan: "pro" | "team") => apiJson<Checkout>("/api/billing/checkout", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ plan }),
});

/** Автопродление: сервер откажет, если в магазине не подключена услуга периодических платежей. */
export const updateAutoRenew = (autoRenew: boolean) => apiJson<{ subscription: Subscription }>("/api/billing/subscription", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ autoRenew }),
});

/**
 * Оплата пока не настроена на сервере: логина и паролей Робокассы нет. Это единственный случай,
 * когда выбранный тариф остаётся пожеланием — строка объясняет состояние одинаково на всех экранах.
 */
export const paymentsPendingNotice = "Оплата ещё не подключена: администратору нужно добавить ключи Робокассы. Сейчас работает бесплатный тариф.";

export const paymentNotice = (billing: BillingData | null | undefined) => billing?.paymentsEnabled
  ? "Оплата картой РФ или через СБП на защищённой странице Робокассы. Тариф включается сразу после подтверждения платежа."
  : paymentsPendingNotice;

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
