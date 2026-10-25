import { z } from "zod";
import { registerTool } from "../tool-registry.js";
import { checkDomain } from "../domains/rdap.js";
import { listDomainConnections } from "../domains/connections.js";
import { forbiddenRegistrarAction, isReadOnlyRegistrarCall, listRegistrarDomains, registrarRequest, type RegistrarCall, type RegistrarMethod } from "../domains/registrar-api.js";
import { DOMAIN_REGISTRARS, type DomainRegistrarId } from "../domains/providers.js";

/**
 * Домены без ключей: агент может проверить, свободно ли имя, через публичный RDAP —
 * это не требует аккаунта регистратора и не тратит деньги пользователя. Регистрация
 * и оплата остаются за человеком: у регистраторов нет OAuth для сторонних приложений,
 * а списывать деньги чужим ключом агент не должен.
 */

const MAX_NAMES = 8;
const REGISTRAR_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const REGISTRAR_ALIASES: Record<string, DomainRegistrarId> = {
  regru: "regru",
  "reg.ru": "regru",
  beget: "beget",
  "beget.com": "beget",
  timeweb: "timeweb",
  "timeweb cloud": "timeweb",
  "timeweb.ru": "timeweb",
};

/**
 * Модели называют регистратора по-разному: `regru`, `REG.RU`, `timeweb cloud`. Строгий enum
 * превращал такую мелочь в «некорректный запрос», и агент повторял вызов вместо работы с доменом.
 */
export function domainRegistrarId(value: unknown): DomainRegistrarId | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "")
    .replace(/\s+/g, " ");
  if (!key) return null;
  return REGISTRAR_ALIASES[key]
    ?? DOMAIN_REGISTRARS.find(item => item.id === key || item.name.toLowerCase() === key)?.id
    ?? null;
}

/**
 * `domain.check` принимает домены в нескольких естественных формах. Строка с запятыми или
 * переносами тоже разбирается: иначе модель отправляет список одним значением и получает ошибку.
 */
export function domainNamesFrom(input: unknown): string[] {
  const source = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const raw = typeof input === "string"
    ? input
    : source.names ?? source.domains ?? source.domain ?? source.name;
  const values = Array.isArray(raw) ? raw : [raw];
  const list = values
    .flatMap(value => typeof value === "string" ? value.split(/[,;\s]+/) : [])
    .map(value => value.trim())
    .filter(Boolean);
  if (!list.length) throw new Error("Укажите домены: {\"names\":[\"example.ru\"]} или {\"domain\":\"example.ru\"}");
  const unique = [...new Set(list)];
  if (unique.length > MAX_NAMES) throw new Error("За один вызов можно проверить не больше " + MAX_NAMES + " доменов");
  return unique;
}

/** Timeweb принимает REST-путь, остальные — команду `раздел/метод`. Один слэш не должен ломать вызов. */
export function domainRegistrarPath(id: DomainRegistrarId, value: unknown): string {
  if (typeof value !== "string") return "";
  const path = value.trim();
  if (!path || /^https?:\/\//i.test(path)) return "";
  if (id === "timeweb") return path.startsWith("/") ? path : "/" + path.replace(/^\/+/, "");
  return path.replace(/^\/+|\/+$/g, "");
}

registerTool({
  name: "domain.check",
  description:
    "Check whether domain names are free, using the public RDAP registry data — no account, key or payment needed. " +
    "Input: {names:string[]} (up to " + MAX_NAMES + "; a single string, `domain` or `domains` also work). Accepts punycode or Cyrillic names " +
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
        description: "Основное поле: одно имя или массив имён",
      },
      domains: {
        anyOf: [
          { type: "string", description: "Одно имя или список через запятую" },
          { type: "array", items: { type: "string" }, maxItems: MAX_NAMES, description: "Несколько имён" },
        ],
        description: "Синоним names — можно использовать вместо него",
      },
      domain: { type: "string", description: "Одно имя — синоним names" },
    },
  },
  execute: async input => {
    const names = domainNamesFrom(input ?? {});
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
      registrar: { type: "string", description: "Один регистратор: regru, beget или timeweb; без поля — все подключённые" },
    },
  },
  execute: async (input, context) => {
    const rawRegistrar = (input as { registrar?: unknown } | null)?.registrar;
    const wanted = rawRegistrar === undefined ? null : domainRegistrarId(rawRegistrar);
    if (rawRegistrar !== undefined && !wanted) {
      return {
        registrars: [],
        hint: "Неизвестный регистратор. Доступны regru, beget и timeweb; читать все подключённые кабинеты можно без поля registrar.",
      };
    }
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
  registrar: z.string().trim().max(80),
  method: z.string().trim().max(12).optional(),
  path: z.string().trim().max(500),
  input: z.unknown().optional(),
  query: z.record(z.string(), z.string()).optional(),
});

