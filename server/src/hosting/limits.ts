import { statfs } from "node:fs/promises";
import path from "node:path";
import { accountPlanFor } from "../billing/store.js";
import { limitsForPlan } from "../account/plans.js";
import { getStorageSnapshot } from "../account/storage-quota.js";
import { hostingSitesDir } from "./config.js";
import { listSites } from "./site-store.js";
import { hostingBytesGlobal } from "./usage.js";
import type { HostingConfig } from "./types.js";
import { HostingError } from "./types.js";

export { hostingBytesForUser } from "./usage.js";

export async function hostingDiskFreeBytes(dir = hostingSitesDir()): Promise<number> {
  try {
    const info = await statfs(path.resolve(dir));
    const blockSize = Number(info.bsize);
    const available = Number(info.bavail);
    return Math.max(0, blockSize * available);
  } catch {
    return 0;
  }
}

export async function assertHostingDiskHasRoom(config: HostingConfig, incomingBytes: number): Promise<void> {
  const free = await hostingDiskFreeBytes(config.sitesDir);
  if (free > 0 && free - incomingBytes < config.limits.minFreeBytes) {
    throw new HostingError(
      "DISK_LIMIT",
      "На диске хостинга недостаточно места: свободно " + Math.round(free / 1024 / 1024) + " МиБ",
      507,
    );
  }
  const used = await hostingBytesGlobal();
  if (config.limits.globalBytes > 0 && used + incomingBytes > config.limits.globalBytes) {
    throw new HostingError("DISK_LIMIT", "Достигнут общий лимит хранилища сайтов", 507);
  }
}

/**
 * Квота аккаунта — общая с проектами. В `hostingBytes` считаются только `ready`-релизы,
 * как в плане; failed-релиз не должен блокировать пользователя после ошибки.
 */
export async function assertAccountHostingQuota(userId: string, incomingBytes: number): Promise<void> {
  const plan = await accountPlanFor(userId);
  const limit = limitsForPlan(plan).storageBytes;
  if (!limit || limit <= 0) return;
  // getStorageSnapshot уже включает `ready`-релизы сайтов (storage-quota вызывает
  // hostingBytesForUser). Здесь их нельзя прибавлять второй раз.
  const projects = await getStorageSnapshot(userId, plan);
  const after = projects.usedBytes + incomingBytes;
  if (after > limit) {
    throw new HostingError(
      "STORAGE_LIMIT",
      "Не хватает места в квоте: занято " + Math.round(projects.usedBytes / 1024 / 1024) + " МиБ из " + Math.round(limit / 1024 / 1024) + " МиБ",
      429,
    );
  }
}

export async function assertGlobalSiteLimit(config: HostingConfig): Promise<void> {
  if (!config.limits.maxSites) return;
  const sites = await listSites({ limit: 1_000 });
  const visible = sites.filter(site => site.status !== "deleted").length;
  if (visible >= config.limits.maxSites) {
    throw new HostingError("DISK_LIMIT", "Достигнут общий лимит числа сайтов", 507);
  }
}
