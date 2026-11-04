import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getTable, initializeStorage, isYdbEnabled, ydbQuery } from "../storage/ydb.js";
import { hostingLimits } from "./config.js";
import {
  HostingBusyError,
  HostingError,
  type ActivateReleaseInput,
  type BeginPublishInput,
  type CreateSiteInput,
  type FailPublishInput,
  type FinishPublishInput,
  type HostingRelease,
  type HostingSite,
  type ReleaseStatus,
  type SiteStatus,
} from "./types.js";

/**
 * Хранилище сайтов и релизов.
 *
 * В PostgreSQL все решения о публикации принимаются внутри транзакции с `SELECT ... FOR UPDATE`
 * и частичным уникальным индексом `building` на сайт. Это работает и при нескольких репликах
 * API: in-memory lock здесь был бы ложной защитой. JSON-режим оставлен для локальной разработки
 * и тестов; он сериализуется внутри процесса и не предназначен для нескольких ВМ.
 */

export type SiteRow = {
  id: string;
  user_id: string;
  project_id: string;
  slug: string;
  status: string;
  active_release_id: string | null;
  publishing_release_id: string | null;
  node_id: string;
  last_error: string;
  suspend_reason: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  unpublished_at: string | null;
  suspended_at: string | null;
};

export type ReleaseRow = {
  id: string;
  site_id: string;
  user_id: string;
  status: string;
  kind: string;
  bytes: number | string | bigint;
  stored_bytes: number | string | bigint;
  files: number | string | bigint;
  sha256: string;
  manifest_json: string;
  storage_key: string;
  manifest_key: string;
  error: string;
  build_log: string;
  node_id: string;
  created_at: string;
  ready_at: string | null;
  activated_at: string | null;
  deleted_at: string | null;
};

export type SiteFilters = {
  status?: SiteStatus;
  userId?: string;
  limit?: number;
};

export type HostingSummary = {
  sites: number;
  live: number;
  releases: number;
  bytes: number;
  failures24h: number;
  lastPublishAt: string | null;
};

/** Компактный срез для `/api/health`: без обхода всех сайтов и их релизов. */
export type HostingHealth = Omit<HostingSummary, "sites"> & { sites: number };

function toNumber(value: number | string | bigint | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function siteFromRow(row: SiteRow): HostingSite {
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    slug: row.slug,
    status: row.status as SiteStatus,
    activeReleaseId: row.active_release_id,
    publishingReleaseId: row.publishing_release_id,
    nodeId: row.node_id,
    lastError: row.last_error ?? "",
    suspendReason: row.suspend_reason ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    unpublishedAt: row.unpublished_at,
    suspendedAt: row.suspended_at,
  };
}

export function releaseFromRow(row: ReleaseRow): HostingRelease {
  return {
    id: row.id,
    siteId: row.site_id,
    userId: row.user_id,
    status: row.status as ReleaseStatus,
    kind: (row.kind as HostingRelease["kind"]) ?? "",
    bytes: toNumber(row.bytes),
    storedBytes: toNumber(row.stored_bytes),
    files: toNumber(row.files),
    sha256: row.sha256 ?? "",
    manifestJson: row.manifest_json ?? "",
    storageKey: row.storage_key ?? "",
    manifestKey: row.manifest_key ?? "",
    error: row.error ?? "",
    buildLog: row.build_log ?? "",
    nodeId: row.node_id ?? "",
    createdAt: row.created_at,
    readyAt: row.ready_at,
    activatedAt: row.activated_at,
    deletedAt: row.deleted_at,
  };
}

