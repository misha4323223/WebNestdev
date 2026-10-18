import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth/auth.js";
import { deleteCloudConnection, getCloudConnection, listCloudConnections, saveCloudConnection } from "../cloud/connections.js";
import { CLOUD_PROVIDERS, findCloudProvider, readCloudFields } from "../cloud/providers.js";
import { verifyCloudCredential } from "../cloud/verify.js";

/**
 * Облачные коннекторы. Ключ проверяется до сохранения: подключённым считается только то
 * облако, которое ответило на пробный запрос, — иначе карточка обещала бы доступ, которого нет.
 */

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function providerFrom(params: unknown) {
  const value = (params as { provider?: unknown } | null)?.provider;
  return typeof value === "string" ? findCloudProvider(value) : undefined;
}

export async function registerCloudRoutes(app: FastifyInstance) {
  /** Все облака сразу: карточкам нужен один запрос, а не пять. */
  app.get("/api/cloud", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const connections = await listCloudConnections(user.id);
    return {
      providers: CLOUD_PROVIDERS.map(provider => {
        const connection = connections.find(item => item.provider === provider.id);
        return {
          id: provider.id,
          name: provider.name,
          connected: Boolean(connection),
          account: connection?.account ?? null,
          updatedAt: connection?.updatedAt ?? null,
        };
      }),
    };
  });

  app.post("/api/cloud/:provider", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const provider = providerFrom(request.params);
    if (!provider) return reply.code(404).send({ error: "Неизвестное облако" });

    let fields: Record<string, string>;
    try {
      fields = readCloudFields(provider, (request.body as { fields?: unknown } | null)?.fields);
    } catch (error) {
      return reply.code(400).send({ error: messageOf(error) });
    }

    let verified: { account: string };
    try {
      verified = await verifyCloudCredential(provider.id, fields);
    } catch (error) {
      return reply.code(400).send({ error: messageOf(error) });
    }

    const existing = await getCloudConnection(user.id, provider.id);
    const now = new Date().toISOString();
    await saveCloudConnection({
      userId: user.id,
      provider: provider.id,
      secret: JSON.stringify(fields),
      account: verified.account,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return { id: provider.id, name: provider.name, connected: true, account: verified.account, updatedAt: now };
  });

  app.post("/api/cloud/:provider/disconnect", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const provider = providerFrom(request.params);
    if (!provider) return reply.code(404).send({ error: "Неизвестное облако" });
    await deleteCloudConnection(user.id, provider.id);
    return { id: provider.id, name: provider.name, connected: false, account: null };
  });
}
