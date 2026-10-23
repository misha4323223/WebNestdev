import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/auth.js";
import { deleteDomainConnection, getDomainConnection, listDomainConnections, saveDomainConnection } from "../domains/connections.js";
import { DOMAIN_REGISTRARS, findDomainRegistrar, readRegistrarFields } from "../domains/providers.js";
import { verifyRegistrarCredential } from "../domains/verify.js";
import { assertIntegrationSlot } from "../account/integration-limits.js";
import { accountPlanFor } from "../billing/store.js";

/**
 * Коннекторы регистраторов доменов. Пароль или токен проверяется до сохранения: подключённым
 * считается только кабинет, который ответил списком доменов.
 *
 * Разрешение на изменения приходит от пользователя вместе с подключением (`allowWrites`, по
 * умолчанию включено — карточка говорит об этом до нажатия «Сохранить») и меняется маршрутом
 * `/api/domains/:provider/writes`. Без него агент читает кабинет, но не меняет DNS — так
 * пароль, выданный для проверки домена, не становится молча правом переписать зону. Покупка,
 * продление и перенос остаются действиями человека: для них у регистраторов нет безопасного
 * «разреши и забудь», а деньги агент не тратит.
 */

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function registrarFrom(params: unknown) {
  const value = (params as { provider?: unknown } | null)?.provider;
  return typeof value === "string" ? findDomainRegistrar(value) : undefined;
}

export async function registerDomainRoutes(app: FastifyInstance) {
  /** Все регистраторы сразу: карточкам нужен один запрос. */
  app.get("/api/domains", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const connections = await listDomainConnections(user.id);
    return {
      providers: DOMAIN_REGISTRARS.map(registrar => {
        const connection = connections.find(item => item.provider === registrar.id);
        return {
          id: registrar.id,
          name: registrar.name,
          connected: Boolean(connection),
          account: connection?.account ?? null,
          allowWrites: connection?.allowWrites ?? true,
          updatedAt: connection?.updatedAt ?? null,
        };
      }),
    };
  });

  app.post("/api/domains/:provider", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const registrar = registrarFrom(request.params);
    if (!registrar) return reply.code(404).send({ error: "Неизвестный регистратор" });

    let fields: Record<string, string>;
    let allowWrites: boolean | undefined;
    try {
      const body = z.object({ fields: z.unknown(), allowWrites: z.boolean().optional() }).parse(request.body ?? {});
      fields = readRegistrarFields(registrar, body.fields);
      allowWrites = body.allowWrites;
    } catch (error) {
      return reply.code(400).send({ error: messageOf(error) });
    }

    // Место на тарифе проверяется до пробного запроса: лимит — причина отказа, а не пароль.
    const existing = await getDomainConnection(user.id, registrar.id);
    try {
      assertIntegrationSlot({
        plan: await accountPlanFor(user.id),
        kind: "domains",
        used: (await listDomainConnections(user.id)).length,
        replacing: Boolean(existing),
      });
    } catch (error) {
      return reply.code(403).send({ error: messageOf(error) });
    }

    let verified: { account: string; domains: number };
    try {
      verified = await verifyRegistrarCredential(registrar.id, fields);
    } catch (error) {
      return reply.code(400).send({ error: messageOf(error) });
    }

    const now = new Date().toISOString();
    // Новое подключение разрешает изменения: карточка предупредила об этом до сохранения ключа.
    const writes = allowWrites ?? existing?.allowWrites ?? true;
    await saveDomainConnection({
      userId: user.id,
      provider: registrar.id,
      secret: JSON.stringify(fields),
      account: verified.account,
      allowWrites: writes,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return {
      id: registrar.id,
      name: registrar.name,
      connected: true,
      account: verified.account,
      allowWrites: writes,
      domains: verified.domains,
      updatedAt: now,
    };
  });

  /** Изменения — решение пользователя: переключатель в карточке меняет только это поле. */
  app.post("/api/domains/:provider/writes", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const registrar = registrarFrom(request.params);
    if (!registrar) return reply.code(404).send({ error: "Неизвестный регистратор" });
    const parsed = z.object({ allowWrites: z.boolean() }).safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Ожидалось поле allowWrites: true или false" });
    const connection = await getDomainConnection(user.id, registrar.id);
    if (!connection) return reply.code(400).send({ error: registrar.name + " не подключён" });
    const now = new Date().toISOString();
    await saveDomainConnection({ ...connection, allowWrites: parsed.data.allowWrites, updatedAt: now });
    return { id: registrar.id, name: registrar.name, connected: true, account: connection.account, allowWrites: parsed.data.allowWrites, updatedAt: now };
  });

  app.post("/api/domains/:provider/disconnect", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const registrar = registrarFrom(request.params);
    if (!registrar) return reply.code(404).send({ error: "Неизвестный регистратор" });
    await deleteDomainConnection(user.id, registrar.id);
    return { id: registrar.id, name: registrar.name, connected: false, account: null, allowWrites: true };
  });
}
