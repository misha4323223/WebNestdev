import { isYdbEnabled, ydbQuery, getTable } from "../storage/ydb.js";
import { listReleases, listSites } from "./site-store.js";

/**
 * Занятое место сайтами аккаунта. Отдельный модуль без импорта storage-quota:
 * `storage-quota` вызывает его для общей квоты, а `limits` — для проверки перед публикацией.
 * Иначе получился бы цикл, из-за которого квота в одном из путей считалась бы без сайтов.
 */
export async function hostingBytesForUser(userId: string): Promise<number> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{ bytes: string | number | bigint }>>`
      SELECT COALESCE(SUM(bytes), 0)::bigint AS bytes
        FROM ${ydbQuery().identifier(getTable("site_releases"))}
       WHERE user_id = ${userId} AND status = 'ready'`;
    return Number(rows[0]?.bytes ?? 0) || 0;
  }
  let total = 0;
  for (const site of await listSites({ userId, limit: 1_000 })) {
    for (const release of await listReleases(site.id, 100)) {
      if (release.status === "ready") total += release.bytes;
    }
  }
  return total;
}

export async function hostingBytesGlobal(): Promise<number> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{ bytes: string | number | bigint }>>`
      SELECT COALESCE(SUM(bytes), 0)::bigint AS bytes
        FROM ${ydbQuery().identifier(getTable("site_releases"))}
       WHERE status = 'ready'`;
    return Number(rows[0]?.bytes ?? 0) || 0;
  }
  let total = 0;
  for (const site of await listSites({ limit: 1_000 })) {
    for (const release of await listReleases(site.id, 100)) {
      if (release.status === "ready") total += release.bytes;
    }
  }
  return total;
}
