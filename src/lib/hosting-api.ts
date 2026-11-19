import { apiJson } from "./api";
import type { CustomDomain, CustomDomainStatus } from "./custom-domains-api";

/** Ответ сервера без внутренних путей: только то, что можно показать в панели. */
export type HostingSite = {
  id: string;
  projectId: string;
  slug: string;
  status: "draft" | "live" | "unpublished" | "suspended" | "deleted";
  routingMode: HostingRoutingMode;
  effectiveRoutingMode: "static" | "spa" | "hybrid";
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
  kind: "instant-site" | "static-build" | "static-functions" | "";
  bytes: number;
  files: number;
  createdAt: string;
  readyAt: string | null;
  error: string;
  buildLog: string;
};

export type HostingRoutingMode = "auto" | "static" | "spa" | "hybrid";
export type HostingTrailingSlash = "always" | "never" | "ignore";

export type SeoAuditIssue = {
  id: string;
  level: "critical" | "warning" | "info";
  title: string;
  detail: string;
  url?: string;
};

export type HostingSeoAudit = {
  version: 1;
  checkedAt: string;
  mode: string;
  origin: string;
  pages: number;
  issues: SeoAuditIssue[];
};

export type HostingSeoView = {
  routingMode: HostingRoutingMode;
  effectiveRoutingMode: "static" | "spa" | "hybrid";
  platformUrl: string;
  primaryUrl: string;
  canonicalHostname: string | null;
  sitemapUrl: string;
  robotsUrl: string;
  sitemapSource: "user" | "generated" | "missing";
  robotsSource: "user" | "generated" | "missing";
  sitemapManaged: boolean;
  robotsManaged: boolean;
  trailingSlash: HostingTrailingSlash;
  defaultTrailingSlash: HostingTrailingSlash;
  redirects: { present: boolean; count: number; errors: string[] };
  googleVerification: boolean;
  googleVerificationReady: boolean;
  googleVerificationUrl: string | null;
  sitemapChunks: number;
  cdn: { enabled: boolean; resource: string | null };
  has404: boolean;
  routes: number;
  audit: HostingSeoAudit | null;
  auditAt: string | null;
  auditStale: boolean;
};

export type HostingProject = {
  kind: "instant-site" | "static-build" | "static-functions" | "unsupported" | "unknown";
  label: string;
  functions: number;
  jobs: number;
  /** Можно ли публиковать этот проект на текущем тарифе. */
  canPublish: boolean;
  /** Причина блокировки для человека; пустая строка, если публикация доступна. */
  reason: string;
};

export type HostingLimits = {
  maxReleaseBytes: number;
  maxFileBytes: number;
  maxFiles: number;
  keepReleases: number;
  keepLocalReleases: number;
  buildTimeoutMs: number;
  maxReleaseSeconds: number;
  buildConcurrency: number;
  globalBytes: number;
  minFreeBytes: number;
  maxSites: number;
};

/** Публичная сводка сайта для боковой панели аккаунта: без релизов и внутренних путей. */
export type AccountHost = {
  projectId: string;
  projectName: string;
  siteId: string;
  slug: string;
  status: Exclude<HostingSite["status"], "deleted">;
  url: string | null;
  customDomains: Array<{
    hostname: string;
    status: CustomDomainStatus;
    isCanonical: boolean;
  }>;
};

export type AccountHosts = {
  domain: string;
  hosts: AccountHost[];
};

export type HostingState = {
  enabled: boolean;
  domain: string;
  tlsMode: "on_demand" | "wildcard";
  limits: HostingLimits;
  customDomains: { enabled: boolean; limit: number };
  domains: CustomDomain[];
  /** Состав будущего релиза: статика или статика с функциями. */
  project: HostingProject;
  seo: HostingSeoView | null;
  site: HostingSite | null;
  releases: HostingRelease[];
};

const base = (projectId: string) => "/api/projects/" + encodeURIComponent(projectId) + "/hosting";

export const getHosting = (projectId: string) => apiJson<HostingState>(base(projectId));

export const getAccountHosts = () => apiJson<AccountHosts>("/api/account/hosts");

export const createHosting = (projectId: string, slug?: string) =>
  apiJson<{ site: HostingSite; enabled: boolean; domain: string }>(base(projectId), {
    method: "POST",
    ...(slug ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ slug }) } : {}),
  });

export const updateHostingSlug = (projectId: string, slug: string) =>
  apiJson<HostingSite>(base(projectId) + "/slug", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug }),
  });

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

export const getHostingSeo = (projectId: string) =>
  apiJson<HostingSeoView>(base(projectId) + "/seo");

export type HostingSeoUpdate = {
  routingMode?: HostingRoutingMode;
  trailingSlash?: HostingTrailingSlash;
  /** null удаляет HTML-файл подтверждения Search Console. */
  googleVerification?: string | null;
};

export const updateHostingSeo = (projectId: string, input: HostingRoutingMode | HostingSeoUpdate) =>
  apiJson<HostingSeoView>(base(projectId) + "/seo", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(typeof input === "string" ? { routingMode: input } : input),
  });

export const runHostingSeoAudit = (projectId: string) =>
  apiJson<{ view: HostingSeoView; audit: HostingSeoAudit }>(base(projectId) + "/seo/audit", { method: "POST" });

export const getHostingReleaseLog = (projectId: string, releaseId: string) =>
  apiJson<{ id: string; status: string; error: string; buildLog: string }>(
    base(projectId) + "/releases/" + encodeURIComponent(releaseId) + "/log",
  );
