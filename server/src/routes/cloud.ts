import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/auth.js";
import { deleteCloudConnection, getCloudConnection, listCloudConnections, saveCloudConnection } from "../cloud/connections.js";
import { CLOUD_PROVIDERS, findCloudProvider, readCloudFields } from "../cloud/providers.js";
import { verifyCloudCredential } from "../cloud/verify.js";

/**
 * Облачные коннекторы. Ключ проверяется до сохранения: подключённым считается только то
 * облако, которое ответило на пробный запрос, — иначе карточка обещала бы доступ, которого нет.
 *
 * Разрешение на изменения приходит от пользователя вместе с подключением (`allowWrites`,
 * по умолчанию включено — карточка говорит об этом до нажатия «Сохранить») и меняется
 * маршрутом `/api/cloud/:provider/writes`. Сам ключ никогда не возвращается.
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
          allowWrites: connection?.allowWrites ?? true,
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
    let allowWrites: boolean | undefined;
    try {
      const body = z.object({ fields: z.unknown(), allowWrites: z.boolean().optional() }).parse(request.body ?? {});
      fields = readCloudFields(provider, body.fields);
      allowWrites = body.allowWrites;
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
    // Новое подключение разрешает изменения: карточка предупредила об этом до сохранения ключа.
    const writes = allowWrites ?? existing?.allowWrites ?? true;
    await saveCloudConnection({
      userId: user.id,
      provider: provider.id,
      secret: JSON.stringify(fields),
      account: verified.account,
      allowWrites: writes,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return { id: provider.id, name: provider.name, connected: true, account: verified.account, allowWrites: writes, updatedAt: now };
  });

  /** Изменения — решение пользователя: переключатель в карточке меняет только это поле. */
  app.post("/api/cloud/:provider/writes", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const provider = providerFrom(request.params);
    if (!provider) return reply.code(404).send({ error: "Неизвестное облако" });
    const parsed = z.object({ allowWrites: z.boolean() }).safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Ожидалось поле allowWrites: true или false" });
    const connection = await getCloudConnection(user.id, provider.id);
    if (!connection) return reply.code(400).send({ error: provider.name + " не подключён" });
    const now = new Date().toISOString();
    await saveCloudConnection({ ...connection, allowWrites: parsed.data.allowWrites, updatedAt: now });
    return { id: provider.id, name: provider.name, connected: true, account: connection.account, allowWrites: parsed.data.allowWrites, updatedAt: now };
  });

  app.post("/api/cloud/:provider/disconnect", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const provider = providerFrom(request.params);
    if (!provider) return reply.code(404).send({ error: "Неизвестное облако" });
    await deleteCloudConnection(user.id, provider.id);
    return { id: provider.id, name: provider.name, connected: false, account: null, allowWrites: true };
  });
}
