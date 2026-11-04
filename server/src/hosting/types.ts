/**
 * Модель статического хостинга.
 *
 * Сайт — это запись в базе плюс каталог релизов на диске. Он не является процессом и не
 * зависит от рабочей папки проекта. Один проект имеет ровно один сайт, один сайт — один
 * активный релиз.
 *
 * `node_id` хранится на сайте и релизе с первого дня. На одной ВМ это поле выглядит
 * избыточным, но именно оно не даёт второй реплике API молча решить, что файлы сайта лежат
 * на её локальном диске. Для нескольких ВМ нужен либо общий `SITES_DIR` (NFS/общий volume),
 * либо отдельный edge-узел, который умеет отдать сайт с того узла, где он собран. Без этого
 * поля такая ошибка обнаруживается только после переключения DNS.
 */

export type SiteStatus = "draft" | "live" | "unpublished" | "suspended" | "deleted";
export type ReleaseStatus = "building" | "ready" | "failed" | "deleted";
export type HostingProjectKind = "instant-site" | "static-build";

export type HostingSite = {
  id: string;
  userId: string;
  projectId: string;
  slug: string;
  status: SiteStatus;
  activeReleaseId: string | null;
  publishingReleaseId: string | null;
  nodeId: string;
  lastError: string;
  suspendReason: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  unpublishedAt: string | null;
  suspendedAt: string | null;
};

export type HostingRelease = {
  id: string;
  siteId: string;
  userId: string;
  status: ReleaseStatus;
  kind: HostingProjectKind | "";
  bytes: number;
  storedBytes: number;
  files: number;
  sha256: string;
  manifestJson: string;
  storageKey: string;
  manifestKey: string;
  error: string;
  buildLog: string;
  nodeId: string;
  createdAt: string;
  readyAt: string | null;
  activatedAt: string | null;
  deletedAt: string | null;
};

export type CreateSiteInput = {
  projectId: string;
  userId: string;
  nodeId: string;
};

export type BeginPublishInput = {
  siteId: string;
  userId: string;
  kind: HostingProjectKind;
  nodeId: string;
};

export type ActivateReleaseInput = {
  siteId: string;
  userId: string;
  releaseId: string;
};

export type FinishPublishInput = {
  siteId: string;
  releaseId: string;
  userId: string;
  kind: HostingProjectKind;
  bytes: number;
  files: number;
  sha256: string;
  manifestJson: string;
  storedBytes?: number;
  storageKey?: string;
  manifestKey?: string;
};

export type FailPublishInput = {
  siteId: string;
  releaseId: string;
  error: string;
  buildLog?: string;
};

export type HostingStateErrorCode =
  | "HOSTING_DISABLED"
  | "SITE_NOT_FOUND"
  | "SITE_BUSY"
  | "SITE_SUSPENDED"
  | "SITE_DELETED"
  | "RELEASE_NOT_FOUND"
  | "RELEASE_NOT_READY"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_NOT_STATIC"
  | "PROJECT_REMOTE"
  | "STORAGE_LIMIT"
  | "DISK_LIMIT"
  | "ARTIFACT_INVALID"
  | "BUILD_FAILED"
  | "PUBLISH_FAILED";

export class HostingError extends Error {
  constructor(
    readonly code: HostingStateErrorCode,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "HostingError";
  }
}

export class HostingBusyError extends HostingError {
  constructor(readonly siteId: string, message = "Публикация уже идёт") {
    super("SITE_BUSY", message, 409);
    this.name = "HostingBusyError";
  }
}

/** Внутренний результат, который не должен превращаться в утечку путей или секретов. */
export type PublishOutcome = {
  site: HostingSite;
  release: HostingRelease;
};

export type HostingLimits = {
  maxReleaseBytes: number;
  maxFileBytes: number;
  maxFiles: number;
  keepReleases: number;
  buildTimeoutMs: number;
  maxReleaseSeconds: number;
  buildConcurrency: number;
  globalBytes: number;
  minFreeBytes: number;
  maxSites: number;
};

export type HostingConfig = {
  enabled: boolean;
  publicDomain: string;
  tlsMode: "on_demand" | "wildcard";
  sitesDir: string;
  nodeId: string;
  sharedStorage: boolean;
  limits: HostingLimits;
};
