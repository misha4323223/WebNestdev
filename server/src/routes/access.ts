import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireProjectUser } from "../auth/auth.js";
import { getProject } from "../project-store.js";
import { findAccessRequest, resolveAccessRequest, type AccessRequest } from "../access/pending-access.js";
import { resolveAccessTarget } from "../access/targets.js";
import { CLOUD_PROVIDERS, readCloudFields } from "../cloud/providers.js";
import { getCloudConnection, listCloudConnections, saveCloudConnection } from "../cloud/connections.js";
import { verifyCloudCredential } from "../cloud/verify.js";
import { DOMAIN_REGISTRARS, readRegistrarFields } from "../domains/providers.js";
import { getDomainConnection, listDomainConnections, saveDomainConnection } from "../domains/connections.js";
import { verifyRegistrarCredential } from "../domains/verify.js";
import { findService, resolveServiceFields } from "../services/catalog.js";
import { getServiceConnection, listServiceConnections, saveServiceConnection } from "../services/connections.js";
import { verifyServiceCredential } from "../services/verify.js";
import { saveDatabaseCredential } from "../database/database-api.js";
import { saveVerifiedYandexCredential } from "../yandex/yandex-api.js";
import { assertIntegrationSlot } from "../account/integration-limits.js";
import { accountPlanFor } from "../billing/store.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { isSameOriginRequest, sameOriginRefusal } from "../security/same-origin.js";

/**
 * Сохранение доступа, который агент попросил карточкой в чате.
 *
 * Значения приходят один раз, сразу уходят в зашифрованное хранилище интеграций и никогда не
 * возвращаются — ни в ответ маршрута, ни в разговор. Каждый тип доступа сохраняется тем же
 * кодом, что и карточка интеграции, поэтому проверка ключа, лимит тарифа и формат полей не
 * расходятся между двумя путями.
 */

const params = z.object({ id: z.string().min(1).max(200), requestId: z.string().min(1).max(100) });
const bodySchema = z.object({
  fields: z.record(z.string().max(128), z.string().max(8000)),
  allowWrites: z.boolean().optional(),
});
const cancelSchema = z.object({ id: z.string().min(1).max(200), requestId: z.string().min(1).max(100) });

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function guard(request: FastifyRequest, reply: FastifyReply) {
  applyNoStoreToReply(reply);
  if (!isSameOriginRequest(request)) {
    void reply.code(403).send({ error: sameOriginRefusal() });
    return false;
  }
  return true;
}

async function assertSlot(kind: "cloud" | "domains" | "services", userId: string, used: number, replacing: boolean) {
  await assertIntegrationSlot({ plan: await accountPlanFor(userId), kind, used, replacing });
}

