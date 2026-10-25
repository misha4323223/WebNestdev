import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireProjectUser } from "../auth/auth.js";
import { getProject } from "../project-store.js";
import { getSandbox } from "../sandbox-manager.js";
import { readDeploymentProfile } from "../deployment/profile.js";
import { readDeployPlan } from "../deploy/deploy-plan.js";
import { CLOUD_PROVIDERS } from "../cloud/providers.js";
import { listCloudConnections } from "../cloud/connections.js";
import { DOMAIN_REGISTRARS } from "../domains/providers.js";
import { listDomainConnections } from "../domains/connections.js";
import { databaseStatus } from "../database/database-api.js";
import { SERVICES } from "../services/catalog.js";
import { listServiceConnections } from "../services/connections.js";
import { yandexStatus } from "../yandex/yandex-api.js";

/**
 * Профиль для квиза развёртывания.
 *
 * Один запрос отвечает на все вопросы окна: что за проект, какие сервисы ему действительно
 * нужны и что уже подключено. Отдельные запросы к облакам и регистраторам дублировали бы
 * проверку доступа и оставляли окно в состоянии «часть данных ещё едет». Ключи здесь не
 * возвращаются — только имена аккаунтов и факт подключения.
 */

export type DeploymentOptionsRouteDeps = {
  authorize: (request: unknown, reply: unknown, projectId: string) => Promise<{ id: string } | null>;
  getSandbox: (projectId: string, userId: string) => Promise<{ root: string }>;
};

const defaultDeps: DeploymentOptionsRouteDeps = {
  authorize: (request, reply, projectId) => requireProjectUser(request as never, reply as never, projectId),
  getSandbox: (projectId, userId) => getSandbox(projectId, userId),
};

const params = z.object({ id: z.string().min(1).max(200) });

export async function registerDeploymentRoutes(app: FastifyInstance, deps: DeploymentOptionsRouteDeps = defaultDeps) {
  app.get("/api/projects/:id/deployment/options", async (request, reply) => {
    const { id } = params.parse(request.params);
    const user = await deps.authorize(request, reply, id);
    if (!user) return;
    const project = await getProject(id);
    if (!project || project.userId !== user.id) return reply.code(404).send({ error: "Проект не найден" });

    const sandbox = await deps.getSandbox(id, user.id);
    const profile = await readDeploymentProfile(sandbox.root).catch(() => null);
    if (!profile) return reply.code(500).send({ error: "Не удалось прочитать проект" });

    const [cloudConnections, domainConnections, database, serviceConnections, yandex, plan] = await Promise.all([
      listCloudConnections(user.id).catch(() => []),
      listDomainConnections(user.id).catch(() => []),
      databaseStatus(user.id).catch(() => ({ connected: false as const })),
      listServiceConnections(user.id).catch(() => []),
      yandexStatus(user.id).catch(() => ({ connected: false as const })),
      readDeployPlan(sandbox.root).catch(() => null),
    ]);

    const neededCategories = new Set<string>();
    if (profile.needs.storage) neededCategories.add("storage");
    if (profile.needs.email) neededCategories.add("email");
    if (profile.needs.payments) neededCategories.add("payments");
    if (profile.needs.ai) neededCategories.add("ai");
    if (profile.needs.maps) neededCategories.add("maps");
    if (profile.needs.crm) neededCategories.add("crm");

    return {
      project: { id: project.id, name: project.name },
      projectType: profile.projectType,
      needs: profile.needs,
      needsEvidence: profile.needsEvidence,
      clouds: [
        {
          id: "yandex",
          name: "Yandex Cloud",
          connected: yandex.connected,
          account: yandex.connected ? yandex.account ?? null : null,
          allowWrites: yandex.connected ? yandex.allowWrites : null,
          keyUrl: "https://yandex.cloud/ru/docs/iam/operations/authentication/manage-authorized-keys",
          docsUrl: "https://yandex.cloud/ru/docs/",
        },
        ...CLOUD_PROVIDERS.map(provider => {
          const connection = cloudConnections.find(item => item.provider === provider.id);
          return {
            id: provider.id,
            name: provider.name,
            connected: Boolean(connection),
            account: connection?.account ?? null,
            allowWrites: connection ? connection.allowWrites : null,
            keyUrl: provider.keyUrl,
            docsUrl: provider.docsUrl,
          };
        }),
      ],
      domains: DOMAIN_REGISTRARS.map(registrar => {
        const connection = domainConnections.find(item => item.provider === registrar.id);
        return {
          id: registrar.id,
          name: registrar.name,
          connected: Boolean(connection),
          account: connection?.account ?? null,
          allowWrites: connection ? connection.allowWrites : null,
          keyUrl: registrar.keyUrl,
          docsUrl: registrar.docsUrl,
        };
      }),
      database,
      describeDatabase: [
        { id: "yandex-postgresql", name: "PostgreSQL в Yandex Cloud", note: "Кластер в вашем облаке." },
        { id: "yandex-ydb", name: "YDB в Yandex Cloud", note: "Оплата за запросы." },
        { id: "timeweb", name: "Timeweb Cloud", note: "PostgreSQL или MySQL." },
        { id: "vk", name: "VK Cloud", note: "PostgreSQL или MySQL." },
        { id: "selectel", name: "Selectel", note: "PostgreSQL или MySQL." },
        { id: "cloudru", name: "Cloud.ru", note: "PostgreSQL или MySQL." },
        { id: "custom", name: "Другая база", note: "Строка подключения из любого кабинета." },
      ],
      services: SERVICES.filter(service => neededCategories.has(service.category)).map(service => {
        const connection = serviceConnections.find(item => item.service === service.id);
        return {
          id: service.id,
          name: service.name,
          category: service.category,
          tagline: service.tagline,
          connected: Boolean(connection),
          account: connection?.account ?? null,
          preferred: profile.serviceIds.includes(service.id),
          env: service.env.map(entry => entry.name),
          keyUrl: service.keyUrl,
          docsUrl: service.docsUrl,
        };
      }),
      smsSupported: false,
      plan: plan && plan.exists && plan.total > 0
        ? { exists: true, total: plan.total, done: plan.done, complete: plan.complete, current: plan.current?.title ?? null }
        : { exists: false, total: 0, done: 0, complete: false, current: null },
    };
  });
}
