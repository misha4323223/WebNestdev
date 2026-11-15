import { accountPlanFor } from "../billing/store.js";
import { getStorageSnapshot } from "../account/storage-quota.js";
import { MediaError } from "./media-store.js";

/**
 * Общая проверка квоты для медиа. Раньше она жила только в HTTP-маршруте загрузки, поэтому
 * серверная загрузка скриншота обошла бы лимит тарифа. Один helper используют и браузер,
 * и внутренний загрузчик.
 */
export async function assertMediaQuota(userId: string, addBytes: number) {
  if (addBytes <= 0) return;
  const plan = await accountPlanFor(userId);
  const { usedBytes, limitBytes } = await getStorageSnapshot(userId, plan);
  if (limitBytes <= 0) return;
  if (usedBytes + addBytes > limitBytes) {
    throw new MediaError(
      "MEDIA_QUOTA",
      "Файл не помещается в хранилище тарифа: занято " + Math.round(usedBytes / 1024 / 1024) +
        " МБ из " + Math.round(limitBytes / 1024 / 1024) + " МБ",
      429,
    );
  }
}
