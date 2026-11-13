import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { getSiteByProject } from "../hosting/site-store.js";
import { customDomainIp, customDomainTarget, customDomainsEnabled } from "../hosting/domain-config.js";
import { requestCustomDomainCaddyRefresh } from "../hosting/caddy-refresh.js";
import {
  createCustomDomains,
  domainsForSite,
  publicCustomDomain,
  removeDomainGroup,
  setCanonicalForSite,
  verifyDomainGroup,
} from "../hosting/domain-service.js";
import { HostingError } from "../hosting/types.js";
import { recordAudit } from "../security/audit-journal.js";
import { requireProject } from "./hosting.js";

/**
 * Маршруты custom domains отдельно от `/hosting`: файл хостинга уже содержит публикацию,
 * релизы и админку, и новые крупные блоки не должны делать его ещё больше.
 */

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof HostingError) {
    return reply.code(error.statusCode).send({ error: error.message, code: error.code });
  }
  throw error;
}

async function projectSite(request: unknown, reply: FastifyReply, projectId: string) {
  const auth = await requireProject(request, reply, projectId);
  if (!auth) return null;
  const site = await getSiteByProject(projectId);
  if (!site || site.userId !== auth.user.id || site.status === "deleted") {
    reply.code(404).send({ error: "Сначала создайте сайт", code: "SITE_NOT_FOUND" });
    return null;
  }
  return { ...auth, site };
}

function enabledReply(reply: FastifyReply) {
  if (customDomainsEnabled()) return true;
  reply.code(503).send({ error: "Подключение своих доменов временно выключено", code: "CUSTOM_DOMAINS_DISABLED" });
  return false;
}

export async function registerCustomDomainRoutes(app: FastifyInstance) {
  app.get("/api/projects/:id/hosting/domains", async (request, reply) => {
    if (!enabledReply(reply)) return;
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const owner = await projectSite(request, reply, params.id);
    if (!owner) return;
    const domains = await domainsForSite(owner.site.id);
    return reply.send({
      enabled: true,
      target: customDomainTarget(),
      ip: customDomainIp(),
      domains: domains.map(publicCustomDomain),
    });
  });

  app.post("/api/projects/:id/hosting/domains", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const owner = await projectSite(request, reply, params.id);
    if (!owner) return;
    if (!enabledReply(reply)) return;
    const body = z.object({
      hostname: z.string().trim().min(1).max(253),
      includeWww: z.boolean().optional(),
    }).parse(request.body ?? {});
    try {
      const domains = await createCustomDomains(owner.site, owner.user.id, body);
      requestCustomDomainCaddyRefresh("domain added");
      await recordAudit({
        action: "hosting.domain.added",
        actorType: "user",
        actorId: owner.user.id,
        actorLabel: owner.user.email,
        target: domains[0]?.id ?? owner.site.id,
        targetLabel: domains.map(domain => domain.hostname).join(", "),
        ip: request.ip,
      }).catch(() => undefined);
      return reply.code(201).send({
        domains: domains.map(publicCustomDomain),
        target: customDomainTarget(),
        ip: customDomainIp(),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/projects/:id/hosting/domains/:domainId/check", async (request, reply) => {
    if (!enabledReply(reply)) return;
    const params = z.object({ id: z.string().min(1), domainId: z.string().min(1) }).parse(request.params);
    const owner = await projectSite(request, reply, params.id);
    if (!owner) return;
    try {
      const result = await verifyDomainGroup(owner.site.id, params.domainId);
      requestCustomDomainCaddyRefresh("domain checked");
      await recordAudit({
        action: "hosting.domain.checked",
        actorType: "user",
        actorId: owner.user.id,
        actorLabel: owner.user.email,
        target: params.domainId,
        targetLabel: result.checks.map(check => check.hostname).join(", "),
        ip: request.ip,
      }).catch(() => undefined);
      return reply.send({
        domains: result.domains.map(publicCustomDomain),
        checks: result.checks,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch("/api/projects/:id/hosting/domains/:domainId", async (request, reply) => {
    if (!enabledReply(reply)) return;
    const params = z.object({ id: z.string().min(1), domainId: z.string().min(1) }).parse(request.params);
    const owner = await projectSite(request, reply, params.id);
    if (!owner) return;
    const body = z.object({ canonical: z.literal(true) }).parse(request.body ?? {});
    if (!body.canonical) return reply.code(400).send({ error: "Поддерживается только canonical=true" });
    try {
      const domains = await setCanonicalForSite(owner.site.id, params.domainId);
      requestCustomDomainCaddyRefresh("canonical changed");
      await recordAudit({
        action: "hosting.domain.canonical",
        actorType: "user",
        actorId: owner.user.id,
        actorLabel: owner.user.email,
        target: params.domainId,
        targetLabel: domains.find(domain => domain.id === params.domainId)?.hostname ?? "",
        ip: request.ip,
      }).catch(() => undefined);
      return reply.send({ domains: domains.map(publicCustomDomain) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete("/api/projects/:id/hosting/domains/:domainId", async (request, reply) => {
    if (!enabledReply(reply)) return;
    const params = z.object({ id: z.string().min(1), domainId: z.string().min(1) }).parse(request.params);
    const owner = await projectSite(request, reply, params.id);
    if (!owner) return;
    try {
      const deleted = await removeDomainGroup(owner.site.id, params.domainId);
      if (!deleted) return reply.code(404).send({ error: "Домен не найден", code: "DOMAIN_NOT_FOUND" });
      requestCustomDomainCaddyRefresh("domain removed");
      await recordAudit({
        action: "hosting.domain.removed",
        actorType: "user",
        actorId: owner.user.id,
        actorLabel: owner.user.email,
        target: params.domainId,
        targetLabel: "custom domain",
        ip: request.ip,
      }).catch(() => undefined);
      return reply.send({ deleted: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
