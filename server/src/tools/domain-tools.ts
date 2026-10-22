import { z } from "zod";
import { registerTool } from "../tool-registry.js";
import { checkDomain } from "../domains/rdap.js";
import { listDomainConnections } from "../domains/connections.js";
import { isReadOnlyRegistrarCall, listRegistrarDomains, registrarRequest } from "../domains/registrar-api.js";
import { DOMAIN_REGISTRARS } from "../domains/providers.js";

/**
 * Домены без ключей: агент может проверить, свободно ли имя, через публичный RDAP —
 * это не требует аккаунта регистратора и не тратит деньги пользователя. Регистрация
 * и оплата остаются за человеком: у регистраторов нет OAuth для сторонних приложений,
 * а списывать деньги чужим ключом агент не должен.
 */

const MAX_NAMES = 8;

const inputSchema = z.object({
  names: z.union([z.string(), z.array(z.string())]).optional(),
  domain: z.string().optional(),
});

function namesFrom(input: z.infer<typeof inputSchema>) {
  const raw = input.names ?? input.domain;
  if (!raw) throw new Error("Укажите домены: {names:[\"example.ru\"]}");
  const list = (Array.isArray(raw) ? raw : [raw]).map(name => name.trim()).filter(Boolean);
  if (!list.length) throw new Error("Пустой список доменов");
  if (list.length > MAX_NAMES) throw new Error("За один вызов можно проверить не больше " + MAX_NAMES + " доменов");
  return [...new Set(list)];
}

registerTool({
  name: "domain.check",
  description:
    "Check whether domain names are free, using the public RDAP registry data — no account, key or payment needed. " +
    "Input: {names:string[]} (up to " + MAX_NAMES + ", a single string also works). Accepts punycode or Cyrillic names " +
    "(пример.рф) and full URLs. Returns for each name status 'available' | 'taken' | 'unknown' with a short detail; " +
    "'unknown' means the registry did not answer and tells nothing about the name. " +
    "Use it before recommending a domain to the user, when the user asks whether a name is taken, and after the user picks " +
    "a domain but before they pay for it. This tool only reads public data: it cannot register, renew or transfer a domain — " +
    "that is done by the user in the registrar's panel, and never claim a domain was registered. DNS of an already connected " +
    "registrar is changed with domain.request, not here.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      names: {
        anyOf: [
          { type: "string", description: "Одно имя, например example.ru" },
          { type: "array", items: { type: "string" }, maxItems: MAX_NAMES, description: "Несколько имён" },
        ],
      },
    },
  },
  execute: async input => {
    const names = namesFrom(inputSchema.parse(input ?? {}));
    const results = await Promise.all(names.map(async name => {
      try {
        return await checkDomain(name);
      } catch (error) {
        return { domain: name, status: "unknown" as const, detail: error instanceof Error ? error.message : String(error) };
      }
    }));
    const available = results.filter(result => result.status === "available").map(result => result.domain);
    return {
      results,
      available,
      hint: available.length
        ? "Свободные имена: " + available.join(", ") + ". Регистрацию и оплату выполняет пользователь у своего регистратора — предложите ему это сделать."
        : "Свободных имён в ответе нет. Для статуса unknown попробуйте другой вариант имени: реестр не ответил.",
    };
  },
});

