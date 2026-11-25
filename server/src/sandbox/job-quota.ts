import { accountPlanFor } from "../billing/store.js";
import type { PlanId } from "../account/plans.js";
import { addSandboxSeconds, assertSandboxBudget } from "../account/resource-quota.js";

/**
 * Квота долгих заданий (`terminal.start`).
 *
 * Задание — это отдельный контейнер, который живёт до получаса. Раньше он не проходил ни проверку
 * дневного бюджета, ни списание секунд: тридцатиминутная сборка в фоне была бесплатной, а
 * пользователь узнавал о лимите только на обычной команде. Память при этом уже учитывалась
 * (`jobs.ts` резервирует её из общего бюджета) — не хватало именно минут.
 *
 * Здесь только учёт. Задание не встаёт в очередь аккаунта и никого не заставляет ждать: если бы
 * оно занимало место аккаунта, все обычные команды того же человека стояли бы за тридцатиминутной
 * сборкой. Поэтому проверка — мгновенная (исчерпан ли дневной лимит), а списание — по факту
 * времени жизни контейнера, без влияния на скорость запуска.
 *
 * Ошибка хранилища трактуется как «пропустить» — то же правило, что у обычных команд: недоступная
 * база не должна останавливать работу всем аккаунтам сразу.
 */

export async function assertSandboxJobBudget(userId: string): Promise<void> {
  if (!userId) return;
  let plan: PlanId;
  try {
    plan = await accountPlanFor(userId);
  } catch (error) {
    console.warn(
      "[quota] тариф аккаунта недоступен, проверка бюджета задания пропущена: " +
        (error instanceof Error ? error.message : String(error)),
    );
    return;
  }
  // `assertSandboxBudget` сам пропускает запуск при ошибке чтения счётчика (fail-open).
  await assertSandboxBudget(userId, plan);
}

/** Секунды жизни задания: столько же «CPU-минут», сколько списывает обычная команда. */
export function sandboxJobSeconds(startedAt: number, now = Date.now()): number {
  return Math.max(1, Math.round((now - startedAt) / 1000));
}

export async function chargeSandboxJob(userId: string, startedAt: number, now = Date.now()): Promise<void> {
  if (!userId) return;
  try {
    await addSandboxSeconds(userId, sandboxJobSeconds(startedAt, now), new Date(now));
  } catch (error) {
    // Задание уже выполнено: сбой учёта не должен превращаться в ошибку для пользователя.
    console.warn(
      "[quota] не удалось списать время долгого задания: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}
