import type { CustomDomain } from "../domain-types.js";
import { hostingSiteUrl } from "../config.js";
import type { HostingSite } from "../types.js";

/**
 * Основной адрес сайта. При активном canonical custom domain платформенный адрес — только
 * редирект; sitemap и robots обязаны называть тот же адрес, иначе Search Console увидит
 * два конкурирующих сайта.
 */
export function primaryHostname(input: {
  site: Pick<HostingSite, "slug">;
  domains: readonly CustomDomain[];
  publicDomain: string;
}): string {
  const canonical = input.domains.find(domain =>
    domain.status === "active" && domain.isCanonical,
  );
  return canonical?.hostname ?? input.site.slug + "." + input.publicDomain;
}

export function primarySiteUrl(input: {
  site: Pick<HostingSite, "slug">;
  domains: readonly CustomDomain[];
  publicDomain: string;
}): string {
  const canonical = input.domains.find(domain => domain.status === "active" && domain.isCanonical);
  return canonical ? "https://" + canonical.hostname : hostingSiteUrl(input.site.slug, input.publicDomain);
}
