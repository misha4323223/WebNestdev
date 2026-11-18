/**
 * Ежедневная проверка квот клиентских баз.
 *
 * Запускается на ВМ по таймеру (`webnestdev-client-db-quota.timer`): обходит учётную таблицу
 * `nestdev_admin.tenants`, берёт актуальный тариф аккаунта и переводит роль в read-only при
 * превышении. Клиентские URL при этом не меняются.
 *
 * Запуск: `CLIENT_DB_ADMIN_URL=… npx tsx src/scripts/client-db-quota.ts`
 */
import { accountPlanFor } from "../billing/store.js";
import { applyClientDatabaseQuotas, closeClientDatabasePool } from "../database/client-db/service.js";

try {
  const summary = await applyClientDatabaseQuotas(accountPlanFor);
  const over = summary.results.filter(item => item.readOnly);
  console.log(
    "[client-db-quota] проверено " + summary.checked + " баз, в read-only: " + over.length +
      (over.length ? " (" + over.map(item => item.accountId).join(", ") + ")" : ""),
  );
  for (const item of summary.results) {
    console.log(
      "[client-db-quota] " + item.accountId + ": " + item.usedBytes + " из " + item.quotaBytes +
        " байт" + (item.readOnly ? ", read-only" : ""),
    );
  }
} catch (error) {
  console.error("[client-db-quota] ошибка: " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
} finally {
  await closeClientDatabasePool();
}
