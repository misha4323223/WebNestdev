import { getPlatformEnv } from "../platform/platform-env.js";
import { getUser } from "../auth/auth-store.js";
import { getUserProfile } from "../account/profile-store.js";
import { PLAN_CATALOG, type PlanId } from "../account/plans.js";
import { mailConfigured, sendMail, type MailInput } from "../mail/mailer.js";
import { planPriceRub } from "./robokassa.js";
import type { SubscriptionRecord } from "./store.js";

/**
 * Письма биллинга и проверка, можно ли включать автопродление.
 *
 * По 376-ФЗ (в силе с 01.03.2026) подписка продлевается только по сознательному согласию и с
 * предупреждением о предстоящем платеже, поэтому:
 *   - включить автопродление можно только у аккаунта с настоящей почтой и при настроенной
 *     почтовой службе платформы (`autoRenewRefusal`) — предупреждать будет некуда иначе;
 *   - перед списанием уходит письмо-предупреждение, и без него свипер не списывает
 *     (`listDueSubscriptions`, docs/MAIL.md).
 *
 * Письмо никогда не влияет на деньги: уведомление об оплате подтверждает платёж, а не письмо,
 * поэтому вызывающий код отправляет письмо отдельным шагом и только логирует отказ.
 */

/** Служебные адреса входа (`79531814136@phone.webnestdev.local`) — не почта: письмо туда не дойдёт. */
const SERVICE_SUFFIXES = ["@phone.webnestdev.local", "@yandex-id.webnestdev.local"];

export function isServiceAddress(email: string) {
  const value = email.trim().toLowerCase();
  return SERVICE_SUFFIXES.some(suffix => value.endsWith(suffix));
}

/**
 * Куда писать человеку: настоящий адрес входа, иначе почта для связи из знакомства. `null` —
 * аккаунт оставлял только телефон, и письма у него нет.
 */
export async function reachableEmailFor(user: { id: string; email: string }): Promise<string | null> {
  const login = user.email.trim().toLowerCase();
  if (login && !isServiceAddress(login)) return login;
  const profile = await getUserProfile(user.id).catch(() => null);
  const contact = (profile?.email ?? "").trim().toLowerCase();
  return contact || null;
}

/** Почему автопродление нельзя включить сейчас; `null` — можно. */
export async function autoRenewRefusal(user: { id: string; email: string }): Promise<string | null> {
  if (!mailConfigured()) {
    return "Автопродление пока недоступно: почтовая служба платформы не настроена. Продлить подписку можно вручную после окончания оплаченного периода.";
  }
  if (!(await reachableEmailFor(user))) {
    return "Для автопродления нужна почта: платформа предупреждает о списании письмом. Добавьте почту в контактах аккаунта и включите продление снова.";
  }
  return null;
}

const dateLabel = (iso: string) => new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
const rubLabel = (value: number) => value.toLocaleString("ru-RU") + " ₽";

export function paymentPaidLetter(input: { plan: PlanId; amount: number; invId: number; renewsAt: string; autoRenew: boolean }) {
  const planName = PLAN_CATALOG[input.plan].name;
  const until = dateLabel(input.renewsAt);
  const lines = [
    "Оплата принята.",
    "",
    "Тариф: «" + planName + "»",
    "Сумма: " + rubLabel(input.amount),
    "Оплачено до: " + until,
    "Счёт №: " + input.invId,
    "",
    input.autoRenew
      ? "Автопродление включено: следующее списание — " + until + ". Отключить его можно в любой момент в личном кабинете («Настройки» → «Тариф и подписка»)."
      : "Автопродление выключено: подписка действует до " + until + ", продлить её можно вручную в личном кабинете.",
    "",
    "Чек НПД придёт отдельным сообщением от платёжного сервиса.",
  ];
  return { subject: "Оплата принята — тариф «" + planName + "»", text: lines.join("\n") };
}

export function renewalNoticeLetter(input: { plan: PlanId; amount: number; renewsAt: string }) {
  const planName = PLAN_CATALOG[input.plan].name;
  const when = dateLabel(input.renewsAt);
  const lines = [
    "Скоро продление подписки NestDev — это письмо-предупреждение о списании.",
    "",
    "Тариф: «" + planName + "»",
    "Сумма списания: " + rubLabel(input.amount),
    "Дата списания: " + when,
    "",
    "Списание произойдёт автоматически, потому что автопродление включено. Если оно больше не нужно,",
    "отключите его в личном кабинете («Настройки» → «Тариф и подписка») до даты списания — уже",
    "оплаченный период сохранится.",
    "",
    "Если карта не сможет оплатить списание, повторим попытку в течение следующих дней, после чего",
    "подписка сменится на бесплатный тариф.",
  ];
  return { subject: "Скоро спишем " + rubLabel(input.amount) + " за тариф «" + planName + "»", text: lines.join("\n") };
}

export type LetterSend = (input: MailInput) => Promise<void>;

/** Письмо об оплате покупателю. `false` — отправлять некуда или нечего (нет пользователя/почты). */
export async function notifyPaymentPaid(
  input: { userId: string; plan: PlanId; amount: number; invId: number; renewsAt: string; autoRenew: boolean },
  send: LetterSend = sendMail,
): Promise<boolean> {
  const user = await getUser(input.userId);
  if (!user) return false;
  const to = await reachableEmailFor(user);
  if (!to) return false;
  await send({ to, ...paymentPaidLetter(input) });
  return true;
}

/** Письмо-предупреждение перед автопродлением. Без него свипер не списывает деньги. */
export async function sendRenewalNotice(record: SubscriptionRecord, send: LetterSend = sendMail): Promise<boolean> {
  const user = await getUser(record.userId);
  if (!user) return false;
  const to = await reachableEmailFor(user);
  if (!to) return false;
  await send({ to, ...renewalNoticeLetter({ plan: record.plan, amount: planPriceRub(record.plan), renewsAt: record.renewsAt }) });
  return true;
}

/**
 * За сколько дней до списания предупреждать. Ключ `BILLING_NOTICE_DAYS` из «Ключей сервера»;
 * по умолчанию три дня — предупреждение успевает дойти, и человек успевает отключить продление.
 */
export function renewalNoticeDays(): number {
  const configured = Number((getPlatformEnv("BILLING_NOTICE_DAYS") ?? "").trim().replace(",", "."));
  if (!Number.isFinite(configured)) return 3;
  return configured >= 1 && configured <= 30 ? Math.trunc(configured) : 3;
}