function normalizeLimit(value: number | undefined, fallback: number, max: number) {
  if (!Number.isFinite(value) || !value || value <= 0) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

// ─── JSON fallback ────────────────────────────────────────────────────────────

type JsonState = {
  version: 1;
  sites: HostingSite[];
  releases: HostingRelease[];
};

const jsonQueues = new Map<string, Promise<unknown>>();

function jsonFile() {
  return path.join(process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev"), "hosting", "state.json");
}

function withJsonLock<T>(action: () => Promise<T>): Promise<T> {
  const file = jsonFile();
  const previous = jsonQueues.get(file) ?? Promise.resolve();
  const next = previous.then(action, action);
  jsonQueues.set(file, next.then(() => undefined, () => undefined));
  return next;
}

async function readJsonState(): Promise<JsonState> {
  try {
    const parsed = JSON.parse(await readFile(jsonFile(), "utf8")) as Partial<JsonState>;
    if (parsed.version !== 1 || !Array.isArray(parsed.sites) || !Array.isArray(parsed.releases)) {
      throw new Error("Повреждённое JSON-хранилище хостинга");
    }
    return { version: 1, sites: parsed.sites, releases: parsed.releases };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, sites: [], releases: [] };
    throw error;
  }
}

async function writeJsonState(state: JsonState) {
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

function requireSite(state: JsonState, siteId: string) {
  const site = state.sites.find(item => item.id === siteId);
  if (!site) throw new HostingError("SITE_NOT_FOUND", "Сайт не найден", 404);
  return site;
}

function requireRelease(state: JsonState, releaseId: string) {
  const release = state.releases.find(item => item.id === releaseId);
  if (!release) throw new HostingError("RELEASE_NOT_FOUND", "Релиз не найден", 404);
  return release;
}

// ─── PostgreSQL ───────────────────────────────────────────────────────────────

function sqlTable(name: string) {
  return ydbQuery().identifier(getTable(name));
}

async function pgSiteById(id: string): Promise<HostingSite | null> {
  await initializeStorage();
  const table = sqlTable("sites");
  const [rows] = await ydbQuery()<SiteRow[]>`
    SELECT id,user_id,project_id,slug,status,active_release_id,publishing_release_id,node_id,
           last_error,suspend_reason,created_at,updated_at,published_at,unpublished_at,suspended_at
      FROM ${table}
     WHERE id = ${id}
     LIMIT 1`;
  return rows[0] ? siteFromRow(rows[0]) : null;
}

async function pgSiteByProject(projectId: string): Promise<HostingSite | null> {
  await initializeStorage();
  const table = sqlTable("sites");
  const [rows] = await ydbQuery()<SiteRow[]>`
    SELECT id,user_id,project_id,slug,status,active_release_id,publishing_release_id,node_id,
           last_error,suspend_reason,created_at,updated_at,published_at,unpublished_at,suspended_at
      FROM ${table}
     WHERE project_id = ${projectId}
     LIMIT 1`;
  return rows[0] ? siteFromRow(rows[0]) : null;
}

async function pgSiteBySlug(slug: string): Promise<HostingSite | null> {
  await initializeStorage();
  const table = sqlTable("sites");
  const [rows] = await ydbQuery()<SiteRow[]>`
    SELECT id,user_id,project_id,slug,status,active_release_id,publishing_release_id,node_id,
           last_error,suspend_reason,created_at,updated_at,published_at,unpublished_at,suspended_at
      FROM ${table}
     WHERE slug = ${slug}
     LIMIT 1`;
  return rows[0] ? siteFromRow(rows[0]) : null;
}

async function pgRelease(id: string): Promise<HostingRelease | null> {
  await initializeStorage();
  const table = sqlTable("site_releases");
  const [rows] = await ydbQuery()<ReleaseRow[]>`
    SELECT id,site_id,user_id,status,kind,bytes,stored_bytes,files,sha256,manifest_json,
           storage_key,manifest_key,error,build_log,node_id,created_at,ready_at,activated_at,deleted_at
      FROM ${table}
     WHERE id = ${id}
     LIMIT 1`;
  return rows[0] ? releaseFromRow(rows[0]) : null;
}

async function pgReleases(siteId: string, limit = 20): Promise<HostingRelease[]> {
  await initializeStorage();
  const table = sqlTable("site_releases");
  const [rows] = await ydbQuery()<ReleaseRow[]>`
    SELECT id,site_id,user_id,status,kind,bytes,stored_bytes,files,sha256,manifest_json,
           storage_key,manifest_key,error,build_log,node_id,created_at,ready_at,activated_at,deleted_at
      FROM ${table}
     WHERE site_id = ${siteId}
     ORDER BY created_at DESC
     LIMIT ${limit}`;
  return rows.map(releaseFromRow);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getSite(id: string): Promise<HostingSite | null> {
  if (isYdbEnabled()) return pgSiteById(id);
  return withJsonLock(async () => (await readJsonState()).sites.find(site => site.id === id) ?? null);
}

export async function getSiteByProject(projectId: string): Promise<HostingSite | null> {
  if (isYdbEnabled()) return pgSiteByProject(projectId);
  return withJsonLock(async () => (await readJsonState()).sites.find(site => site.projectId === projectId) ?? null);
}

export async function getSiteBySlug(slug: string): Promise<HostingSite | null> {
  if (isYdbEnabled()) return pgSiteBySlug(slug);
  return withJsonLock(async () => (await readJsonState()).sites.find(site => site.slug === slug) ?? null);
}

export async function getRelease(id: string): Promise<HostingRelease | null> {
  if (isYdbEnabled()) return pgRelease(id);
  return withJsonLock(async () => (await readJsonState()).releases.find(release => release.id === id) ?? null);
}

export async function listReleases(siteId: string, limit = 20): Promise<HostingRelease[]> {
  if (isYdbEnabled()) return pgReleases(siteId, limit);
  return withJsonLock(async () => (await readJsonState()).releases
    .filter(release => release.siteId === siteId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, normalizeLimit(limit, 20, 100)));
}

export async function listSites(filters: SiteFilters = {}): Promise<HostingSite[]> {
  const limit = normalizeLimit(filters.limit, 100, 1_000);
  if (isYdbEnabled()) {
    await initializeStorage();
    const table = sqlTable("sites");
    const [rows] = filters.status
      ? filters.userId
        ? await ydbQuery()<SiteRow[]>`
            SELECT id,user_id,project_id,slug,status,active_release_id,publishing_release_id,node_id,
                   last_error,suspend_reason,created_at,updated_at,published_at,unpublished_at,suspended_at
              FROM ${table}
             WHERE status = ${filters.status} AND user_id = ${filters.userId}
             ORDER BY updated_at DESC LIMIT ${limit}`
        : await ydbQuery()<SiteRow[]>`
            SELECT id,user_id,project_id,slug,status,active_release_id,publishing_release_id,node_id,
                   last_error,suspend_reason,created_at,updated_at,published_at,unpublished_at,suspended_at
              FROM ${table}
             WHERE status = ${filters.status}
             ORDER BY updated_at DESC LIMIT ${limit}`
      : filters.userId
        ? await ydbQuery()<SiteRow[]>`
            SELECT id,user_id,project_id,slug,status,active_release_id,publishing_release_id,node_id,
                   last_error,suspend_reason,created_at,updated_at,published_at,unpublished_at,suspended_at
              FROM ${table}
             WHERE user_id = ${filters.userId}
             ORDER BY updated_at DESC LIMIT ${limit}`
        : await ydbQuery()<SiteRow[]>`
            SELECT id,user_id,project_id,slug,status,active_release_id,publishing_release_id,node_id,
                   last_error,suspend_reason,created_at,updated_at,published_at,unpublished_at,suspended_at
              FROM ${table}
             ORDER BY updated_at DESC LIMIT ${limit}`;
    return rows.map(siteFromRow);
  }
  return withJsonLock(async () => (await readJsonState()).sites
    .filter(site => (!filters.status || site.status === filters.status) && (!filters.userId || site.userId === filters.userId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit));
}

/**
 * Создаёт сайт или возвращает уже существующий. Удалённый сайт можно создать заново: строка
 * остаётся tombstone'ом для аудита, но получает новый slug и чистое состояние. Старый адрес
 * при этом не воскресает.
 */
export async function createSite(input: CreateSiteInput): Promise<HostingSite> {
  const { newHostingSlug } = await import("./slug.js");
  const now = new Date().toISOString();
  if (isYdbEnabled()) {
    await initializeStorage();
    const table = sqlTable("sites");
    const existing = await pgSiteByProject(input.projectId);
    if (existing && existing.status !== "deleted") return existing;
    if (existing?.status === "deleted") {
      // Tombstone остаётся строкой для аудита, но новый сайт получает новый slug и чистый
      // `current`. Старый адрес после этого не воскресает.
      const slug = newHostingSlug();
      const [rows] = await ydbQuery()<SiteRow[]>`
        UPDATE ${table}
           SET slug = ${slug}, status = 'draft', active_release_id = NULL, publishing_release_id = NULL,
               node_id = ${input.nodeId}, last_error = '', suspend_reason = '', updated_at = ${now},
               published_at = NULL, unpublished_at = NULL, suspended_at = NULL
         WHERE id = ${existing.id}
         RETURNING id,user_id,project_id,slug,status,active_release_id,publishing_release_id,node_id,
                   last_error,suspend_reason,created_at,updated_at,published_at,unpublished_at,suspended_at`;
      if (rows[0]) return siteFromRow(rows[0]);
      throw new HostingError("PUBLISH_FAILED", "Не удалось пересоздать сайт");
    }
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = newHostingSlug();
      try {
        const [rows] = await ydbQuery()<SiteRow[]>`
          INSERT INTO ${table}
            (id,user_id,project_id,slug,status,active_release_id,publishing_release_id,node_id,
             last_error,suspend_reason,created_at,updated_at,published_at,unpublished_at,suspended_at)
          VALUES (${existing?.id ?? randomUUID()},${input.userId},${input.projectId},${slug},'draft',NULL,NULL,
                  ${input.nodeId},'','',${existing?.createdAt ?? now},${now},NULL,NULL,NULL)
          ON CONFLICT (project_id) DO NOTHING
          RETURNING id,user_id,project_id,slug,status,active_release_id,publishing_release_id,node_id,
                    last_error,suspend_reason,created_at,updated_at,published_at,unpublished_at,suspended_at`;
        if (rows[0]) return siteFromRow(rows[0]);
        const raced = await pgSiteByProject(input.projectId);
        if (raced && raced.status !== "deleted") return raced;
      } catch (error) {
        lastError = error;
        if (!String((error as { code?: string }).code ?? "").includes("23505")) throw error;
      }
    }
    throw new HostingError("PUBLISH_FAILED", "Не удалось выделить уникальный адрес сайта: " + (lastError instanceof Error ? lastError.message : ""));
  }

  return withJsonLock(async () => {
    const state = await readJsonState();
    const existing = state.sites.find(site => site.projectId === input.projectId);
    if (existing && existing.status !== "deleted") return existing;
    let slug = newHostingSlug();
    for (let attempt = 0; attempt < 5 && state.sites.some(site => site.slug === slug); attempt++) slug = newHostingSlug();
    const site: HostingSite = existing
      ? { ...existing, slug, status: "draft", activeReleaseId: null, publishingReleaseId: null, nodeId: input.nodeId, lastError: "", suspendReason: "", updatedAt: now, publishedAt: null, unpublishedAt: null, suspendedAt: null }
      : {
          id: randomUUID(),
          userId: input.userId,
          projectId: input.projectId,
          slug,
          status: "draft",
          activeReleaseId: null,
          publishingReleaseId: null,
          nodeId: input.nodeId,
          lastError: "",
          suspendReason: "",
          createdAt: now,
          updatedAt: now,
          publishedAt: null,
          unpublishedAt: null,
          suspendedAt: null,
        };
    if (existing) Object.assign(state.sites[state.sites.indexOf(existing)], site);
    else state.sites.push(site);
    await writeJsonState(state);
    return site;
  });
}

export async function beginPublish(input: BeginPublishInput): Promise<{ site: HostingSite; release: HostingRelease }> {
  const now = new Date().toISOString();
  if (isYdbEnabled()) {
    await initializeStorage();
    let output: { site: HostingSite; release: HostingRelease } | null = null;
    const sites = sqlTable("sites");
    const releases = sqlTable("site_releases");
    await ydbQuery().transaction({}, async tx => {
      const [siteRows] = await tx<SiteRow[]>`
        SELECT id,user_id,project_id,slug,status,active_release_id,publishing_release_id,node_id,
               last_error,suspend_reason,created_at,updated_at,published_at,unpublished_at,suspended_at
          FROM ${sites} WHERE id = ${input.siteId} FOR UPDATE`;
      const row = siteRows[0];
      if (!row) throw new HostingError("SITE_NOT_FOUND", "Сайт не найден", 404);
      const site = siteFromRow(row);
      if (site.userId !== input.userId) throw new HostingError("SITE_NOT_FOUND", "Сайт не найден", 404);
      if (site.status === "suspended") throw new HostingError("SITE_SUSPENDED", "Сайт снят администратором", 409);
      if (site.status === "deleted") throw new HostingError("SITE_DELETED", "Сайт удалён", 410);
      if (site.publishingReleaseId) throw new HostingBusyError(site.id);
      const releaseId = randomUUID();
      const [releaseRows] = await tx<ReleaseRow[]>`
        INSERT INTO ${releases}
          (id,site_id,user_id,status,kind,bytes,stored_bytes,files,sha256,manifest_json,
           storage_key,manifest_key,error,build_log,node_id,created_at,ready_at,activated_at,deleted_at)
        VALUES (${releaseId},${site.id},${site.userId},'building',${input.kind},0,0,0,'','','','','','',${input.nodeId},${now},NULL,NULL,NULL)
        RETURNING id,site_id,user_id,status,kind,bytes,stored_bytes,files,sha256,manifest_json,
                  storage_key,manifest_key,error,build_log,node_id,created_at,ready_at,activated_at,deleted_at`;
      await tx`
        UPDATE ${sites}
           SET publishing_release_id = ${releaseId}, node_id = ${input.nodeId}, last_error = '', updated_at = ${now}
         WHERE id = ${site.id}`;
      output = {
        site: { ...site, publishingReleaseId: releaseId, nodeId: input.nodeId, lastError: "", updatedAt: now },
        release: releaseFromRow(releaseRows[0]),
      };
    });
    if (!output) throw new HostingBusyError(input.siteId);
    return output;
  }

  return withJsonLock(async () => {
    const state = await readJsonState();
    const site = requireSite(state, input.siteId);
    if (site.userId !== input.userId) throw new HostingError("SITE_NOT_FOUND", "Сайт не найден", 404);
    if (site.status === "suspended") throw new HostingError("SITE_SUSPENDED", "Сайт снят администратором", 409);
    if (site.status === "deleted") throw new HostingError("SITE_DELETED", "Сайт удалён", 410);
    if (site.publishingReleaseId) throw new HostingBusyError(site.id);
    const release: HostingRelease = {
      id: randomUUID(),
      siteId: site.id,
      userId: site.userId,
      status: "building",
      kind: input.kind,
      bytes: 0,
      storedBytes: 0,
      files: 0,
      sha256: "",
      manifestJson: "",
      storageKey: "",
      manifestKey: "",
      error: "",
      buildLog: "",
      nodeId: input.nodeId,
      createdAt: now,
      readyAt: null,
      activatedAt: null,
      deletedAt: null,
    };
    state.releases.push(release);
    Object.assign(site, { publishingReleaseId: release.id, nodeId: input.nodeId, lastError: "", updatedAt: now });
    await writeJsonState(state);
    return { site: { ...site }, release: { ...release } };
  });
}

export async function finishPublish(input: FinishPublishInput): Promise<{ site: HostingSite; release: HostingRelease }> {
  const now = new Date().toISOString();
  if (isYdbEnabled()) {
    await initializeStorage();
    let output: { site: HostingSite; release: HostingRelease } | null = null;
    const sites = sqlTable("sites");
    const releases = sqlTable("site_releases");
    await ydbQuery().transaction({}, async tx => {
      const [siteRows] = await tx<SiteRow[]>`
        SELECT id,user_id,project_id,slug,status,active_release_id,publishing_release_id,node_id,
               last_error,suspend_reason,created_at,updated_at,published_at,unpublished_at,suspended_at
          FROM ${sites} WHERE id = ${input.siteId} FOR UPDATE`;
      const row = siteRows[0];
      if (!row) throw new HostingError("SITE_NOT_FOUND", "Сайт не найден", 404);
      const site = siteFromRow(row);
      if (site.userId !== input.userId) throw new HostingError("SITE_NOT_FOUND", "Сайт не найден", 404);
      if (site.status === "suspended") throw new HostingError("SITE_SUSPENDED", "Сайт снят администратором", 409);
      if (site.status === "deleted") throw new HostingError("SITE_DELETED", "Сайт удалён", 410);
      if (site.publishingReleaseId !== input.releaseId) {
        throw new HostingError("RELEASE_NOT_FOUND", "Публикация больше не активна", 409);
      }
      const [releaseRows] = await tx<ReleaseRow[]>`
        UPDATE ${releases}
           SET status = 'ready', kind = ${input.kind}, bytes = ${input.bytes}, stored_bytes = ${input.storedBytes ?? 0},
               files = ${input.files}, sha256 = ${input.sha256}, manifest_json = ${input.manifestJson},
               storage_key = ${input.storageKey ?? ""}, manifest_key = ${input.manifestKey ?? ""},
               error = '', ready_at = ${now}, activated_at = ${now}, deleted_at = NULL
         WHERE id = ${input.releaseId} AND site_id = ${site.id} AND status = 'building'
         RETURNING id,site_id,user_id,status,kind,bytes,stored_bytes,files,sha256,manifest_json,
                   storage_key,manifest_key,error,build_log,node_id,created_at,ready_at,activated_at,deleted_at`;
      if (!releaseRows[0]) throw new HostingError("RELEASE_NOT_FOUND", "Релиз не найден", 404);
      const [updatedSiteRows] = await tx<SiteRow[]>`
        UPDATE ${sites}
           SET status = 'live', active_release_id = ${input.releaseId}, publishing_release_id = NULL,
               last_error = '', published_at = ${now}, unpublished_at = NULL, updated_at = ${now}
         WHERE id = ${site.id}
         RETURNING id,user_id,project_id,slug,status,active_release_id,publishing_release_id,node_id,
                   last_error,suspend_reason,created_at,updated_at,published_at,unpublished_at,suspended_at`;
      output = { site: siteFromRow(updatedSiteRows[0]), release: releaseFromRow(releaseRows[0]) };
    });
    if (!output) throw new HostingError("PUBLISH_FAILED", "Не удалось зафиксировать публикацию");
    return output;
  }

  return withJsonLock(async () => {
    const state = await readJsonState();
    const site = requireSite(state, input.siteId);
    if (site.userId !== input.userId) throw new HostingError("SITE_NOT_FOUND", "Сайт не найден", 404);
    if (site.status === "suspended") throw new HostingError("SITE_SUSPENDED", "Сайт снят администратором", 409);
    if (site.status === "deleted") throw new HostingError("SITE_DELETED", "Сайт удалён", 410);
    if (site.publishingReleaseId !== input.releaseId) throw new HostingError("RELEASE_NOT_FOUND", "Публикация больше не активна", 409);
    const release = requireRelease(state, input.releaseId);
    if (release.siteId !== site.id || release.status !== "building") throw new HostingError("RELEASE_NOT_FOUND", "Релиз не найден", 404);
    Object.assign(release, {
      status: "ready" satisfies ReleaseStatus,
      kind: input.kind,
      bytes: input.bytes,
      storedBytes: input.storedBytes ?? 0,
      files: input.files,
      sha256: input.sha256,
      manifestJson: input.manifestJson,
      storageKey: input.storageKey ?? "",
      manifestKey: input.manifestKey ?? "",
      error: "",
      readyAt: now,
      activatedAt: now,
      deletedAt: null,
    });
    Object.assign(site, {
      status: "live" satisfies SiteStatus,
      activeReleaseId: release.id,
      publishingReleaseId: null,
      lastError: "",
      publishedAt: now,
      unpublishedAt: null,
      updatedAt: now,
    });
    await writeJsonState(state);
    return { site: { ...site }, release: { ...release } };
  });
}

/**
 * Переключает активный релиз на уже готовый. Это не публикация: файлы не собираются и не
 * копируются. Ссылка `current` переключается вызывающим кодом до вызова; здесь фиксируется
 * намерение в БД с той же блокировкой сайта, что и у публикации.
 */
export async function activateRelease(input: ActivateReleaseInput): Promise<{ site: HostingSite; release: HostingRelease }> {
  const now = new Date().toISOString();
  if (isYdbEnabled()) {
    await initializeStorage();
    let output: { site: HostingSite; release: HostingRelease } | null = null;
    const sites = sqlTable("sites");
    const releases = sqlTable("site_releases");
    await ydbQuery().transaction({}, async tx => {
      const [siteRows] = await tx<SiteRow[]>`
        SELECT id,user_id,project_id,slug,status,active_release_id,publishing_release_id,node_id,
               last_error,suspend_reason,created_at,updated_at,published_at,unpublished_at,suspended_at
          FROM ${sites} WHERE id = ${input.siteId} FOR UPDATE`;
      const row = siteRows[0];
      if (!row) throw new HostingError("SITE_NOT_FOUND", "Сайт не найден", 404);
      const site = siteFromRow(row);
      if (site.userId !== input.userId) throw new HostingError("SITE_NOT_FOUND", "Сайт не найден", 404);
      if (site.status === "suspended") throw new HostingError("SITE_SUSPENDED", "Сайт снят администратором", 409);
      if (site.status === "deleted") throw new HostingError("SITE_DELETED", "Сайт удалён", 410);
      if (site.publishingReleaseId) throw new HostingBusyError(site.id);
      const [releaseRows] = await tx<ReleaseRow[]>`
        SELECT id,site_id,user_id,status,kind,bytes,stored_bytes,files,sha256,manifest_json,
               storage_key,manifest_key,error,build_log,node_id,created_at,ready_at,activated_at,deleted_at
          FROM ${releases}
         WHERE id = ${input.releaseId} AND site_id = ${site.id} AND status = 'ready'
         LIMIT 1`;
      if (!releaseRows[0]) throw new HostingError("RELEASE_NOT_READY", "Готовый релиз не найден", 404);
      const [updatedRows] = await tx<SiteRow[]>`
        UPDATE ${sites}
           SET status = 'live', active_release_id = ${input.releaseId}, publishing_release_id = NULL,
               last_error = '', unpublished_at = NULL, updated_at = ${now}
         WHERE id = ${site.id}
         RETURNING id,user_id,project_id,slug,status,active_release_id,publishing_release_id,node_id,
                   last_error,suspend_reason,created_at,updated_at,published_at,unpublished_at,suspended_at`;
      output = { site: siteFromRow(updatedRows[0]), release: releaseFromRow(releaseRows[0]) };
    });
    if (!output) throw new HostingError("PUBLISH_FAILED", "Не удалось переключить релиз");
    return output;
  }
  return withJsonLock(async () => {
    const state = await readJsonState();
    const site = requireSite(state, input.siteId);
    if (site.userId !== input.userId) throw new HostingError("SITE_NOT_FOUND", "Сайт не найден", 404);
    if (site.status === "suspended") throw new HostingError("SITE_SUSPENDED", "Сайт снят администратором", 409);
    if (site.status === "deleted") throw new HostingError("SITE_DELETED", "Сайт удалён", 410);
    if (site.publishingReleaseId) throw new HostingBusyError(site.id);
    const release = state.releases.find(item => item.id === input.releaseId && item.siteId === site.id);
    if (!release || release.status !== "ready") throw new HostingError("RELEASE_NOT_READY", "Готовый релиз не найден", 404);
    Object.assign(site, {
      status: "live" satisfies SiteStatus,
      activeReleaseId: release.id,
      publishingReleaseId: null,
      lastError: "",
      unpublishedAt: null,
      updatedAt: now,
    });
    await writeJsonState(state);
    return { site: { ...site }, release: { ...release } };
  });
}

export async function failPublish(input: FailPublishInput): Promise<void> {
  const now = new Date().toISOString();
  if (isYdbEnabled()) {
    await initializeStorage();
    const sites = sqlTable("sites");
    const releases = sqlTable("site_releases");
    await ydbQuery().transaction({}, async tx => {
      await tx`
        UPDATE ${releases}
           SET status = 'failed', error = ${input.error.slice(0, 4_000)}, build_log = ${(input.buildLog ?? "").slice(-16_000)}
         WHERE id = ${input.releaseId} AND status = 'building'`;
      await tx`
        UPDATE ${sites}
           SET publishing_release_id = NULL, last_error = ${input.error.slice(0, 1_000)}, updated_at = ${now}
         WHERE id = ${input.siteId} AND publishing_release_id = ${input.releaseId}`;
    });
    return;
  }
  await withJsonLock(async () => {
    const state = await readJsonState();
    const release = state.releases.find(item => item.id === input.releaseId);
    if (release && release.status === "building") {
      Object.assign(release, { status: "failed", error: input.error.slice(0, 4_000), buildLog: (input.buildLog ?? "").slice(-16_000) });
    }
    const site = state.sites.find(item => item.id === input.siteId);
    if (site && site.publishingReleaseId === input.releaseId) {
      Object.assign(site, { publishingReleaseId: null, lastError: input.error.slice(0, 1_000), updatedAt: now });
    }
    await writeJsonState(state);
  });
}

export async function unpublishSite(siteId: string, now = new Date().toISOString()): Promise<HostingSite | null> {
  return changeSiteStatus(siteId, "unpublished", { updatedAt: now, unpublishedAt: now, publishingReleaseId: null });
}

export async function suspendSite(siteId: string, reason: string, now = new Date().toISOString()): Promise<HostingSite | null> {
  return changeSiteStatus(siteId, "suspended", {
    updatedAt: now,
    suspendedAt: now,
    suspendReason: reason.slice(0, 500),
    unpublishedAt: now,
    publishingReleaseId: null,
  });
}

export async function restoreSite(siteId: string, now = new Date().toISOString()): Promise<HostingSite | null> {
  return changeSiteStatus(siteId, "live", {
    updatedAt: now,
    suspendedAt: null,
    suspendReason: "",
    unpublishedAt: null,
  });
}

async function changeSiteStatus(
  siteId: string,
  status: SiteStatus,
  extra: Partial<Pick<HostingSite, "updatedAt" | "publishedAt" | "unpublishedAt" | "suspendedAt" | "suspendReason" | "publishingReleaseId">>,
): Promise<HostingSite | null> {
  if (isYdbEnabled()) {
    await initializeStorage();
    const table = sqlTable("sites");
    const [rows] = await ydbQuery()<SiteRow[]>`
      UPDATE ${table}
         SET status = ${status},
             publishing_release_id = ${extra.publishingReleaseId === undefined ? null : extra.publishingReleaseId},
             updated_at = ${extra.updatedAt ?? new Date().toISOString()},
             unpublished_at = ${extra.unpublishedAt === undefined ? null : extra.unpublishedAt},
             suspended_at = ${extra.suspendedAt === undefined ? null : extra.suspendedAt},
             suspend_reason = ${extra.suspendReason ?? ""}
       WHERE id = ${siteId}
       RETURNING id,user_id,project_id,slug,status,active_release_id,publishing_release_id,node_id,
                 last_error,suspend_reason,created_at,updated_at,published_at,unpublished_at,suspended_at`;
    return rows[0] ? siteFromRow(rows[0]) : null;
  }
  return withJsonLock(async () => {
    const state = await readJsonState();
    const site = state.sites.find(item => item.id === siteId);
    if (!site) return null;
    Object.assign(site, { status }, extra);
    await writeJsonState(state);
    return { ...site };
  });
}

/**
 * Помечает сайт удалённым до удаления файлов. `active_release_id` очищается, чтобы
 * reconcile не пытался восстановить current; строки релизов получают `deleted`.
 */
export async function markSiteDeleted(siteId: string, now = new Date().toISOString()): Promise<HostingSite | null> {
  if (isYdbEnabled()) {
    await initializeStorage();
    let output: HostingSite | null = null;
    const sites = sqlTable("sites");
    const releases = sqlTable("site_releases");
    await ydbQuery().transaction({}, async tx => {
      await tx`UPDATE ${releases} SET status = 'deleted', deleted_at = ${now} WHERE site_id = ${siteId}`;
      const [rows] = await tx<SiteRow[]>`
        UPDATE ${sites}
           SET status = 'deleted', active_release_id = NULL, publishing_release_id = NULL, updated_at = ${now}
         WHERE id = ${siteId}
         RETURNING id,user_id,project_id,slug,status,active_release_id,publishing_release_id,node_id,
                   last_error,suspend_reason,created_at,updated_at,published_at,unpublished_at,suspended_at`;
      output = rows[0] ? siteFromRow(rows[0]) : null;
    });
    return output;
  }
  return withJsonLock(async () => {
    const state = await readJsonState();
    const site = state.sites.find(item => item.id === siteId);
    if (!site) return null;
    for (const release of state.releases) {
      if (release.siteId === siteId) Object.assign(release, { status: "deleted", deletedAt: now });
    }
    Object.assign(site, { status: "deleted", activeReleaseId: null, publishingReleaseId: null, updatedAt: now });
    await writeJsonState(state);
    return { ...site };
  });
}

/** Список готовых релизов, которые можно удалить, не трогая активный. */
export async function staleReleases(siteId: string, activeReleaseId: string | null, keep: number): Promise<HostingRelease[]> {
  const all = await listReleases(siteId, 100);
  const ready = all.filter(release => release.status === "ready" && release.id !== activeReleaseId);
  return ready.slice(Math.max(0, keep - (activeReleaseId ? 1 : 0)));
}

export async function markReleaseDeleted(releaseId: string): Promise<boolean> {
  if (isYdbEnabled()) {
    await initializeStorage();
    const [rows] = await ydbQuery()<Array<{ id: string }>>`
      UPDATE ${sqlTable("site_releases")}
         SET status = 'deleted', deleted_at = ${new Date().toISOString()}
       WHERE id = ${releaseId}
         AND NOT EXISTS (
           SELECT 1 FROM ${sqlTable("sites")} WHERE active_release_id = ${releaseId}
         )
       RETURNING id`;
    return rows.length > 0;
  }
  return withJsonLock(async () => {
    const state = await readJsonState();
    const release = state.releases.find(item => item.id === releaseId);
    if (!release) return false;
    const tag = state.sites.find(site => site.activeReleaseId === releaseId);
    if (tag || release.status !== "ready") return false;
    Object.assign(release, { status: "deleted", deletedAt: new Date().toISOString() });
    await writeJsonState(state);
    return true;
  });
}

/** Брошенные сборки после перезапуска сервера: не держат сайт в `building` навсегда. */
export async function markStaleBuilds(maxAgeMs = 30 * 60_000): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const now = new Date().toISOString();
  if (isYdbEnabled()) {
    await initializeStorage();
    const releases = sqlTable("site_releases");
    const sites = sqlTable("sites");
    let changed = 0;
    await ydbQuery().transaction({}, async tx => {
      const [rows] = await tx<Array<{ id: string; site_id: string }>>`
        UPDATE ${releases}
           SET status = 'failed', error = 'Сервер перезапустился во время публикации'
         WHERE status = 'building' AND created_at < ${cutoff}
         RETURNING id,site_id`;
      changed = rows.length;
      for (const row of rows) {
        await tx`
          UPDATE ${sites}
             SET publishing_release_id = NULL,
                 last_error = 'Сервер перезапустился во время публикации',
                 updated_at = ${now}
           WHERE id = ${row.site_id} AND publishing_release_id = ${row.id}`;
      }
    });
    return changed;
  }
  return withJsonLock(async () => {
    const state = await readJsonState();
    let changed = 0;
    for (const release of state.releases) {
      if (release.status !== "building" || release.createdAt >= cutoff) continue;
      Object.assign(release, { status: "failed", error: "Сервер перезапустился во время публикации" });
      const site = state.sites.find(item => item.id === release.siteId);
      if (site?.publishingReleaseId === release.id) {
        Object.assign(site, { publishingReleaseId: null, lastError: "Сервер перезапустился во время публикации", updatedAt: now });
      }
      changed++;
    }
    if (changed) await writeJsonState(state);
    return changed;
  });
}

/**
 * Метрики для внутреннего `/api/health`. В отличие от `hostingSummary`, это один агрегат
 * (в PostgreSQL) или один проход по JSON-состоянию, без N+1 запросов на каждый сайт: health
 * опрашивается часто и не должен сам создавать нагрузку на базу.
 */
export async function hostingHealth(): Promise<HostingHealth> {
  const cutoff = new Date(Date.now() - 86_400_000).toISOString();
  if (isYdbEnabled()) {
    await initializeStorage();
    const sites = sqlTable("sites");
    const releases = sqlTable("site_releases");
    const [rows] = await ydbQuery()<Array<{
      sites: number | string | bigint;
      live: number | string | bigint;
      releases: number | string | bigint;
      bytes: number | string | bigint;
      last_publish_at: string | null;
      failures24h: number | string | bigint;
    }>>`
      SELECT
        (SELECT count(*) FROM ${sites} WHERE status <> 'deleted') AS sites,
        (SELECT count(*) FROM ${sites} WHERE status = 'live') AS live,
        (SELECT count(*) FROM ${releases} r JOIN ${sites} s ON s.id = r.site_id
          WHERE r.status = 'ready' AND s.status <> 'deleted') AS releases,
        (SELECT COALESCE(sum(r.bytes), 0) FROM ${releases} r JOIN ${sites} s ON s.id = r.site_id
          WHERE r.status = 'ready' AND s.status <> 'deleted') AS bytes,
        (SELECT max(published_at) FROM ${sites} WHERE status <> 'deleted') AS last_publish_at,
        (SELECT count(*) FROM ${sites}
          WHERE status <> 'deleted' AND last_error <> '' AND updated_at > ${cutoff}) AS failures24h`;
    const row = rows[0];
    return {
      sites: toNumber(row?.sites),
      live: toNumber(row?.live),
      releases: toNumber(row?.releases),
      bytes: toNumber(row?.bytes),
      lastPublishAt: row?.last_publish_at ?? null,
      failures24h: toNumber(row?.failures24h),
    };
  }
  return withJsonLock(async () => {
    const state = await readJsonState();
    const visible = state.sites.filter(site => site.status !== "deleted");
    const visibleIds = new Set(visible.map(site => site.id));
    const ready = state.releases.filter(release => release.status === "ready" && visibleIds.has(release.siteId));
    const lastPublishAt = visible.reduce<string | null>(
      (latest, site) => (site.publishedAt && (!latest || site.publishedAt > latest) ? site.publishedAt : latest),
      null,
    );
    return {
      sites: visible.length,
      live: visible.filter(site => site.status === "live").length,
      releases: ready.length,
      bytes: ready.reduce((sum, release) => sum + release.bytes, 0),
      lastPublishAt,
      failures24h: visible.filter(site => site.lastError && site.updatedAt > cutoff).length,
    };
  });
}

export async function hostingSummary(): Promise<HostingSummary> {
  const sites = await listSites({ limit: 1_000 });
  const visible = sites.filter(site => site.status !== "deleted");
  let releases = 0;
  let bytes = 0;
  let lastPublishAt: string | null = null;
  for (const site of visible) {
    for (const release of await listReleases(site.id, 100)) {
      if (release.status !== "ready") continue;
      releases++;
      bytes += release.bytes;
    }
    if (site.publishedAt && (!lastPublishAt || site.publishedAt > lastPublishAt)) lastPublishAt = site.publishedAt;
  }
  const failures24h = visible.filter(site => site.lastError && site.updatedAt > new Date(Date.now() - 86_400_000).toISOString()).length;
  return {
    sites: visible.length,
    live: visible.filter(site => site.status === "live").length,
    releases,
    bytes,
    failures24h,
    lastPublishAt,
  };
}

/** Для тестов: JSON-хранилище не должно переживать тест. */
export async function resetHostingJsonStore() {
  await rm(jsonFile(), { force: true });
}
