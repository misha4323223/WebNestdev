import { hostingSiteLimitFor, type PlanId } from "../account/plans.js";
import { countSitesForUser } from "./site-store.js";
import { HostingError } from "./types.js";

/**
 * Лимит сайтов на аккаунт. Считаются и черновики, и опубликованные сайты: место занимает
 * сама запись сайта, а не только живой релиз. Удалённый сайт место освобождает.
 */
export async function assertHostingSiteSlot(userId: string, plan: PlanId): Promise<void> {
  const limit = hostingSiteLimitFor(plan);
  if (limit === null) return;
  const used = await countSitesForUser(userId);
  if (used < limit) return;
  throw new HostingError(
    "HOSTING_SITE_LIMIT",
    "На тарифе «Старт» можно держать один сайт. Удалите текущий сайт, чтобы создать новый, или перейдите на «Плюс» или «Премиум».",
    403,
  );
}
