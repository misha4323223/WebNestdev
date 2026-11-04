import { apiJson } from "./api";

/** Ответ сервера без внутренних путей: только то, что можно показать в панели. */
export type HostingSite = {
  id: string;
  projectId: string;
  slug: string;
  status: "draft" | "live" | "unpublished" | "suspended" | "deleted";
  url: string | null;
  activeReleaseId: string | null;
  publishingReleaseId: string | null;
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
  status: "building" | "ready" | "failed" | "deleted";
  kind: "instant-site" | "static-build" | "";
  bytes: number;
  files: number;
  createdAt: string;
  readyAt: string | null;
  error: string;
  buildLog: string;
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

export type HostingState = {
  enabled: boolean;
  domain: string;
  tlsMode: "on_demand" | "wildcard";
  limits: HostingLimits;
  site: HostingSite | null;
  releases: HostingRelease[];
};

const base = (projectId: string) => "/api/projects/" + encodeURIComponent(projectId) + "/hosting";

export const getHosting = (projectId: string) => apiJson<HostingState>(base(projectId));

export const createHosting = (projectId: string) =>
  apiJson<{ site: HostingSite; enabled: boolean; domain: string }>(base(projectId), { method: "POST" });

export const publishHosting = (projectId: string) =>
  apiJson<{ site: HostingSite; release: HostingRelease }>(base(projectId) + "/publish", { method: "POST" });

export const unpublishHosting = (projectId: string) =>
  apiJson<HostingSite>(base(projectId) + "/unpublish", { method: "POST" });

export const rollbackHosting = (projectId: string, releaseId: string) =>
  apiJson<{ site: HostingSite; release: HostingRelease }>(
    base(projectId) + "/releases/" + encodeURIComponent(releaseId) + "/rollback",
    { method: "POST" },
  );

export const deleteHosting = (projectId: string) =>
  apiJson<{ deleted: boolean }>(base(projectId), { method: "DELETE" });

export const getHostingReleaseLog = (projectId: string, releaseId: string) =>
  apiJson<{ id: string; status: string; error: string; buildLog: string }>(
    base(projectId) + "/releases/" + encodeURIComponent(releaseId) + "/log",
  );
