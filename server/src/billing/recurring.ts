import { planDisplayName } from "./plan-settings.js";
import { renewalNoticeDays } from "./notify.js";
import { chargeRecurring, planPriceRub, robokassaConfig } from "./robokassa.js";
import { sendRenewalNotice } from "./notify.js";
import { createPayment, hasPendingPayment, listDueSubscriptions, listSubscriptionsForNotice, markNoticeSent, markPaymentFailed, postponeRenewal, type SubscriptionRecord } from "./store.js";

/**
 * Автопродление подписок.
 *
 * Услуга «Периодические платежи» включается менеджером Робокассы, поэтому цикл работает только при
 * `ROBOKASSA_RECURRING=1`. Первый платёж серии помечен `Recurring=true` и запомнен как родительский
 * счёт; каждое следующее списание — новый счёт с `PreviousInvoiceID` родителя. Ответ
 * `OK+InvoiceId` значит лишь «операция создана»: подписку продлевает уведомление ResultURL, а
 * неудача откладывается на сутки и после третьей попытки оставляет подписку истекать.
 *
 * Перед каждым списанием уходит письмо-предупреждение (376-ФЗ). Это не вежливость, а условие
 * списания: подписка без отправленного предупреждения в очередь на оплату не попадает.
 */

export type RenewalResult = { renewed: number; failed: number; skipped: boolean };

export async function renewDueSubscriptions(now = new Date(), charge = chargeRecurring): Promise<RenewalResult> {
  const config = robokassaConfig();
  if (!config.configured || !config.recurring) return { renewed: 0, failed: 0, skipped: true };
  const due = await listDueSubscriptions(now);
  let renewed = 0;
  let failed = 0;
  for (const record of due) {
    // Списание уже отправлено, но уведомление ещё не пришло: не выставляем второй счёт за тот же месяц.
    if (await hasPendingPayment(record.userId, "renewal", new Date(now.getTime() - 86_400_000).toISOString())) continue;
    const amount = planPriceRub(record.plan);
    if (!(amount > 0)) continue;
    const payment = await createPayment({
      userId: record.userId,
      plan: record.plan,
      amount,
      kind: "renewal",
      parentInvId: record.parentInvId,
      // Списываем только у подписки с включённым автопродлением: согласие уже дано человеком.
      autoRenew: true,
    });
    try {
      const result = await charge({
        config,
        invId: payment.invId,
        parentInvId: record.parentInvId,
        amount,
        // Тот же тариф и та же сумма, что в счёте: чек при автопродлении не должен
        // расходиться с первым платежом.
        planName: planDisplayName(record.plan),
        description: "Продление подписки NestDev «" + planDisplayName(record.plan) + "»",
      });
      if (result.ok) {
        renewed += 1;
        console.log("[billing] автопродление отправлено: счёт " + payment.invId + " для аккаунта " + record.userId);
      } else {
        failed += 1;
        await markPaymentFailed(payment.invId);
        const next = await postponeRenewal(record, now);
        console.error("[billing] автопродление не принято (" + result.status + "): " + result.text + "; следующая попытка " + next.renewsAt);
      }
    } catch (error) {
      failed += 1;
      await markPaymentFailed(payment.invId);
      const next = await postponeRenewal(record, now);
      console.error("[billing] автопродление не удалось: " + (error instanceof Error ? error.message : String(error)) + "; следующая попытка " + next.renewsAt);
    }
  }
  return { renewed, failed, skipped: false };
}

/**
 * Письма-предупреждения о предстоящем списании. Уходят раньше самих списаний, и до отправки
 * письма подписка не попадает в очередь на оплату — это и есть исполнение 376-ФЗ.
 */
export async function notifyUpcomingRenewals(
  now = new Date(),
  send: (record: SubscriptionRecord) => Promise<boolean> = sendRenewalNotice,
): Promise<{ notified: number }> {
  const config = robokassaConfig();
  if (!config.configured || !config.recurring) return { notified: 0 };
  const rows = await listSubscriptionsForNotice(now, renewalNoticeDays());
  let notified = 0;
  for (const record of rows) {
    try {
      if (!(await send(record))) {
        console.warn("[billing] предупреждение о списании не отправлено (у аккаунта нет почты): " + record.userId + "; списание не состоится");
        continue;
      }
      await markNoticeSent(record.userId, now);
      notified += 1;
      console.log("[billing] предупреждение о списании отправлено: аккаунт " + record.userId + ", срок " + record.renewsAt);
    } catch (error) {
      // Отказ почты не закрывает подписку: адрес может ожить, и письмо уйдёт в следующем цикле.
      console.error("[billing] предупреждение о списании не ушло: " + (error instanceof Error ? error.message : String(error)));
    }
  }
  return { notified };
}

/** Один цикл: сначала предупреждения, потом списания — именно в этом порядке их требует закон. */
export async function billingSweep(now = new Date()) {
  await notifyUpcomingRenewals(now);
  return renewDueSubscriptions(now);
}

let timer: NodeJS.Timeout | null = null;

/** Раз в час, а не раз в минуту: срок подписки измеряется днями, а лишние запросы к Робокассе не нужны. */
export function startBillingSweeper(intervalMs = Number(process.env.BILLING_SWEEP_MS ?? 3_600_000)) {
  if (timer) return;
  timer = setInterval(() => { void billingSweep().catch(error => console.error("[billing] цикл автопродления:", error)); }, Math.max(60_000, intervalMs));
  timer.unref();
}

export function stopBillingSweeper() {
  if (timer) clearInterval(timer);
  timer = null;
}
