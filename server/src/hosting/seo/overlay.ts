import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { hostingPublicDomain } from "../config.js";
import { listDomainsBySite } from "../domain-store.js";
import type { ArtifactManifest } from "../artifact.js";
import { hostingSeoDir } from "../paths.js";
import { getRelease } from "../site-store.js";
import type { HostingRelease, HostingSite } from "../types.js";
import { primarySiteUrl } from "./primary-domain.js";
import { parseRouteManifest, routeManifestFromArtifact, type HostingRouteManifest } from "./route-manifest.js";
import { renderRobotsTxt, renderSitemapBundle } from "./sitemap.js";
import { googleVerificationBody, googleVerificationFile, readSeoSettings } from "./settings.js";

/**
 * Overlay — это два маленьких файла рядом с релизом, а не запись в релиз. Релиз
 * иммутабелен: rollback должен вернуть и HTML, и старые SEO-файлы. Sitemap всегда строится
 * из активного route manifest, поэтому после смены домена достаточно переписать overlay.
 */

async function writeAtomic(file: string, content: string) {
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, content, { encoding: "utf8", mode: 0o644 });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function manifestForRelease(release: HostingRelease): HostingRouteManifest | null {
  const stored = parseRouteManifest(release.routeManifestJson);
  if (stored) return stored;
  // Совместимость с релизами, опубликованными до появления route_manifest_json.
  if (!release.manifestJson) return null;
  try {
    const artifact = JSON.parse(release.manifestJson) as ArtifactManifest;
    if (!artifact || !Array.isArray(artifact.files)) return null;
    return routeManifestFromArtifact(artifact);
  } catch {
    return null;
  }
}

export async function writeSeoOverlay(input: {
  site: HostingSite;
  release: HostingRelease;
  publicDomain?: string;
}): Promise<{ origin: string; files: string[] } | null> {
  if (input.site.status !== "live" || input.release.status !== "ready") return null;
  const manifest = manifestForRelease(input.release);
  if (!manifest) return null;
  const domains = await listDomainsBySite(input.site.id);
  const origin = primarySiteUrl({
    site: input.site,
    domains,
    publicDomain: input.publicDomain ?? hostingPublicDomain(),
  });
  const dir = hostingSeoDir(input.site.slug);
  await mkdir(dir, { recursive: true, mode: 0o755 });
  const settings = await readSeoSettings(input.site.slug, input.site.effectiveRoutingMode ?? "spa");
  const bundle = renderSitemapBundle({
    origin,
    manifest,
    lastmod: input.release.activatedAt ?? input.release.readyAt,
    trailingSlash: settings.trailingSlash,
  });
  const files = ["sitemap.xml", "robots.txt"];
  // Куски пишем до index: иначе запрос между двумя rename увидит новый index,
  // который ссылается на ещё не созданный `sitemap-N.xml`.
  for (const chunk of bundle.chunks) {
    await writeAtomic(path.join(dir, chunk.name), chunk.content);
    files.push(chunk.name);
  }
  await writeAtomic(path.join(dir, "sitemap.xml"), bundle.index);
  await writeAtomic(path.join(dir, "robots.txt"), renderRobotsTxt({ origin }));

  // Старые куски могли остаться после уменьшения сайта или смены домена. Удаляем только
  // сгенерированные `sitemap-*.xml`, не пользовательские файлы релиза.
  const expected = new Set(files);
  for (const entry of await readdir(dir).catch(() => [])) {
    if (/^sitemap-\d+\.xml$/.test(entry) && !expected.has(entry)) {
      await rm(path.join(dir, entry), { force: true });
    }
  }

  // Search Console подтверждает владение HTML-файлом. Он лежит в overlay, а не в релизе:
  // пользователь может включить и выключить проверку без новой публикации.
  const verification = settings.googleVerification ? googleVerificationFile(settings.googleVerification) : "";
  if (verification) {
    await writeAtomic(path.join(dir, verification), googleVerificationBody(settings.googleVerification!));
    files.push(verification);
  }
  // Старый токен после замены не должен оставаться публичным файлом. Чистим все
  // google-файлы, которых нет в текущем наборе overlay.
  for (const entry of await readdir(dir).catch(() => [])) {
    if (/^google[A-Za-z0-9_-]+\.html$/.test(entry) && !files.includes(entry)) {
      await rm(path.join(dir, entry), { force: true });
    }
  }
  return { origin, files };
}

/** Пересобрать overlay из актуального active release; вызывается после публикации/rollback. */
export async function refreshSeoOverlay(site: HostingSite): Promise<{ origin: string; files: string[] } | null> {
  if (site.status !== "live" || !site.activeReleaseId) {
    await removeSeoOverlay(site.slug);
    return null;
  }
  const release = await getRelease(site.activeReleaseId);
  if (!release) {
    await removeSeoOverlay(site.slug);
    return null;
  }
  return writeSeoOverlay({ site, release });
}

export async function removeSeoOverlay(slug: string) {
  const dir = hostingSeoDir(slug);
  // settings.json принадлежит сайту и должен пережить unpublish: иначе после возврата сайта
  // пользователь потерял бы выбранную политику слешей и подтверждение Search Console.
  for (const entry of await readdir(dir).catch(() => [])) {
    if (entry === "settings.json") continue;
    await rm(path.join(dir, entry), { recursive: true, force: true });
  }
}
