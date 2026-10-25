import { z } from "zod";
import { registerTool } from "../tool-registry.js";
import { cloudFetch } from "../cloud/api.js";
import { cloudDocsUrl, cloudNotFoundHint, cloudServiceCatalog } from "../cloud/catalog.js";
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
    "(base https://api.cloudvps.reg.ru, only that host); MWS: omit host — it is derived from the service in the path " +
    "(/rm → iam.mwsapis.ru, /compute → compute.mwsapis.ru, /vpc → vpc.mwsapis.ru, /mpostgres → mpostgres.mwsapis.ru); " +
    "api.mwsapis.ru is only the endpoint catalog, not an API gateway; " +
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
    host: { type: "string", description: "Хост API, если он отличается от хоста сервиса (для MWS обычно не нужен: он выводится из пути, api.mwsapis.ru сюда не передаётся)" },
    body: { type: "object", description: "Тело запроса для POST/PUT/PATCH — JSON-объект из документации провайдера" },
  } },
  execute: async (input, context) => {
    const request = requestSchema.parse(input);
    const result = await cloudFetch(context.userId, request.provider, request);
    // 404 — самая дорогая ошибка в облачном API: путь существует не там или называется иначе.
    // Вместо повторной догадки сразу отдаём каталог сервисов и ссылку на документацию.
    if ("status" in result && result.status === 404) {
      return { ...result, ...cloudNotFoundHint(request.provider, request.path) };
    }
    return result;
  },
});

registerTool({
  name: "cloud.catalog",
  description:
    "List known API paths of the connected clouds before guessing: service prefix, host for MWS, an example path and the provider documentation URL. " +
    "Input: {provider?:'timeweb'|'cloudru'|'mws'|'regru'} — without it, all providers are returned. " +
    "Use it when cloud.request returns 404, when a resource name is not obvious (MWS virtualMachines, not instances), or before constructing a path from memory. " +
    "The catalog is a starting point, not a full API reference: the docs link is part of the answer.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      provider: { type: "string", enum: ["timeweb", "cloudru", "mws", "regru"], description: "Облако; без него — все" },
    },
  },
  execute: async (input) => {
    const value = (input ?? {}) as { provider?: unknown };
    const provider = value.provider === "timeweb" || value.provider === "cloudru" || value.provider === "mws" || value.provider === "regru"
      ? value.provider
      : undefined;
    const services = cloudServiceCatalog(provider);
    return {
      services,
      ...(provider ? { docsUrl: cloudDocsUrl(provider) } : {}),
      note: provider
        ? "Это известные сервисы и примеры путей. Полный список — в документации по ссылке docsUrl."
        : "Провайдер не указан: возвращены каталоги всех облаков. Уточните provider, чтобы получить ссылку на документацию.",
    };
  },
});
