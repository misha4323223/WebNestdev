import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { hostingSiteUrl } from "../config.js";
import type { CustomDomain } from "../domain-types.js";
import { hostingCdnConfig } from "../cdn-purge.js";
import { hostingCurrentLink, hostingReleaseDir, hostingSeoDir } from "../paths.js";
import { readRedirectsFromRelease } from "./redirects.js";
import { defaultTrailingSlash, googleVerificationFile, readSeoSettings, type HostingTrailingSlash } from "./settings.js";
import { getRelease, saveSeoAudit } from "../site-store.js";
import type { ArtifactManifest } from "../artifact.js";
import type { HostingRelease, HostingSite } from "../types.js";
import { auditSeoRelease, parseSeoAudit, type SeoAuditResult } from "./audit.js";
import { primarySiteUrl } from "./primary-domain.js";
import { parseRouteManifest, routeManifestFromArtifact, type HostingRouteManifest } from "./route-manifest.js";

export type HostingSeoView = {
  routingMode: string;
  effectiveRoutingMode: string;
  platformUrl: string;
  primaryUrl: string;
  canonicalHostname: string | null;
  sitemapUrl: string;
  robotsUrl: string;
  /** Пользовательский файл в релизе главнее overlay; UI не должен обещать управление им. */
  sitemapSource: "user" | "generated" | "missing";
  robotsSource: "user" | "generated" | "missing";
  sitemapManaged: boolean;
  robotsManaged: boolean;
  /** Один вариант trailing slash, который применяет Caddy. */
  trailingSlash: HostingTrailingSlash;
  /** Какой вариант был бы выбран по режиму, если пользователь ничего не менял. */
  defaultTrailingSlash: HostingTrailingSlash;
  /** Пользовательские редиректы из _redirects активного релиза. */
  redirects: { present: boolean; count: number; errors: string[] };
  /** Search Console: HTML-файл подтверждения сгенерирован. */
  googleVerification: boolean;
  /** Файл реально лежит в overlay, а не только сохранён в настройках. */
  googleVerificationReady: boolean;
  googleVerificationUrl: string | null;
  /** Сколько кусков sitemap index лежит в overlay; 0 — обычный sitemap. */
  sitemapChunks: number;
  /** Реальный purge после публикации, а не обещание «CDN будет» */
  cdn: { enabled: boolean; resource: string | null };
  has404: boolean;
  routes: number;
  audit: SeoAuditResult | null;
  auditAt: string | null;
  auditStale: boolean;
};

function manifestForRelease(release: HostingRelease | null): HostingRouteManifest | null {
  if (!release) return null;
  const stored = parseRouteManifest(release.routeManifestJson);
  if (stored) return stored;
  if (!release.manifestJson) return null;
  try {
    const artifact = JSON.parse(release.manifestJson) as ArtifactManifest;
    return Array.isArray(artifact.files) ? routeManifestFromArtifact(artifact) : null;
  } catch {
    return null;
  }
}

async function exists(file: string) {
  return access(file).then(() => true).catch(() => false);
}

export async function hostingSeoView(input: {
  site: HostingSite;
  domains: readonly CustomDomain[];
  publicDomain: string;
}): Promise<HostingSeoView> {
  const release = input.site.activeReleaseId ? await getRelease(input.site.activeReleaseId) : null;
  const manifest = manifestForRelease(release);
  const canonical = input.domains.find(domain => domain.status === "active" && domain.isCanonical) ?? null;
  const primaryUrl = primarySiteUrl({ site: input.site, domains: input.domains, publicDomain: input.publicDomain });
  const current = hostingCurrentLink(input.site.slug);
  const seoDir = hostingSeoDir(input.site.slug);
  const [userSitemap, userRobots, generatedSitemap, generatedRobots, settings, redirects, sitemapEntries] = await Promise.all([
    exists(path.join(current, "sitemap.xml")),
    exists(path.join(current, "robots.txt")),
    exists(path.join(seoDir, "sitemap.xml")),
    exists(path.join(seoDir, "robots.txt")),
    readSeoSettings(input.site.slug, input.site.effectiveRoutingMode ?? "spa"),
    readRedirectsFromRelease(current),
    readdir(seoDir).catch((): string[] => []),
  ]);
  const audit = parseSeoAudit(input.site.seoAuditJson);
  const effective = input.site.effectiveRoutingMode ?? "spa";
  const cdn = hostingCdnConfig();
  return {
    routingMode: input.site.routingMode ?? "spa",
    effectiveRoutingMode: effective,
    platformUrl: hostingSiteUrl(input.site.slug, input.publicDomain),
    primaryUrl,
    canonicalHostname: canonical?.hostname ?? null,
    sitemapUrl: primaryUrl + "/sitemap.xml",
    robotsUrl: primaryUrl + "/robots.txt",
    sitemapSource: userSitemap ? "user" : generatedSitemap ? "generated" : "missing",
    robotsSource: userRobots ? "user" : generatedRobots ? "generated" : "missing",
    sitemapManaged: !userSitemap && generatedSitemap,
    robotsManaged: !userRobots && generatedRobots,
    trailingSlash: settings.trailingSlash,
    defaultTrailingSlash: defaultTrailingSlash(effective),
    redirects: {
      present: redirects.present,
      count: redirects.rules.length,
      errors: redirects.errors.map(error => error.message),
    },
    googleVerification: Boolean(settings.googleVerification),
    googleVerificationReady: Boolean(settings.googleVerification && sitemapEntries.includes(googleVerificationFile(settings.googleVerification))),
    googleVerificationUrl: settings.googleVerification
      ? primaryUrl + "/google" + settings.googleVerification + ".html"
      : null,
    sitemapChunks: sitemapEntries.filter(entry => /^sitemap-\d+\.xml$/.test(entry)).length,
    cdn: { enabled: Boolean(cdn), resource: cdn?.resource ?? null },
    has404: manifest?.has404 ?? false,
    routes: manifest?.routes.length ?? 0,
    audit,
    auditAt: input.site.seoAuditAt ?? null,
    auditStale: Boolean(audit && (audit.mode !== effective || audit.origin !== primaryUrl)),
  };
}

export async function runHostingSeoAudit(input: {
  site: HostingSite;
  domains: readonly CustomDomain[];
  publicDomain: string;
}): Promise<{ view: HostingSeoView; audit: SeoAuditResult }> {
  if (!input.site.activeReleaseId) throw new Error("Сначала опубликуйте сайт");
  const release = await getRelease(input.site.activeReleaseId);
  if (!release || release.status !== "ready") throw new Error("Активный релиз не готов");
  const manifest = manifestForRelease(release);
  if (!manifest) throw new Error("Нет списка страниц: опубликуйте сайт заново");
  const primaryUrl = primarySiteUrl({ site: input.site, domains: input.domains, publicDomain: input.publicDomain });
  const audit = await auditSeoRelease({
    releaseDir: hostingReleaseDir(input.site.slug, release.id),
    seoDir: hostingSeoDir(input.site.slug),
    manifest,
    origin: primaryUrl,
    mode: input.site.effectiveRoutingMode ?? "spa",
  });
  await saveSeoAudit({
    siteId: input.site.id,
    userId: input.site.userId,
    auditJson: JSON.stringify(audit),
  });
  const fresh = { ...input.site, seoAuditJson: JSON.stringify(audit), seoAuditAt: audit.checkedAt };
  return {
    view: await hostingSeoView({ ...input, site: fresh }),
    audit,
  };
}
