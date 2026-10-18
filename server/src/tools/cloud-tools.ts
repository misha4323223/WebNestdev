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
 * `cloud.request` умеет и чтение, и изменения — но изменение ресурса разрешено только тогда,
 * когда пользователь включил изменения в карточке облака и явно попросил именно это действие
 * в разговоре. Обе половины правила стоят в описании инструмента, потому что модель читает
 * именно его, а не исходники.
 */

const requestSchema = z.object({
  provider: z.enum(["timeweb", "cloudru", "mws", "regru"]),
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  path: z.string().min(1).max(1000),
  host: z.string().max(120).optional(),
  body: z.unknown().optional(),
});

registerTool({
  name: "cloud.status",
  description:
    "List the clouds the user connected in Integrations (Timeweb Cloud, Cloud.ru, MWS, REG.RU Облако) with the account each key belongs to and " +
    "whether the user allowed changes on that connection (allowWrites). " +
    "Call it before working with a cloud to see what is actually available and whether a change is allowed at all, " +
    "and after a cloud call says the cloud is not connected. It never returns the credential itself.",
  execute: async (_input, context) => {
    const connections = await listCloudConnections(context.userId);
    const connected = connections.map(connection => ({
      provider: connection.provider,
      name: CLOUD_PROVIDERS.find(provider => provider.id === connection.provider)?.name ?? connection.provider,
      account: connection.account,
      // Без этого поля агент не знает, пройдёт ли мутирующий запрос через гейт, и не сможет
      // честно объяснить отказ вместо попытки обойти его.
      allowWrites: connection.allowWrites,
      connectedAt: connection.updatedAt,
    }));
    const missing = CLOUD_PROVIDERS.filter(provider => !connections.some(connection => connection.provider === provider.id)).map(provider => provider.name);
    return {
      connected,
      notConnected: missing,
      hint: connected.length
        ? "cloud.request reads any connected cloud and changes it only where allowWrites is true and the user explicitly asked for that action. The user can add another cloud or turn changes on or off in «Интеграции» → «Облака»."
        : "Ни одно облако не подключено: попросите пользователя открыть «Интеграции» → «Облака» и вставить ключ.",
    };
  },
});

registerTool({
  name: "cloud.request",
  description:
    "Make an authenticated request to a connected cloud API, on behalf of the user — reads and changes. " +
    "Input: {provider:'timeweb'|'cloudru'|'mws'|'regru', method?:'GET'|'HEAD'|'POST'|'PUT'|'PATCH'|'DELETE', path:'/api/v1/...', host?, body?}. " +
    "Timeweb Cloud paths start with /api/v1/ (base https://api.timeweb.cloud); REG.RU Облако paths start with /v1/ " +
    "(base https://api.cloudvps.reg.ru, only that host); MWS defaults to host api.mwsapis.ru; " +
    "Cloud.ru defaults to api.cloud.ru and allows *.cloud.ru. Use it to look up servers, projects, buckets, DNS records or " +
    "anything else the provider's docs describe. CHANGES RULE: POST/PUT/PATCH/DELETE are executed only when the user " +
    "explicitly asked for that exact action in this conversation — never create, restart, resize or delete a resource on " +
    "your own initiative — not as a cleanup, a tidy-up or a just-in-case step. Before a mutating call, name the provider, the " +
    "exact resource and what will happen; for a deletion, quote the resource name and id from a fresh read. If the call is " +
    "refused because changes are off, tell the user to enable «Разрешить агенту изменять ресурсы» in the cloud card instead " +
    "of looking for another way. Always report the real status and body of the call.",
  parameters: { type: "object", additionalProperties: false, required: ["provider", "path"], properties: {
    provider: { type: "string", enum: ["timeweb", "cloudru", "mws", "regru"] },
    method: { type: "string", enum: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] },
    path: { type: "string", description: "Путь API провайдера, например /api/v1/servers" },
    host: { type: "string", description: "Хост API, если он отличается от хоста по умолчанию" },
    body: { type: "object", description: "Тело запроса для POST/PUT/PATCH — JSON-объект из документации провайдера" },
  } },
  execute: async (input, context) => {
    const request = requestSchema.parse(input);
    return cloudFetch(context.userId, request.provider, request);
  },
});
