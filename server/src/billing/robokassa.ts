import { createHash, timingSafeEqual } from "node:crypto";
import { getPlatformEnv } from "../platform/platform-env.js";
import { PLAN_CATALOG, type PlanId } from "../account/plans.js";

/**
 * Robokassa: денежная часть подписки.
 *
 * Здесь только чистая часть — канонические строки для подписи, ссылка на оплату, JSON чека и
 * запрос повторного списания. Ключи читаются через `getPlatformEnv`: значение из панели
 * «Ключи сервера» побеждает, переменная окружения продолжает работать, а стенд без ключей
 * просто сообщает, что оплата не настроена (см. docs/ROBOKASSA.md).
 */

export const ROBOKASSA_PAYMENT_URL = "https://auth.robokassa.ru/Merchant/Index.aspx";
export const ROBOKASSA_RECURRING_URL = "https://auth.robokassa.ru/Merchant/Recurring";

/** Алгоритм подписи выбирается в технических настройках магазина; MD5 — значение по умолчанию. */
const HASHES = new Set(["md5", "sha1", "sha256", "sha384", "sha512", "ripemd160"]);

export type RobokassaConfig = {
  login: string;
  password1: string;
  password2: string;
  hash: string;
  /** IsTest=1 и тестовые пароли магазина: живые деньги не списываются. */
  testMode: boolean;
  /** Услуга «Периодические платежи» включена в магазине (её включает менеджер Робокассы). */
  recurring: boolean;
  /** Отправлять Receipt JSON: нужно, когда фискализация идёт через Робокассу. */
  receipt: boolean;
  /** Заданы ли логин и оба пароля — без них оплата недоступна. */
  configured: boolean;
};

function flag(name: string) {
  return /^(1|true|yes|да)$/i.test((getPlatformEnv(name) ?? "").trim());
}

function text(name: string) {
  return (getPlatformEnv(name) ?? "").trim();
}

export function robokassaConfig(): RobokassaConfig {
  const login = text("ROBOKASSA_LOGIN");
  const password1 = text("ROBOKASSA_PASSWORD_1");
  const password2 = text("ROBOKASSA_PASSWORD_2");
  const configuredHash = text("ROBOKASSA_HASH").toLowerCase();
  return {
    login,
    password1,
    password2,
    hash: HASHES.has(configuredHash) ? configuredHash : "md5",
    testMode: flag("ROBOKASSA_TEST_MODE"),
    recurring: flag("ROBOKASSA_RECURRING"),
    receipt: flag("ROBOKASSA_RECEIPT"),
    configured: Boolean(login && password1 && password2),
  };
}

/** Строка старта службы: по ней видно, настроена ли оплата и в каком режиме. */
export function describeBilling(config: RobokassaConfig = robokassaConfig()) {
  if (!config.configured) return "billing: Robokassa не настроена (ROBOKASSA_LOGIN, ROBOKASSA_PASSWORD_1, ROBOKASSA_PASSWORD_2)";
  return "billing: Robokassa " + config.hash + (config.testMode ? ", тестовый режим" : "") + (config.recurring ? ", автопродление" : "") + (config.receipt ? ", чеки" : "");
}

/** Сумма в том виде, в каком её ждёт Robokassa: рубли с копейками и точкой. */
export function formatAmount(amount: number) {
  return amount.toFixed(2);
}

/**
 * Каждый тариф стоит фиксированную сумму в месяц. Цену можно поменять без выкатки — ключами
 * ROBOKASSA_PRICE_PRO / ROBOKASSA_PRICE_TEAM в панели; по умолчанию берётся значение каталога.
 */
export function planPriceRub(plan: PlanId): number {
  if (plan === "free") return 0;
  const fallback = PLAN_CATALOG[plan].priceRub;
  const configured = Number((getPlatformEnv("ROBOKASSA_PRICE_" + plan.toUpperCase()) ?? "").trim().replace(",", "."));
  if (!Number.isFinite(configured) || configured <= 0) return fallback;
  return Math.round(configured);
}

export function planPriceLabel(plan: PlanId) {
  if (plan === "free") return "0 ₽";
  return planPriceRub(plan).toLocaleString("ru-RU") + " ₽";
}

/** Каталог тарифов в том виде, в каком его видит интерфейс: цена приходит с сервера. */
export function publicPlans() {
  return Object.values(PLAN_CATALOG).map(plan => ({
    ...plan,
    priceRub: planPriceRub(plan.id),
    priceLabel: planPriceLabel(plan.id),
  }));
}

/** Строка, которую подписывает магазин при создании платежа (пароль №1). */
export function paymentSignatureBase(input: {
  login: string;
  outSum: string;
  invId: number | string;
  password1: string;
  /** Уже URL-кодированный Receipt: Robokassa подписывает его в этом виде. */
  receipt?: string;
}) {
  return [input.login, input.outSum, String(input.invId), ...(input.receipt ? [input.receipt] : []), input.password1].join(":");
}

