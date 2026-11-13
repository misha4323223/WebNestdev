import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { customDomainVerificationHost } from "./domain-config.js";
import { HostingError } from "./types.js";
import type { CreateCustomDomainInput, CustomDomain, CustomDomainStatus } from "./domain-types.js";

/**
 * JSON-ветка нужна для разработки и unit-тестов. В production используется PostgreSQL:
 * две API-реплики не должны поддерживать согласованность через файл на одной машине.
 */

type JsonState = { version: 1; domains: CustomDomain[] };
const queues = new Map<string, Promise<unknown>>();

function jsonFile(): string {
  return path.join(process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev"), "hosting", "custom-domains.json");
}

function withLock<T>(action: () => Promise<T>): Promise<T> {
  const file = jsonFile();
  const previous = queues.get(file) ?? Promise.resolve();
  const next = previous.then(action, action);
  queues.set(file, next.then(() => undefined, () => undefined));
  return next;
}

async function readState(): Promise<JsonState> {
  try {
    const parsed = JSON.parse(await readFile(jsonFile(), "utf8")) as Partial<JsonState>;
    if (parsed.version !== 1 || !Array.isArray(parsed.domains)) throw new Error("Повреждённое JSON-хранилище доменов");
    return { version: 1, domains: parsed.domains };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, domains: [] };
    throw error;
  }
}

async function writeState(state: JsonState): Promise<void> {
  const file = jsonFile();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

function token(): string {
  return randomBytes(24).toString("base64url");
}

export async function listJsonDomains(): Promise<CustomDomain[]> {
  return withLock(async () => (await readState()).domains.slice());
}

export async function listJsonDomainsBySite(siteId: string): Promise<CustomDomain[]> {
  return withLock(async () => (await readState()).domains
    .filter(domain => domain.siteId === siteId)
    .sort((left, right) => Number(right.isCanonical) - Number(left.isCanonical) || left.createdAt.localeCompare(right.createdAt)));
}

export async function listJsonDomainsByGroup(groupId: string): Promise<CustomDomain[]> {
  return withLock(async () => (await readState()).domains
    .filter(domain => domain.groupId === groupId)
    .sort((left, right) => Number(right.isCanonical) - Number(left.isCanonical)));
}

export async function getJsonDomain(id: string): Promise<CustomDomain | null> {
  return withLock(async () => (await readState()).domains.find(domain => domain.id === id) ?? null);
}

export async function getJsonDomainByHostname(hostname: string): Promise<CustomDomain | null> {
  return withLock(async () => (await readState()).domains.find(domain => domain.hostname === hostname) ?? null);
}

export async function countJsonDomainGroups(siteId: string): Promise<number> {
  return withLock(async () => new Set((await readState()).domains.filter(domain => domain.siteId === siteId).map(domain => domain.groupId)).size);
}

export async function createJsonDomainGroup(input: CreateCustomDomainInput): Promise<CustomDomain[]> {
  if (!input.hostnames.length) throw new HostingError("DOMAIN_INVALID", "Нужен хотя бы один домен", 400);
  return withLock(async () => {
    const state = await readState();
    for (const item of input.hostnames) {
      if (state.domains.some(domain => domain.hostname === item.hostname)) {
        throw new HostingError("DOMAIN_TAKEN", "Этот домен уже подключён", 409);
      }
    }
    if (input.maxGroups !== undefined) {
      const groups = new Set(state.domains.filter(domain => domain.siteId === input.siteId).map(domain => domain.groupId)).size;
      if (groups >= input.maxGroups) {
        throw new HostingError("DOMAIN_LIMIT", "На этом тарифе можно подключить один свой домен к сайту", 409);
      }
    }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const groupId = randomUUID();
    const verificationToken = token();
    const canonicalHost = input.hostnames.find(item => item.kind === "apex")?.hostname ?? input.hostnames[0].hostname;
    const created = input.hostnames.map(item => ({
      id: randomUUID(),
      groupId,
      siteId: input.siteId,
      userId: input.userId,
      hostname: item.hostname,
      displayHostname: item.displayHostname,
      kind: item.kind,
      status: "pending_dns" as CustomDomainStatus,
      verificationToken,
      verificationHost: customDomainVerificationHost(item.hostname),
      verifiedAt: null,
      lastCheckedAt: null,
      lastError: "",
      certificateStatus: "none" as const,
      certificateError: "",
      isCanonical: item.hostname === canonicalHost,
      expiresAt,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }));
    state.domains.push(...created);
    await writeState(state);
    return created;
  });
}

export async function updateJsonDomain(
  id: string,
  patch: Partial<Pick<CustomDomain, "status" | "verifiedAt" | "lastCheckedAt" | "lastError" | "certificateStatus" | "certificateError" | "isCanonical">>,
): Promise<CustomDomain | null> {
  return withLock(async () => {
    const state = await readState();
    const domain = state.domains.find(item => item.id === id);
    if (!domain) return null;
    Object.assign(domain, patch, { updatedAt: new Date().toISOString() });
    await writeState(state);
    return domain;
  });
}

export async function setJsonCanonical(siteId: string, domainId: string): Promise<CustomDomain[]> {
  return withLock(async () => {
    const state = await readState();
    const target = state.domains.find(domain => domain.id === domainId && domain.siteId === siteId);
    if (!target) throw new HostingError("DOMAIN_NOT_FOUND", "Домен не найден", 404);
    for (const domain of state.domains) {
      if (domain.siteId === siteId && domain.groupId === target.groupId) {
        domain.isCanonical = domain.id === target.id;
        domain.updatedAt = new Date().toISOString();
      }
    }
    await writeState(state);
    return state.domains.filter(domain => domain.groupId === target.groupId);
  });
}

export async function deleteJsonDomainGroup(siteId: string, domainId: string): Promise<boolean> {
  return withLock(async () => {
    const state = await readState();
    const target = state.domains.find(domain => domain.id === domainId && domain.siteId === siteId);
    if (!target) return false;
    state.domains = state.domains.filter(domain => !(domain.siteId === siteId && domain.groupId === target.groupId));
    await writeState(state);
    return true;
  });
}

export async function deleteJsonDomainGroupsForSite(siteId: string): Promise<number> {
  return withLock(async () => {
    const state = await readState();
    const groups = new Set(state.domains.filter(domain => domain.siteId === siteId).map(domain => domain.groupId));
    if (!groups.size) return 0;
    state.domains = state.domains.filter(domain => domain.siteId !== siteId);
    await writeState(state);
    return groups.size;
  });
}

export async function transferJsonDomainOwners(siteIds: string[], fromUserId: string, toUserId: string): Promise<number> {
  if (!siteIds.length) return 0;
  const ids = new Set(siteIds);
  return withLock(async () => {
    const state = await readState();
    const groups = new Set<string>();
    for (const domain of state.domains) {
      if (domain.userId === fromUserId && ids.has(domain.siteId)) {
        domain.userId = toUserId;
        domain.updatedAt = new Date().toISOString();
        groups.add(domain.groupId);
      }
    }
    if (groups.size) await writeState(state);
    return groups.size;
  });
}

export async function resetJsonDomainStore(): Promise<void> {
  await withLock(async () => { await writeState({ version: 1, domains: [] }); });
}

