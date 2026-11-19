import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth/auth.js";
import { listProjects } from "../project-store.js";
import { customDomainsEnabled } from "../hosting/domain-config.js";
import { domainsForSite } from "../hosting/domain-service.js";
import { hostingConfig, hostingSiteUrl } from "../hosting/config.js";
import { listSites } from "../hosting/site-store.js";
import type { CustomDomain, CustomDomainStatus } from "../hosting/domain-types.js";
import type { HostingSite } from "../hosting/types.js";

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

/**
 * Сводка хостинга аккаунта для боковой панели на главной. Отдаёт только собственные сайты
 * пользователя и публичные поля: внутренние пути, релизы и токены сюда не попадают.
 */
export async function registerAccountHostRoutes(app: FastifyInstance) {
  app.get("/api/account/hosts", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const [sites, projects] = await Promise.all([
      listSites({ userId: user.id, limit: 1_000 }),
      listProjects(user.id),
    ]);
    const projectNames = new Map(projects.map(project => [project.id, project.name]));
    const publicDomain = hostingConfig().publicDomain;
    const showCustomDomains = customDomainsEnabled();
    const visible = sites.filter((site): site is HostingSite & { status: AccountHost["status"] } => site.status !== "deleted");
    const hosts = await Promise.all(visible.map(async site => {
      const domains = showCustomDomains
        ? (await domainsForSite(site.id)).filter(domain => domain.userId === user.id)
        : [];
      return {
        projectId: site.projectId,
        projectName: projectNames.get(site.projectId) ?? "Проект",
        siteId: site.id,
        slug: site.slug,
        status: site.status,
        url: site.status === "live" && site.activeReleaseId ? hostingSiteUrl(site.slug, publicDomain) : null,
        customDomains: domains.map(publicAccountDomain),
      };
    }));
    return { domain: publicDomain, hosts };
  });
}

function publicAccountDomain(domain: CustomDomain) {
  return {
    hostname: domain.hostname,
    status: domain.status,
    isCanonical: domain.isCanonical,
  };
}