registerTool({
  name: "domain.list",
  description:
    "List the domains the user already owns, read from the registrar cabinets they connected in «Интеграции» → «Домены» " +
    "(REG.RU, Beget, Timeweb Cloud). Input: {registrar?} — one registrar id, or omit to read every connected one. " +
    "Call it when the user asks which domains they have, before proposing to buy a new one, and when checking whether a name is already theirs. " +
    "Read-only: this tool registers nothing and changes no DNS (that is domain.request, for which allowWrites is reported here), " +
    "and it never returns the password or token.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      registrar: { type: "string", enum: ["regru", "beget", "timeweb"], description: "Один регистратор; без поля — все подключённые" },
    },
  },
  execute: async (input, context) => {
    const wanted = typeof (input as { registrar?: unknown } | null)?.registrar === "string"
      ? (input as { registrar: string }).registrar
      : null;
    const connections = (await listDomainConnections(context.userId))
      .filter(connection => !wanted || connection.provider === wanted);
    if (!connections.length) {
      const requested = wanted ? "Кабинет " + (DOMAIN_REGISTRARS.find(registrar => registrar.id === wanted)?.name ?? wanted) + " не подключён." : "Ни один кабинет регистратора не подключён (REG.RU, Beget, Timeweb Cloud).";
      return {
        registrars: [],
        hint: requested + " Попросите пользователя открыть «Интеграции» → «Домены» и подключить регистратора — затем повторите вызов.",
      };
    }
    const registrars: Array<{ provider: string; name: string; account: string; allowWrites: boolean; domains?: unknown; total?: number; error?: string }> = [];
    for (const connection of connections) {
      const registrar = DOMAIN_REGISTRARS.find(item => item.id === connection.provider);
      try {
        const result = await listRegistrarDomains(connection.provider, JSON.parse(connection.secret) as Record<string, string>);
        registrars.push({
          provider: connection.provider,
          name: registrar?.name ?? connection.provider,
          account: result.account,
          allowWrites: connection.allowWrites,
          domains: result.domains.slice(0, 500),
          total: result.domains.length,
        });
      } catch (error) {
        registrars.push({
          provider: connection.provider,
          name: registrar?.name ?? connection.provider,
          account: connection.account,
          allowWrites: connection.allowWrites,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const notConnected = DOMAIN_REGISTRARS.filter(item => !connections.some(connection => connection.provider === item.id)).map(item => item.name);
    return {
      registrars,
      notConnected,
      hint: "Список прочитан из кабинетов регистраторов. allowWrites показывает, можно ли менять DNS через domain.request «allowWrites». Регистрация, продление и оплата — действия пользователя в кабинете: платформа домены не покупает.",
    };
  },
});

const requestSchema = z.object({
  registrar: z.enum(["regru", "beget", "timeweb"]),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  path: z.string().min(1).max(500),
  input: z.unknown().optional(),
  query: z.record(z.string(), z.string()).optional(),
});

registerTool({
  name: "domain.request",
  description:
    "Call the API of a registrar the user connected in «Интеграции» → «Домены», on their behalf — reads freely, changes only when allowed. " +
    "Input: {registrar:'regru'|'beget'|'timeweb', method?, path, input?, query?}. " +
    "Paths: REG.RU — a command from REG.API 2 without the base, e.g. 'zone/get_resource_records', 'zone/add_alias', " +
    "'zone/add_txt', 'zone/remove_record', 'service/get_list'; input becomes input_data. Beget — a method, e.g. " +
    "'dns/getData', 'dns/changeRecords'; input becomes input_data. Timeweb Cloud — a REST path, e.g. " +
    "'/api/v1/domains/example.ru/dns-records' with method GET/POST/PATCH/DELETE and query for limit/offset. " +
    "TYPICAL JOB — point a domain at a server after deploying it: read the zone first (REG.RU 'zone/get_resource_records' " +
    "with {\"domains\":[{\"dname\":\"example.ru\"}]}, Timeweb GET '/api/v1/domains/example.ru/dns-records'), then add or replace " +
    "the A record for '@' and 'www' at the server's public IP (REG.RU 'zone/add_alias' with subdomain/ipaddr, Timeweb POST with " +
    "{type:'A',value:'<ip>',ttl:600}). " +
    "DANGER: Beget 'dns/changeRecords' REPLACES the whole record set of the fqdn — always read it first and send back the " +
    "current records plus your change, never a single record on the root domain. REG.RU has no update-in-place command: remove " +
    "the old record ('zone/remove_record') and add the new one. Never register, renew, transfer or delete a domain: purchases and " +
    "payments stay with the user in the registrar cabinet. CHANGES RULE: a call that is not a read is executed only when the user " +
    "explicitly asked for that exact change in this conversation — never on your own initiative, never as cleanup. Before it, say " +
    "which registrar, which domain and which record will change; after it, report the real status and body. If the call is refused " +
    "because changes are off, tell the user to enable «Разрешить агенту изменять ресурсы» in the registrar card instead of looking " +
    "for another way. Reads are always allowed and cost nothing.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["registrar", "path"],
    properties: {
      registrar: { type: "string", enum: ["regru", "beget", "timeweb"] },
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "Для Timeweb Cloud; у REG.RU и Beget запрос всегда POST" },
      path: { type: "string", description: "Команда регистратора или путь REST, например zone/get_resource_records или /api/v1/domains/example.ru/dns-records" },
      input: { type: "object", description: "Параметры команды: у REG.RU/Beget — то, что уходит в input_data (например {\"domains\":[{\"dname\":\"example.ru\"}]}), у Timeweb — тело JSON" },
      query: { type: "object", additionalProperties: { type: "string" }, description: "Query-параметры для Timeweb Cloud, например {limit:'100'}" },
    },
  },
  execute: async (input, context) => {
    const call = requestSchema.parse(input);
    const connection = await listDomainConnections(context.userId)
      .then(list => list.find(item => item.provider === call.registrar));
    const name = DOMAIN_REGISTRARS.find(item => item.id === call.registrar)?.name ?? call.registrar;
    if (!connection) {
      return {
        ok: false,
        registrar: call.registrar,
        blocked: "not_connected",
        hint: name + " не подключён. Попросите пользователя открыть «Интеграции» → «Домены» и вставить доступ к кабинету.",
      };
    }
    const readOnly = isReadOnlyRegistrarCall(connection.provider, call);
    // Гейт стоит до запроса: без разрешения пользователя кабинет только читается, и агент
    // узнаёт об этом прямо, а не из непонятного отказа регистратора.
    if (!readOnly && !connection.allowWrites) {
      return {
        ok: false,
        registrar: call.registrar,
        blocked: "changes_disabled",
        hint: "Изменения в кабинете «" + name + "» выключены. Попросите пользователя включить «Разрешить агенту изменять ресурсы» в карточке регистратора («Интеграции» → «Домены») — без этого DNS не меняется.",
      };
    }
    const result = await registrarRequest(connection.provider, JSON.parse(connection.secret) as Record<string, string>, call);
    return {
      ...result,
      registrarName: name,
      change: !readOnly,
      ...(result.hint ? {} : !readOnly ? { note: "Изменение отправлено в кабинет " + name + ". Проверьте записи чтением зоны и скажите пользователю, что именно изменилось." } : {}),
    };
  },
});
