import { PLAN_CATALOG } from "../account/plans.js";
import { chargeRecurring, planPriceRub, robokassaConfig } from "./robokassa.js";
import { createPayment, hasPendingPayment, listDueSubscriptions, markPaymentFailed, postponeRenewal } from "./store.js";

/**
 * Автопродление подписок.
 *
 * Услуга «Периодические платежи» включается менеджером Робокассы, поэтому цикл работает только при
 * `ROBOKASSA_RECURRING=1`. Первый платёж серии помечен `Recurring=true` и запомнен как родительский
 * счёт; каждое следующее списание — новый счёт с `PreviousInvoiceID` родителя. Ответ
 * `OK+InvoiceId` значит лишь «операция создана»: подписку продлевает уведомление ResultURL, а
 * неудача откладывается на сутки и после третьей попытки оставляет подписку истекать.
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
    });
    try {
      const result = await charge({
        config,
        invId: payment.invId,
        parentInvId: record.parentInvId,
        amount,
        description: "Продление подписки NestDev «" + PLAN_CATALOG[record.plan].name + "»",
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

let timer: NodeJS.Timeout | null = null;

/** Раз в час, а не раз в минуту: срок подписки измеряется днями, а лишние запросы к Робокассе не нужны. */
export function startBillingSweeper(intervalMs = Number(process.env.BILLING_SWEEP_MS ?? 3_600_000)) {
  if (timer) return;
  timer = setInterval(() => { void renewDueSubscriptions().catch(error => console.error("[billing] цикл автопродления:", error)); }, Math.max(60_000, intervalMs));
  timer.unref();
}

export function stopBillingSweeper() {
  if (timer) clearInterval(timer);
  timer = null;
}
