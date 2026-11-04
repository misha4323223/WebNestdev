import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/auth.js";
import { getProject } from "../project-store.js";
import { hostingConfig, hostingSiteUrl } from "../hosting/config.js";
import { assertGlobalSiteLimit } from "../hosting/limits.js";
import { hostSlugForDomain } from "../hosting/slug.js";
import { startPublish, startRollback } from "../hosting/publisher.js";
import { removeCurrent } from "../hosting/paths.js";
import { reconcileSite } from "../hosting/reconcile.js";
import {
  createSite,
  getSite,
  getSiteByProject,
  getSiteBySlug,
  listReleases,
  markSiteDeleted,
  restoreSite,
  suspendSite,
  unpublishSite,
} from "../hosting/site-store.js";
import { HostingError, type HostingSite } from "../hosting/types.js";
import { recordAudit } from "../security/audit-journal.js";
import { requireAdmin } from "./admin.js";
import { previewHostTarget } from "../preview/preview-host.js";

/**
 * API хостинга. Панель работает только с проектом, а не с внутренним id сайта: у проекта
 * ровно один сайт, и это упрощает и права, и UI. Админские операции и `tls-ask` — отдельно.
 */

function publicSite(site: HostingSite, releases = false) {
  return {
    id: site.id,
    projectId: site.projectId,
    slug: site.slug,
    status: site.status,
    // `unpublished` — это зарезервированный адрес без текущей ссылки: показывать его как
    // рабочий URL значило бы обещать доступ, которого Caddy уже не отдаёт.
    url: site.status === "live" && site.activeReleaseId ? hostingSiteUrl(site.slug) : null,
    activeReleaseId: site.activeReleaseId,
    publishingReleaseId: site.publishingReleaseId,
    lastError: site.lastError,
    suspendReason: site.suspendReason,
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
    publishedAt: site.publishedAt,
    unpublishedAt: site.unpublishedAt,
    suspendedAt: site.suspendedAt,
    releases,
  };
}

function sendHostingError(reply: FastifyReply, error: unknown) {
  if (error instanceof HostingError) {
    return reply.code(error.statusCode).send({ error: error.message, code: error.code });
  }
  throw error;
}

async function requireProject(request: unknown, reply: FastifyReply, projectId: string) {
  const user = await requireUser(request as never, reply as never);
  if (!user) return null;
  const project = await getProject(projectId);
  if (!project || project.userId !== user.id) {
    reply.code(404).send({ error: "Проект не найден" });
    return null;
  }
  return { user, project };
}