registerTool({
  name: "domain.request",
  description:
    "Call the API of a registrar the user connected in «Интеграции» → «Домены», on their behalf — reads freely, changes only when allowed. " +
    "This is NOT for checking a new domain: use domain.check for availability and access.request kind=domain for the registrar key. " +
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
      registrar: { type: "string", description: "regru, beget или timeweb" },
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "Для Timeweb Cloud; у REG.RU и Beget запрос всегда POST" },
      path: { type: "string", description: "Команда регистратора или путь REST, например zone/get_resource_records или /api/v1/domains/example.ru/dns-records" },
      input: { type: "object", description: "Параметры команды: у REG.RU/Beget — то, что уходит в input_data (например {\"domains\":[{\"dname\":\"example.ru\"}]}), у Timeweb — тело JSON" },
      query: { type: "object", additionalProperties: { type: "string" }, description: "Query-параметры для Timeweb Cloud, например {limit:'100'}" },
    },
  },
  execute: async (input, context) => {
    const raw = requestSchema.parse(input && typeof input === "object" ? input : {});
    const registrar = domainRegistrarId(raw.registrar);
    if (!registrar) {
      return {
        ok: false,
        blocked: "unsupported_registrar",
        hint: "domain.request работает только с кабинетом regru, beget или timeweb. Для свободного имени используйте domain.check, а для доступа к кабинету — access.request kind=domain.",
      };
    }
    const path = domainRegistrarPath(registrar, raw.path);
    if (!path) {
      return {
        ok: false,
        registrar,
        blocked: "invalid_path",
        hint: "Укажите путь API регистратора: для REG.RU и Beget — команду вида zone/get_resource_records, для Timeweb — /api/v1/domains/example.ru/dns-records.",
      };
    }
    const validPath = registrar === "timeweb"
      ? path.startsWith("/") && !path.startsWith("//") && !path.includes("..")
      : /^[a-z0-9_]+\/[a-z0-9_]+$/i.test(path);
    if (!validPath) {
      return {
        ok: false,
        registrar,
        path,
        blocked: "invalid_path",
        hint: registrar === "timeweb"
          ? "Путь Timeweb Cloud начинается с «/» и не содержит «..», например /api/v1/domains/example.ru/dns-records."
          : "Команда регистратора задаётся как «раздел/метод», например zone/get_resource_records или dns/getData.",
      };
    }
    const method = raw.method?.toUpperCase();
    if (method && !REGISTRAR_METHODS.has(method)) {
      return {
        ok: false,
        registrar,
        path,
        blocked: "unsupported_method",
        hint: "Метод должен быть GET, POST, PUT, PATCH или DELETE.",
      };
    }
    const call: RegistrarCall = {
      ...(method ? { method: method as RegistrarMethod } : {}),
      path,
      ...(raw.input === undefined ? {} : { input: raw.input }),
      ...(raw.query ? { query: raw.query } : {}),
    };
    const connection = await listDomainConnections(context.userId)
      .then(list => list.find(item => item.provider === registrar));
    const name = DOMAIN_REGISTRARS.find(item => item.id === registrar)?.name ?? registrar;
    if (!connection) {
      return {
        ok: false,
        registrar,
        path,
        blocked: "not_connected",
        hint: name + " не подключён. Попросите пользователя открыть «Интеграции» → «Домены» и вставить доступ к кабинету.",
      };
    }
    // Деньги и собственность — жёсткий запрет, а не «спросить разрешение»: даже включённые
    // изменения в кабинете не дают агенту права покупать, продлевать или удалять домен.
    const forbidden = forbiddenRegistrarAction(registrar, call);
    if (forbidden) {
      return { ok: false, registrar, path, blocked: "forbidden", hint: forbidden };
    }
    const readOnly = isReadOnlyRegistrarCall(registrar, call);
    // Гейт стоит до запроса: без разрешения пользователя кабинет только читается, и агент
    // узнаёт об этом прямо, а не из непонятного отказа регистратора.
    if (!readOnly && !connection.allowWrites) {
      return {
        ok: false,
        registrar,
        path,
        blocked: "changes_disabled",
        hint: "Изменения в кабинете «" + name + "» выключены. Попросите пользователя включить «Разрешить агенту изменять ресурсы» в карточке регистратора («Интеграции» → «Домены») — без этого DNS не меняется.",
      };
    }
    const result = await registrarRequest(registrar, JSON.parse(connection.secret) as Record<string, string>, call);
    return {
      ...result,
      registrarName: name,
      change: !readOnly,
      ...(result.hint ? {} : !readOnly ? { note: "Изменение отправлено в кабинет " + name + ". Проверьте записи чтением зоны и скажите пользователю, что именно изменилось." } : {}),
    };
  },
});