async function saveAccess(userId: string, pending: AccessRequest, fields: Record<string, string>, allowWrites: boolean | undefined) {
  const target = resolveAccessTarget(pending.kind, pending.providerId);
  const now = new Date().toISOString();

  if (pending.kind === "cloud") {
    const provider = CLOUD_PROVIDERS.find(item => item.id === pending.providerId);
    if (!provider) throw new Error("Облако не найдено");
    const parsed = readCloudFields(provider, fields);
    const existing = await getCloudConnection(userId, provider.id);
    await assertSlot("cloud", userId, (await listCloudConnections(userId)).length, Boolean(existing));
    const verified = await verifyCloudCredential(provider.id, parsed);
    const writes = allowWrites ?? existing?.allowWrites ?? true;
    await saveCloudConnection({
      userId,
      provider: provider.id,
      secret: JSON.stringify(parsed),
      account: verified.account,
      allowWrites: writes,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return { name: provider.name, account: verified.account, allowWrites: writes };
  }

  if (pending.kind === "domain") {
    const registrar = DOMAIN_REGISTRARS.find(item => item.id === pending.providerId);
    if (!registrar) throw new Error("Регистратор не найден");
    const parsed = readRegistrarFields(registrar, fields);
    const existing = await getDomainConnection(userId, registrar.id);
    await assertSlot("domains", userId, (await listDomainConnections(userId)).length, Boolean(existing));
    const verified = await verifyRegistrarCredential(registrar.id, parsed);
    const writes = allowWrites ?? existing?.allowWrites ?? true;
    await saveDomainConnection({
      userId,
      provider: registrar.id,
      secret: JSON.stringify(parsed),
      account: verified.account,
      allowWrites: writes,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return { name: registrar.name, account: verified.account + (verified.domains ? " · доменов: " + verified.domains : ""), allowWrites: writes };
  }

  if (pending.kind === "service") {
    const service = findService(pending.providerId);
    if (!service) throw new Error("Сервис не найден");
    const parsed = resolveServiceFields(service, fields);
    const existing = await getServiceConnection(userId, service.id);
    await assertSlot("services", userId, (await listServiceConnections(userId)).length, Boolean(existing));
    let account = "Сохранено без проверки";
    if (service.verification === "check") account = (await verifyServiceCredential(service, parsed)).account;
    await saveServiceConnection({
      userId,
      service: service.id,
      secret: JSON.stringify(parsed),
      account,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return { name: service.name, account, allowWrites: null };
  }

  if (pending.kind === "database") {
    const url = String(fields.url ?? "").trim();
    if (!url) throw new Error("Вставьте строку подключения базы данных");
    const status = await saveDatabaseCredential(userId, { url });
    if (!status.connected) throw new Error("Строка подключения сохранена, но база не распознана");
    return { name: "База данных", account: status.engine + " · " + status.host, allowWrites: null };
  }

  if (pending.kind === "yandex") {
    const secret = String(fields.secret ?? "").trim();
    if (!secret) throw new Error("Вставьте ключ или токен Yandex Cloud");
    const status = await saveVerifiedYandexCredential(userId, secret, allowWrites ?? true);
    if (!status.connected) throw new Error("Yandex Cloud не подтвердил ключ");
    return { name: "Yandex Cloud", account: status.account ?? "Yandex Cloud", allowWrites: status.allowWrites };
  }

  throw new Error("Неизвестный тип доступа: " + target.kind);
}

export async function registerAccessRoutes(app: FastifyInstance) {
  app.post("/api/projects/:id/access/:requestId", async (request, reply) => {
    if (!guard(request, reply)) return;
    const { id, requestId } = params.parse(request.params);
    const user = await requireProjectUser(request, reply, id);
    if (!user) return;
    const project = await getProject(id);
    if (!project || project.userId !== user.id) return reply.code(404).send({ error: "Проект не найден" });

    const pending = findAccessRequest(requestId);
    // Чужой запрос не отличается от истёкшего: и то и другое — «окно устарело».
    if (!pending || pending.projectId !== id || pending.userId !== user.id) {
      return reply.code(404).send({ error: "Запрос доступа устарел — попросите агента запросить его снова" });
    }

    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(request.body ?? {});
    } catch (error) {
      return reply.code(400).send({ error: messageOf(error) });
    }

    try {
      const saved = await saveAccess(user.id, pending, body.fields, body.allowWrites);
      const delivered = resolveAccessRequest(pending.id, { ok: true, account: saved.account });
      return {
        ok: true,
        kind: pending.kind,
        provider: pending.providerId,
        name: saved.name,
        account: saved.account,
        allowWrites: saved.allowWrites,
        delivered,
      };
    } catch (error) {
      // Ошибка проверки оставляет карточку открытой: человек исправит поле и повторит,
      // а не начнёт разговор с агентом заново.
      const status = (error as { statusCode?: number })?.statusCode === 403 ? 403 : 400;
      return reply.code(status).send({ error: messageOf(error) });
    }
  });

  app.post("/api/projects/:id/access/:requestId/cancel", async (request, reply) => {
    if (!guard(request, reply)) return;
    const { id, requestId } = cancelSchema.parse(request.params);
    const user = await requireProjectUser(request, reply, id);
    if (!user) return;
    const project = await getProject(id);
    if (!project || project.userId !== user.id) return reply.code(404).send({ error: "Проект не найден" });
    const pending = findAccessRequest(requestId);
    if (!pending || pending.projectId !== id || pending.userId !== user.id) {
      return reply.code(404).send({ error: "Запрос доступа уже неактуален" });
    }
    resolveAccessRequest(pending.id, { ok: false, cancelled: true });
    return { cancelled: true };
  });
}
