import { z } from "zod";
import { registerTool } from "../tool-registry.js";
import { cloudFetch } from "../cloud/api.js";
import { listCloudConnections } from "../cloud/connections.js";
import { CLOUD_PROVIDERS } from "../cloud/providers.js";

/**
 * Облака, подключённые пользователем. Агент видит их через эти два инструмента: список
 * подключений и запрос к API. Отдельные инструменты на каждый сервис (список серверов, бакетов)
 * не нужны — их пути и так есть в документации провайдера, а один запрос покрывает всё.
 *
 * Записи пока нет: `cloud.request` принимает только GET/HEAD, а попытка изменить ресурс
 * возвращает понятную причину. Так ключ пользователя не может ничего сломать без согласия.
 */

const requestSchema = z.object({
  provider: z.enum(["timeweb", "cloudru", "mws"]),
  method: z.enum(["GET", "HEAD"]).optional(),
  path: z.string().min(1).max(1000),
  host: z.string().max(120).optional(),
});

registerTool({
  name: "cloud.status",
  description:
    "List the clouds the user connected in Integrations (Timeweb Cloud, Cloud.ru, MWS) with the account each key belongs to. " +
    "Call it before working with a cloud to see what is actually available, and after a cloud call says the cloud is not connected. " +
    "It never returns the credential itself.",
  execute: async (_input, context) => {
    const connections = await listCloudConnections(context.userId);
    const connected = connections.map(connection => ({
      provider: connection.provider,
      name: CLOUD_PROVIDERS.find(provider => provider.id === connection.provider)?.name ?? connection.provider,
      account: connection.account,
      connectedAt: connection.updatedAt,
    }));
    const missing = CLOUD_PROVIDERS.filter(provider => !connections.some(connection => connection.provider === provider.id)).map(provider => provider.name);
    return {
      connected,
      notConnected: missing,
      hint: connected.length
        ? "Reads are available through cloud.request. The user can add another cloud in «Интеграции» → «Облака»."
        : "Ни одно облако не подключено: попросите пользователя открыть «Интеграции» → «Облака» и вставить ключ.",
    };
  },
});

registerTool({
  name: "cloud.request",
  description:
    "Make an authenticated read-only request to a connected cloud API, on behalf of the user. " +
    "Input: {provider:'timeweb'|'cloudru'|'mws', method?:'GET'|'HEAD', path:'/api/v1/...', host?}. " +
    "Timeweb Cloud paths start with /api/v1/ (base https://api.timeweb.cloud); MWS defaults to host api.mwsapis.ru; " +
    "Cloud.ru defaults to api.cloud.ru and allows *.cloud.ru. Use it to look up servers, projects, buckets, DNS records or " +
    "anything else the provider's docs describe. Only GET/HEAD are allowed: creating or deleting resources is not available yet.",
  parameters: { type: "object", additionalProperties: false, required: ["provider", "path"], properties: {
    provider: { type: "string", enum: ["timeweb", "cloudru", "mws"] },
    method: { type: "string", enum: ["GET", "HEAD"] },
    path: { type: "string", description: "Путь API провайдера, например /api/v1/servers" },
    host: { type: "string", description: "Хост API, если он отличается от хоста по умолчанию" },
  } },
  execute: async (input, context) => {
    const request = requestSchema.parse(input);
    return cloudFetch(context.userId, request.provider, request);
  },
});
