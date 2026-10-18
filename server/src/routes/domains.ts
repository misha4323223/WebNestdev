import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth/auth.js";
import { deleteDomainConnection, getDomainConnection, listDomainConnections, saveDomainConnection } from "../domains/connections.js";
import { DOMAIN_REGISTRARS, findDomainRegistrar, readRegistrarFields } from "../domains/providers.js";
import { verifyRegistrarCredential } from "../domains/verify.js";

/**
 * Коннекторы регистраторов доменов. Пароль или токен проверяется до сохранения: подключённым
 * считается только кабинет, который ответил списком доменов. Регистрация и оплата не
 * выполняются — платформа читает кабинет, но ничего в нём не меняет.
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
    try {
      fields = readRegistrarFields(registrar, (request.body as { fields?: unknown } | null)?.fields);
    } catch (error) {
      return reply.code(400).send({ error: messageOf(error) });
    }

    let verified: { account: string; domains: number };
    try {
      verified = await verifyRegistrarCredential(registrar.id, fields);
    } catch (error) {
      return reply.code(400).send({ error: messageOf(error) });
    }

    const existing = await getDomainConnection(user.id, registrar.id);
    const now = new Date().toISOString();
    await saveDomainConnection({
      userId: user.id,
      provider: registrar.id,
      secret: JSON.stringify(fields),
      account: verified.account,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return {
      id: registrar.id,
      name: registrar.name,
      connected: true,
      account: verified.account,
      domains: verified.domains,
      updatedAt: now,
    };
  });

  app.post("/api/domains/:provider/disconnect", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const registrar = registrarFrom(request.params);
    if (!registrar) return reply.code(404).send({ error: "Неизвестный регистратор" });
    await deleteDomainConnection(user.id, registrar.id);
    return { id: registrar.id, name: registrar.name, connected: false, account: null };
  });
}
