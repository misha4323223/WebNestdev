import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth/auth.js";
import { SERVICE_CATEGORIES, SERVICES, findService, resolveServiceFields } from "../services/catalog.js";
import { deleteServiceConnection, getServiceConnection, listServiceConnections, saveServiceConnection } from "../services/connections.js";
import { verifyServiceCredential } from "../services/verify.js";
import { assertIntegrationSlot } from "../account/integration-limits.js";
import { accountPlanFor } from "../billing/store.js";

/**
 * Сервисы с ключом: файлы, почта, оплата, AI, карты, CRM. Ключ проверяется до сохранения везде,
 * где у провайдера есть безопасный читающий запрос; там, где его нет (Robokassa, Т-Банк),
 * карточка честно сохраняет без проверки — это видно в `verification`.
 */

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function serviceFrom(params: unknown) {
  const value = (params as { service?: unknown } | null)?.service;
  return typeof value === "string" ? findService(value) : undefined;
}

export async function registerServiceRoutes(app: FastifyInstance) {
  /** Все сервисы сразу: карточкам нужен один запрос, а не два десятка. */
  app.get("/api/services", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const connections = await listServiceConnections(user.id);
    return {
      categories: SERVICE_CATEGORIES,
      services: SERVICES.map(service => {
        const connection = connections.find(item => item.service === service.id);
        return {
          id: service.id,
          name: service.name,
          category: service.category,
          connected: Boolean(connection),
          account: connection?.account ?? null,
          updatedAt: connection?.updatedAt ?? null,
          verification: service.verification,
          verificationNote: service.verificationNote,
          env: service.env.map(entry => entry.name),
        };
      }),
    };
  });

  app.post("/api/services/:service", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const service = serviceFrom(request.params);
    if (!service) return reply.code(404).send({ error: "Неизвестный сервис" });

    let fields: Record<string, string>;
    try {
      fields = resolveServiceFields(service, (request.body as { fields?: unknown } | null)?.fields);
    } catch (error) {
      return reply.code(400).send({ error: messageOf(error) });
    }

    // Место в тарифе проверяется до пробного запроса к провайдеру: при достигнутом лимите
    // незачем ходить в чужой API и незачем показывать «ключ неверный» вместо причины.
    const existing = await getServiceConnection(user.id, service.id);
    try {
      assertIntegrationSlot({
        plan: await accountPlanFor(user.id),
        kind: "services",
        used: (await listServiceConnections(user.id)).length,
        replacing: Boolean(existing),
      });
    } catch (error) {
      return reply.code(403).send({ error: messageOf(error) });
    }

    let account = "Сохранено без проверки";
    if (service.verification === "check") {
      try {
        account = (await verifyServiceCredential(service, fields)).account;
      } catch (error) {
        return reply.code(400).send({ error: messageOf(error) });
      }
    }

    const now = new Date().toISOString();
    await saveServiceConnection({
      userId: user.id,
      service: service.id,
      secret: JSON.stringify(fields),
      account,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return { id: service.id, name: service.name, connected: true, account, verification: service.verification, updatedAt: now };
  });

  app.post("/api/services/:service/disconnect", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const service = serviceFrom(request.params);
    if (!service) return reply.code(404).send({ error: "Неизвестный сервис" });
    await deleteServiceConnection(user.id, service.id);
    return { id: service.id, name: service.name, connected: false, account: null };
  });
}
