import type { CustomDomain, CustomDomainStatus } from "./domain-types.js";
import type { CustomDomainCaddyRoute } from "./caddy-config.js";
import { isCustomDomainHostname, normalizeHostnameLookup } from "./domain-name.js";
import { isHostingSlug } from "./slug.js";
import type { HostingSite } from "./types.js";

/**
 * Превращает строки доменов в маршруты Caddy.
 *
 * В файл попадают только домены, для которых уже подтверждены владение, трафик и CAA
 * (`configuring` и дальше), и только при живом сайте с активным релизом. `verified` —
 * лишь TXT: маршрут до переключения трафика открыл бы чужой Host на нашем сервере.
 *
 * Канонический адрес выбирается внутри группы apex/www. Если канонический домен ещё не
 * прошёл проверки, каноническим становится первый готовый: нельзя оставить группу без
 * рабочего адреса, но и нельзя перенаправлять на домен, которого нет в конфиге.
 */

const ROUTABLE_STATUSES = new Set<CustomDomainStatus>([
  "configuring",
  "issuing_certificate",
  "active",
]);

export type CustomDomainRouteSource = {
  domains: readonly CustomDomain[];
  sites: readonly HostingSite[];
};

function validHostname(hostname: string): boolean {
  return isCustomDomainHostname(hostname) && normalizeHostnameLookup(hostname) === hostname;
}

export function buildCustomDomainRoutes(source: CustomDomainRouteSource): CustomDomainCaddyRoute[] {
  const liveSites = new Map<string, HostingSite>();
  for (const site of source.sites) {
    if (site.status !== "live" || !site.activeReleaseId || !isHostingSlug(site.slug)) continue;
    liveSites.set(site.id, site);
  }

  const groups = new Map<string, CustomDomain[]>();
  for (const domain of source.domains) {
    if (!ROUTABLE_STATUSES.has(domain.status) || !validHostname(domain.hostname)) continue;
    if (!liveSites.has(domain.siteId)) continue;
    const key = domain.groupId;
    const group = groups.get(key);
    if (group) group.push(domain);
    else groups.set(key, [domain]);
  }

  const routes: CustomDomainCaddyRoute[] = [];
  const usedHostnames = new Set<string>();
  for (const group of groups.values()) {
    const site = liveSites.get(group[0]!.siteId);
    if (!site) continue;
    const sorted = group
      .filter(domain => liveSites.get(domain.siteId)?.slug === site.slug)
      .sort((left, right) => Number(right.isCanonical) - Number(left.isCanonical) || left.hostname.localeCompare(right.hostname));
    const canonical = sorted.find(domain => domain.isCanonical) ?? sorted[0];
    if (!canonical) continue;
    for (const domain of sorted) {
      if (usedHostnames.has(domain.hostname)) continue;
      usedHostnames.add(domain.hostname);
      routes.push({
        hostname: domain.hostname,
        canonicalHostname: canonical.hostname,
        siteSlug: site.slug,
        isCanonical: domain === canonical,
      });
    }
  }
  return routes.sort((left, right) => left.hostname.localeCompare(right.hostname));
}
