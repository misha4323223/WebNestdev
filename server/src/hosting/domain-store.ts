import { isYdbEnabled } from "../storage/ydb.js";
import type { YdbQueryTag } from "../storage/pg.js";
import {
  countJsonDomainGroups,
  createJsonDomainGroup,
  deleteJsonDomainGroup,
  deleteJsonDomainGroupsForSite,
  getJsonDomain,
  getJsonDomainByHostname,
  listJsonDomains,
  listJsonDomainsByGroup,
  listJsonDomainsBySite,
  resetJsonDomainStore,
  setJsonCanonical,
  transferJsonDomainOwners,
  updateJsonDomain,
} from "./domain-store-json.js";
import {
  countPgDomainGroups,
  createPgDomainGroup,
  deletePgDomainGroup,
  deletePgDomainGroupsForSite,
  getPgDomain,
  getPgDomainByHostname,
  listPgDomains,
  listPgDomainsByGroup,
  listPgDomainsBySite,
  setPgCanonical,
  transferPgDomainOwners,
  updatePgDomain,
} from "./domain-store-pg.js";
import type { CreateCustomDomainInput, CustomDomain } from "./domain-types.js";
import { clearCustomDomainTlsCache } from "./tls-ask-cache.js";

/**
 * Единая точка доступа к доменам. Как и site-store, этот слой не знает о Fastify и
 * тарифах: маршруты и бизнес-проверки живут в отдельных модулях.
 */

export type CustomDomainPatch = Partial<Pick<
  CustomDomain,
  "status" | "verifiedAt" | "lastCheckedAt" | "lastError" | "certificateStatus" | "certificateError" | "isCanonical"
>>;

export async function listAllDomains(): Promise<CustomDomain[]> {
  return isYdbEnabled() ? listPgDomains() : listJsonDomains();
}

export async function listDomainsBySite(siteId: string): Promise<CustomDomain[]> {
  return isYdbEnabled() ? listPgDomainsBySite(siteId) : listJsonDomainsBySite(siteId);
}

export async function listDomainsByGroup(groupId: string): Promise<CustomDomain[]> {
  return isYdbEnabled() ? listPgDomainsByGroup(groupId) : listJsonDomainsByGroup(groupId);
}

export async function getDomain(id: string): Promise<CustomDomain | null> {
  return isYdbEnabled() ? getPgDomain(id) : getJsonDomain(id);
}

export async function getDomainByHostname(hostname: string): Promise<CustomDomain | null> {
  return isYdbEnabled() ? getPgDomainByHostname(hostname) : getJsonDomainByHostname(hostname);
}

export async function countDomainGroups(siteId: string): Promise<number> {
  return isYdbEnabled() ? countPgDomainGroups(siteId) : countJsonDomainGroups(siteId);
}

export async function createDomainGroup(input: CreateCustomDomainInput): Promise<CustomDomain[]> {
  const created = isYdbEnabled() ? await createPgDomainGroup(input) : await createJsonDomainGroup(input);
  clearCustomDomainTlsCache();
  return created;
}

export async function updateDomain(id: string, patch: CustomDomainPatch): Promise<CustomDomain | null> {
  const updated = isYdbEnabled() ? await updatePgDomain(id, patch) : await updateJsonDomain(id, patch);
  // `/api/tls-ask` кеширует ответ на несколько секунд; смена статуса должна быть видна
  // сразу, иначе после успешной проверки Caddy ещё получит старый отрицательный ответ.
  if (updated) clearCustomDomainTlsCache();
  return updated;
}

export async function setCanonical(siteId: string, domainId: string): Promise<CustomDomain[]> {
  const updated = isYdbEnabled() ? await setPgCanonical(siteId, domainId) : await setJsonCanonical(siteId, domainId);
  clearCustomDomainTlsCache();
  return updated;
}

export async function deleteDomainGroup(siteId: string, domainId: string): Promise<boolean> {
  const deleted = isYdbEnabled() ? await deletePgDomainGroup(siteId, domainId) : await deleteJsonDomainGroup(siteId, domainId);
  if (deleted) clearCustomDomainTlsCache();
  return deleted;
}

export async function deleteDomainGroupsForSite(siteId: string, tx?: YdbQueryTag): Promise<number> {
  return isYdbEnabled()
    ? deletePgDomainGroupsForSite(siteId, tx)
    : deleteJsonDomainGroupsForSite(siteId);
}

export async function transferDomainOwners(
  siteIds: string[],
  fromUserId: string,
  toUserId: string,
  tx?: YdbQueryTag,
): Promise<number> {
  return isYdbEnabled()
    ? transferPgDomainOwners(siteIds, fromUserId, toUserId, tx)
    : transferJsonDomainOwners(siteIds, fromUserId, toUserId);
}

export async function resetDomainStore(): Promise<void> {
  if (!isYdbEnabled()) await resetJsonDomainStore();
}