/** Строка, которую подписывает магазин в уведомлении ResultURL (пароль №2). */
export function resultSignatureBase(outSum: string, invId: number | string, password2: string) {
  return [outSum, String(invId), password2].join(":");
}

export function signValue(base: string, hash: string) {
  return createHash(hash).update(base, "utf8").digest("hex");
}

/** Сравнение подписей без утечки по времени: длины и алфавит проверяются до timingSafeEqual. */
export function sameSignature(expected: string, received: string) {
  const left = expected.trim().toLowerCase();
  const right = received.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(left) || !/^[0-9a-f]+$/.test(right) || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

/**
 * Чек для фискализации. Позиция — подписка на месяц; НПД не платит НДС, поэтому `tax: "none"`.
 * Название позиции — до 128 символов, как требует документация Робокассы.
 */
export function buildReceipt(input: { planName: string; amount: number; months?: number }) {
  const months = input.months ?? 1;
  return JSON.stringify({
    items: [{
      name: ("Подписка NestDev «" + input.planName + "», " + months + " мес.").slice(0, 128),
      quantity: 1,
      sum: input.amount,
      payment_method: "full_payment",
      payment_object: "service",
      tax: "none",
    }],
  });
}

/** Значение Receipt в том виде, в каком оно участвует в подписи и уходит в запросе. */
export function encodeReceipt(receipt: string) {
  return encodeURIComponent(receipt);
}

export type PaymentLinkInput = {
  config: RobokassaConfig;
  plan: PlanId;
  planName: string;
  invId: number;
  amount: number;
  description: string;
  email?: string;
};

/**
 * Ссылка на страницу оплаты. Параметры собираются вручную, а не через URLSearchParams: Receipt
 * кодируется до подписи, и повторное кодирование изменило бы подписанное значение.
 *
 * SuccessUrl2/FailUrl2 здесь не передаются: адреса возврата задаются в кабинете Робокассы
 * (SuccessURL/FailURL), поэтому они не входят в подпись и не могут разойтись с подписью.
 */
export function buildPaymentUrl(input: PaymentLinkInput) {
  const config = input.config;
  const outSum = formatAmount(input.amount);
  const receipt = config.receipt ? encodeReceipt(buildReceipt({ planName: input.planName, amount: input.amount })) : undefined;
  const signature = signValue(paymentSignatureBase({
    login: config.login,
    outSum,
    invId: input.invId,
    password1: config.password1,
    ...(receipt ? { receipt } : {}),
  }), config.hash);

  const params: Array<[string, string]> = [
    ["MerchantLogin", config.login],
    ["OutSum", outSum],
    ["InvId", String(input.invId)],
    ["Description", input.description.slice(0, 100)],
    ["Culture", "ru"],
    ["Encoding", "utf-8"],
    ["SignatureValue", signature],
  ];
  if (input.email) params.push(["Email", input.email]);
  if (config.testMode) params.push(["IsTest", "1"]);
  if (config.recurring) params.push(["Recurring", "true"]);
  if (receipt) params.push(["Receipt", receipt]);

  // Receipt кодируется второй раз, как в справочных примерах Робокассы: на проводе лежит уже
  // закодированное значение, а подписано ровно оно. Раскодировав один раз, магазин получает
  // ту же строку, которую проверяет в подписи.
  return {
    url: ROBOKASSA_PAYMENT_URL + "?" + params.map(([name, value]) => name + "=" + encodeURIComponent(value)).join("&"),
    signature,
    outSum,
  };
}

export type RecurringChargeInput = {
  config: RobokassaConfig;
  /** Новый номер операции: его же вернёт ResultURL и по нему списание найдёт свой платёж. */
  invId: number;
  /** Номер первого платежа серии, а не предыдущего списания. */
  parentInvId: number;
  amount: number;
  description: string;
};

/**
 * Повторное списание. `OK+InvId` в ответе значит только «операция создана»: деньги списаны,
 * когда пришло уведомление ResultURL с этим InvId и верной подписью.
 */
export async function chargeRecurring(input: RecurringChargeInput) {
  const outSum = formatAmount(input.amount);
  const body = new URLSearchParams({
    MerchantLogin: input.config.login,
    InvoiceID: String(input.invId),
    PreviousInvoiceID: String(input.parentInvId),
    OutSum: outSum,
    Description: input.description.slice(0, 100),
    SignatureValue: signValue(paymentSignatureBase({
      login: input.config.login,
      outSum,
      invId: input.invId,
      password1: input.config.password1,
    }), input.config.hash),
  });
  const response = await fetch(ROBOKASSA_RECURRING_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = (await response.text()).trim();
  return { ok: response.ok && /^OK/i.test(text), status: response.status, text: text.slice(0, 300) };
}