export async function registerHostingRoutes(app: FastifyInstance) {
  app.get("/api/projects/:id/hosting", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const auth = await requireProject(request, reply, params.id);
    if (!auth) return;
    const config = hostingConfig();
    const site = await getSiteByProject(params.id);
    const releases = site ? await listReleases(site.id, config.limits.keepReleases + 10) : [];
    return {
      enabled: config.enabled,
      domain: config.publicDomain,
      tlsMode: config.tlsMode,
      limits: config.limits,
      site: site && site.userId === auth.user.id ? publicSite(site, true) : null,
      releases: site && site.userId === auth.user.id
        ? releases.map(release => ({
            id: release.id,
            status: release.status,
            kind: release.kind,
            bytes: release.bytes,
            files: release.files,
            createdAt: release.createdAt,
            readyAt: release.readyAt,
            error: release.error,
            buildLog: release.buildLog,
          }))
        : [],
    };
  });

  app.post("/api/projects/:id/hosting", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const auth = await requireProject(request, reply, params.id);
    if (!auth) return;
    const config = hostingConfig();
    if (!config.enabled) return reply.code(503).send({ error: "Хостинг выключен", code: "HOSTING_DISABLED" });
    try {
      const existing = await getSiteByProject(params.id);
      // Сайт должен создаваться на том узле, где лежат файлы проекта, иначе получится
      // запись, которую не сможет опубликовать ни один узел. При общем SANDBOX_DIR можно
      // оставить узел проекта: сборка прочитает общий каталог, а SITES_DIR общий отдельно.
      const siteNode = auth.project.node || config.nodeId;
      if (siteNode !== config.nodeId && !config.sharedStorage) {
        throw new HostingError(
          "PROJECT_REMOTE",
          "Проект закреплён за узлом " + siteNode + ". Создавайте сайт через узел проекта или включите общий SITES_DIR.",
          503,
        );
      }
      if (!existing || existing.status === "deleted") await assertGlobalSiteLimit(config);
      const site = await createSite({ projectId: params.id, userId: auth.user.id, nodeId: siteNode });
      await recordAudit({ action: "hosting.created", actorType: "user", actorId: auth.user.id, actorLabel: auth.user.email, target: site.id, targetLabel: site.slug, ip: request.ip }).catch(() => undefined);
      return reply.code(existing ? 200 : 201).send({ site: publicSite(site), enabled: config.enabled, domain: config.publicDomain });
    } catch (error) {
      return sendHostingError(reply, error);
    }
  });

  app.post("/api/projects/:id/hosting/publish", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const auth = await requireProject(request, reply, params.id);
    if (!auth) return;
    const site = await getSiteByProject(params.id);
    if (!site || site.userId !== auth.user.id) return reply.code(404).send({ error: "Сначала создайте сайт", code: "SITE_NOT_FOUND" });
    try {
      const started = await startPublish(site.id, auth.user.id);
      await recordAudit({ action: "hosting.publish.requested", actorType: "user", actorId: auth.user.id, actorLabel: auth.user.email, target: site.id, targetLabel: site.slug, ip: request.ip }).catch(() => undefined);
      return reply.code(202).send({
        site: publicSite(started.site),
        release: { id: started.release.id, status: started.release.status, kind: started.release.kind, createdAt: started.release.createdAt },
      });
    } catch (error) {
      return sendHostingError(reply, error);
    }
  });

  app.post("/api/projects/:id/hosting/releases/:releaseId/rollback", async (request, reply) => {
    const params = z.object({ id: z.string().min(1), releaseId: z.string().min(1) }).parse(request.params);
    const auth = await requireProject(request, reply, params.id);
    if (!auth) return;
    const site = await getSiteByProject(params.id);
    if (!site || site.userId !== auth.user.id) return reply.code(404).send({ error: "Сайт не найден", code: "SITE_NOT_FOUND" });
    try {
      const activated = await startRollback(site.id, auth.user.id, params.releaseId);
      await recordAudit({ action: "hosting.rolled.back", actorType: "user", actorId: auth.user.id, actorLabel: auth.user.email, target: site.id, targetLabel: site.slug + ": " + params.releaseId, ip: request.ip }).catch(() => undefined);
      return reply.send({
        site: publicSite(activated.site),
        release: { id: activated.release.id, status: activated.release.status, kind: activated.release.kind, createdAt: activated.release.createdAt },
      });
    } catch (error) {
      return sendHostingError(reply, error);
    }
  });

  app.post("/api/projects/:id/hosting/unpublish", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const auth = await requireProject(request, reply, params.id);
    if (!auth) return;
    const site = await getSiteByProject(params.id);
    if (!site || site.userId !== auth.user.id || site.status === "deleted") return reply.code(404).send({ error: "Сайт не найден" });
    const siteAfter = await unpublishSite(site.id);
    // Сначала фиксируем намерение в БД, затем снимаем symlink. Если упасть между этими
    // шагами, reconcile увидит `unpublished` и уберёт current. Ответ 500, а не 200, если
    // снять ссылку не удалось: иначе UI сказал бы «снят», а сайт продолжал бы открываться.
    try {
      await removeCurrent(site.slug);
    } catch (error) {
      console.warn("[hosting] не удалось снять current", error);
      return reply.code(500).send({
        error: "Сайт снят в базе, но файловая ссылка не удалена. Повторите снятие; reconcile также повторит очистку.",
        code: "UNPUBLISH_FAILED",
      });
    }
    await recordAudit({ action: "hosting.unpublished", actorType: "user", actorId: auth.user.id, actorLabel: auth.user.email, target: site.id, targetLabel: site.slug, ip: request.ip }).catch(() => undefined);
    return siteAfter ? publicSite(siteAfter) : { removed: true };
  });

  app.delete("/api/projects/:id/hosting", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const auth = await requireProject(request, reply, params.id);
    if (!auth) return;
    const site = await getSiteByProject(params.id);
    if (!site || site.userId !== auth.user.id) return reply.code(404).send({ error: "Сайт не найден" });
    await markSiteDeleted(site.id);
    await reconcileSite(site.id).catch(error => console.warn("[hosting] не удалось удалить файлы сайта", error));
    await recordAudit({ action: "hosting.deleted", actorType: "user", actorId: auth.user.id, actorLabel: auth.user.email, target: site.id, targetLabel: site.slug, ip: request.ip }).catch(() => undefined);
    return { deleted: true };
  });

  app.get("/api/projects/:id/hosting/releases/:releaseId/log", async (request, reply) => {
    const params = z.object({ id: z.string().min(1), releaseId: z.string().min(1) }).parse(request.params);
    const auth = await requireProject(request, reply, params.id);
    if (!auth) return;
    const site = await getSiteByProject(params.id);
    if (!site || site.userId !== auth.user.id) return reply.code(404).send({ error: "Сайт не найден" });
    const releases = await listReleases(site.id, 100);
    const release = releases.find(item => item.id === params.releaseId);
    if (!release) return reply.code(404).send({ error: "Релиз не найден" });
    return { id: release.id, status: release.status, error: release.error, buildLog: release.buildLog };
  });

  /**
   * Общий TLS-ask для двух поддоменных пространств (preview и hosting). У Caddy один
   * глобальный `on_demand_tls.ask`, поэтому endpoint обязан знать оба вида имён. Для
   * `draft`/`unpublished`/`suspended` сертификат не выдаётся: сайт ещё не должен быть
   * доступен, а лимит Let's Encrypt нельзя тратить на неопубликованное.
   */
  const tlsAsk = async (request: { query: unknown }, reply: FastifyReply) => {
    const parsed = z.object({ domain: z.string().min(1).max(255) }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Не передан domain" });
    const host = parsed.data.domain;
    const config = hostingConfig();
    const slug = hostSlugForDomain(host, config.publicDomain);
    if (slug) {
      const site = await getSiteBySlug(slug);
      if (!site || site.status !== "live" || !site.activeReleaseId) return reply.code(404).send({ error: "Сайт не найден" });
      return reply.send({ allowed: true, host, slug, kind: "site" });
    }
    const preview = previewHostTarget(host);
    if (!preview) return reply.code(404).send({ error: "Этот адрес не обслуживается" });
    const project = await getProject(preview.projectId);
    if (!project) return reply.code(404).send({ error: "Проект не найден" });
    return reply.send({ allowed: true, host, projectId: project.id, kind: "preview" });
  };
  app.get("/api/tls-ask", tlsAsk);
  app.get("/api/hosting/tls-ask", tlsAsk);

  // ─── admin ────────────────────────────────────────────────────────────────
  // Админ-маршруты используют Bearer-токен (как остальной /api/admin), а не cookie.
  app.get("/api/admin/hosting", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const { listSites, hostingSummary } = await import("../hosting/site-store.js");
    const sites = await listSites({ limit: 500 });
    return { summary: await hostingSummary(), sites: sites.map(site => publicSite(site)) };
  });

  app.post("/api/admin/hosting/sites/:siteId/suspend", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const params = z.object({ siteId: z.string().min(1) }).parse(request.params);
    const body = z.object({ reason: z.string().trim().min(3).max(500) }).parse(request.body);
    const current = await getSite(params.siteId);
    if (!current) return reply.code(404).send({ error: "Сайт не найден" });
    if (current.status === "deleted") return reply.code(410).send({ error: "Удалённый сайт нельзя приостановить", code: "SITE_DELETED" });
    const site = await suspendSite(params.siteId, body.reason);
    if (!site) return reply.code(404).send({ error: "Сайт не найден" });
    try {
      await removeCurrent(site.slug);
    } catch (error) {
      console.warn("[hosting] suspend: current не снят", error);
      return reply.code(500).send({
        error: "Сайт приостановлен в базе, но current не удалён. Повторите suspend или проверьте SITES_DIR.",
        code: "UNPUBLISH_FAILED",
      });
    }
    await recordAudit({ action: "hosting.suspended", actorType: "admin", actorId: admin.admin.id, actorLabel: admin.admin.email, target: site.id, targetLabel: site.slug + ": " + body.reason, ip: request.ip });
    return publicSite(site);
  });

  app.post("/api/admin/hosting/sites/:siteId/restore", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const params = z.object({ siteId: z.string().min(1) }).parse(request.params);
    const current = await getSite(params.siteId);
    if (!current) return reply.code(404).send({ error: "Сайт не найден" });
    if (current.status === "deleted") return reply.code(410).send({ error: "Удалённый сайт нельзя восстановить; создайте его заново", code: "SITE_DELETED" });
    const site = await restoreSite(params.siteId);
    if (!site) return reply.code(404).send({ error: "Сайт не найден" });
    // Возвращаем current только если активный релиз действительно есть на диске.
    const { restoreCurrent } = await import("../hosting/paths.js");
    if (site.activeReleaseId) await restoreCurrent(site.slug, site.activeReleaseId).catch(() => undefined);
    await recordAudit({ action: "hosting.restored", actorType: "admin", actorId: admin.admin.id, actorLabel: admin.admin.email, target: site.id, targetLabel: site.slug, ip: request.ip });
    return publicSite(site);
  });

  app.get("/api/admin/hosting/sites/:siteId/releases", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const params = z.object({ siteId: z.string().min(1) }).parse(request.params);
    const site = await getSite(params.siteId);
    if (!site) return reply.code(404).send({ error: "Сайт не найден" });
    const releases = await listReleases(site.id, 100);
    return { site: publicSite(site), releases };
  });
}
