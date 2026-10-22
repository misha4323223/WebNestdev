import type { DomainRegistrarId } from "./providers.js";

/**
 * Чтение списка доменов из кабинета регистратора. Только чтение: регистрация, продление,
 * перенос и DNS остаются действиями пользователя в кабинете, поэтому здесь нет ни одного
 * метода, меняющего состояние.
 *
 * У каждого регистратора своя авторизация и свой формат ответа, поэтому разбор ответа
 * вынесен в отдельные функции — они проверяются тестом без сети.
 */

export type RegistrarDomain = {
  name: string;
  /** Дата окончания регистрации, если регистратор её отдаёт. */
  expiresAt: string | null;
};

export type RegistrarListResult = {
  /** Логин владельца кабинета (или название сервиса, если логина нет). */
  account: string;
  domains: RegistrarDomain[];
};

const TIMEOUT_MS = 15_000;
const MAX_DETAIL = 300;

function textOf(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL) : "";
}

async function readText(response: Response, label: string) {
  const text = await response.text();
  if (!response.ok) throw new Error(label + " ответил HTTP " + response.status + ": " + textOf(text));
  return text;
}

function parseJson(text: string, label: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(label + " вернул не JSON: " + textOf(text));
  }
}

function namesOf(list: unknown[], keys: string[]) {
  return list
    .map(item => {
      const record = item as Record<string, unknown>;
      const name = keys.map(key => record[key]).find(value => typeof value === "string" && value.trim());
      // `expiration_date` — как дату окончания называет `service/get_list` у REG.RU (в примерах
      // официального клиента), остальные варианты — у остальных регистраторов.
      const expires = record.expiration_date ?? record.date_expire ?? record.expiration ?? record.expires_at ?? null;
      return {
        name: typeof name === "string" ? name.trim().toLowerCase() : "",
        expiresAt: typeof expires === "string" ? expires : null,
      };
    })
    .filter(domain => domain.name.includes("."));
}

/** Beget: `{status:"success", answer:{status:"success", result:[{fqdn,…}]}}`. */
export function parseBegetDomains(payload: unknown): RegistrarDomain[] {
  const root = payload as { status?: unknown; error_text?: unknown; answer?: { status?: unknown; errors?: unknown; result?: unknown } } | null;
  if (root?.status !== "success") {
    const reason = typeof root?.error_text === "string" ? root.error_text : JSON.stringify(root?.answer ?? payload);
    throw new Error("Beget отклонил доступ: " + textOf(reason));
  }
  if (root.answer?.status === "error") {
    throw new Error("Beget отклонил доступ: " + textOf(JSON.stringify(root.answer.errors ?? root.answer)));
  }
  const list = Array.isArray(root.answer?.result) ? root.answer.result : [];
  return namesOf(list, ["fqdn", "name"]);
}

/** Timeweb Cloud: Bearer-токен, `{domains:[{fqdn,…}]}`. */
export function parseTimewebDomains(payload: unknown): RegistrarDomain[] {
  const list = (payload as { domains?: unknown } | null)?.domains;
  if (!Array.isArray(list)) throw new Error("Timeweb Cloud вернул ответ без списка доменов");
  return namesOf(list, ["fqdn", "name"]);
}

/**
 * REG.API 2: `result:"success"`, ответ — `answer.services[]` (так список отдаёт `service/get_list`)
 * или `answer.domains[]`; ошибки — `error_code`/`error_text`.
 *
 * Команда называется `service/get_list` с `servtype: "domain"`: `domain/get_list` в REG.API нет, и
 * ответ на неё — `NO_SUCH_COMMAND`, хотя доступ по IP уже разрешён (это и была ошибка «Command
 * domain/get_list not found»).
 */
export function parseRegRuDomains(payload: unknown): RegistrarDomain[] {
  const root = payload as { result?: unknown; error_code?: unknown; error_text?: unknown; answer?: { domains?: unknown; services?: unknown; error_text?: unknown } } | null;
  if (root?.result !== "success") {
    const reason = textOf(root?.error_text) || textOf(root?.answer?.error_text) || textOf(JSON.stringify(root));
    throw new Error("REG.RU отклонил доступ: " + (reason || "неизвестная ошибка") + (root?.error_code ? " (код " + String(root.error_code) + ")" : ""));
  }
  const list = Array.isArray(root.answer?.services) ? root.answer.services
    : Array.isArray(root.answer?.domains) ? root.answer.domains
    : [];
  // `servtype` приходит в каждом элементе: без фильтра в список попали бы услуги хостинга.
  const domains = list.filter(item => {
    const type = (item as Record<string, unknown>)?.servtype;
    return type === undefined || type === "domain";
  });
  return namesOf(domains, ["dname", "name"]);
}

async function getJson(url: string, init: RequestInit, label: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return parseJson(await readText(response, label), label);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("Нет ответа от " + label + ": превышено время ожидания");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function begetDomains(fields: Record<string, string>): Promise<RegistrarListResult> {
  const url = new URL("https://api.beget.com/api/domain/getList");
  url.searchParams.set("login", fields.login);
  url.searchParams.set("passwd", fields.passwd);
  url.searchParams.set("input_format", "json");
  url.searchParams.set("output_format", "json");
  const payload = await getJson(url.toString(), { headers: { Accept: "application/json" } }, "Beget");
  return { account: fields.login, domains: parseBegetDomains(payload) };
}

async function timewebDomains(fields: Record<string, string>): Promise<RegistrarListResult> {
  const payload = await getJson("https://api.timeweb.cloud/api/v1/domains", {
    headers: { Authorization: "Bearer " + fields.token, Accept: "application/json" },
  }, "Timeweb Cloud");
  return { account: "Timeweb Cloud", domains: parseTimewebDomains(payload) };
}

/**
 * REG.RU принимает запросы только с IP, добавленных в список разрешённых. Сообщение
 * «Access to API from this IP denied» без подсказки ничего не говорит пользователю, поэтому
 * к нему добавляется найденный IP сервера: именно его нужно разрешить в кабинете.
 *
 * Раздел называется «Настройки API» (в нём же «Диапазоны IP-адресов») — так его называют в
 * справке REG.RU. Прежняя подсказка отправляла людей во вкладку «Безопасность», которой в
 * кабинете нет: такой текст дороже молчания, поэтому здесь только существующий раздел.
 */
export function regRuAccessHint(message: string, serverIp: string | null) {
  if (!message.includes("ACCESS_DENIED_FROM_IP")) return message;
  const where = " Разрешите IP сервера в REG.RU: «Настройки API» → «Диапазоны IP-адресов» → «Добавить IP».";
  return message + where + (serverIp ? " IP сервера: " + serverIp + "." : "");
}

/** Внешний адрес сервера — только чтобы подсказать его в ошибке REG.RU; сбой не важен. */
async function serverEgressIp(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch("https://api.ipify.org?format=json", { signal: controller.signal });
    const data = (await response.json()) as { ip?: unknown };
    return typeof data.ip === "string" ? data.ip : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function regRuDomains(fields: Record<string, string>): Promise<RegistrarListResult> {
  const body = new URLSearchParams({
    username: fields.username,
    password: fields.password,
    input_format: "json",
    output_format: "json",
    // Список доменов — это список услуг типа `domain`; параметра `limit` у метода нет.
    input_data: JSON.stringify({ servtype: "domain" }),
  });
  const payload = await getJson("https://api.reg.ru/api/regru2/service/get_list", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  }, "REG.RU");
  try {
    return { account: fields.username, domains: parseRegRuDomains(payload) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(regRuAccessHint(message, message.includes("ACCESS_DENIED_FROM_IP") ? await serverEgressIp() : null));
  }
}

export type RegistrarMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Запрос к API регистратора. `path` — то, что называет документация провайдера: у REG.RU и
 * Beget это команда вида `zone/get_resource_records` / `dns/getData`, у Timeweb Cloud —
 * обычный путь REST вида `/api/v1/domains/example.ru/dns-records`.
 */
export type RegistrarCall = {
  method?: RegistrarMethod;
  path: string;
  /** Параметры команды: у REG.RU и Beget уходят строкой `input_data`, у Timeweb — телом JSON. */
  input?: unknown;
  query?: Record<string, string>;
};

export type RegistrarCallResult = {
  ok: boolean;
  status: number;
  registrar: DomainRegistrarId;
  path: string;
  body: unknown;
  /** Что делать с отказом, если причина известна (например, IP не разрешён в кабинете). */
  hint?: string;
};

const API_BASE: Record<DomainRegistrarId, string> = {
  regru: "https://api.reg.ru/api/regru2/",
  beget: "https://api.beget.com/api/",
  timeweb: "https://api.timeweb.cloud",
};

const COMMAND = /^[a-z0-9_]+\/[a-z0-9_]+$/i;
const MAX_INPUT_BYTES = 20_000;

/**
 * Чтение или изменение. У REG.RU и Beget команда сама говорит об этом своим именем
 * (`get_list`, `add_alias`, `changeRecords`), у Timeweb — HTTP-методом. Неизвестное имя
 * считается изменением: ошибиться в сторону отказа безопаснее, чем в сторону записи.
 */
export function isReadOnlyRegistrarCall(provider: DomainRegistrarId, call: RegistrarCall) {
  if (provider === "timeweb") return !call.method || call.method === "GET";
  return /(?:^|\/)(get|list|nop|check|status)(?:$|[_A-Z])/.test(call.path);
}

function commandPath(path: string) {
  const trimmed = path.trim().replace(/^\/+/, "");
  if (!COMMAND.test(trimmed)) throw new Error("Команда регистратора задаётся как «раздел/метод», например zone/get_resource_records");
  return trimmed;
}

function restPath(path: string) {
  const trimmed = path.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.includes("..")) {
    throw new Error("Путь API Timeweb Cloud начинается с «/» и не содержит «..», например /api/v1/domains/example.ru/dns-records");
  }
  return trimmed;
}

function inputJson(input: unknown) {
  if (input === undefined) return "{}";
  if (typeof input === "string") return input;
  const text = JSON.stringify(input);
  if (text.length > MAX_INPUT_BYTES) throw new Error("Параметры запроса слишком большие");
  return text;
}

/**
 * Запрос к API подключённого регистратора тем же ключом, что уже сохранён. Разрешение на
 * изменения проверяется в инструменте агента (`domain.request`), а не здесь: этот слой ничего
 * не решает про права, он только разговаривает с API провайдера.
 */
export async function registrarRequest(
  id: DomainRegistrarId,
  fields: Record<string, string>,
  call: RegistrarCall,
): Promise<RegistrarCallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    if (id === "timeweb") {
      const url = new URL(API_BASE.timeweb + restPath(call.path));
      for (const [key, value] of Object.entries(call.query ?? {})) url.searchParams.set(key, value);
      const method = call.method ?? "GET";
      const response = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: "Bearer " + fields.token,
          Accept: "application/json",
          ...(call.input === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(call.input === undefined || method === "GET" ? {} : { body: inputJson(call.input) }),
        signal: controller.signal,
      });
      return finish(response, id, call.path);
    }

    // REG.RU и Beget принимают одну и ту же форму: логин, пароль и JSON-строка параметров.
    const path = commandPath(call.path);
    const form = new URLSearchParams({
      ...(id === "regru" ? { username: fields.username, password: fields.password } : { login: fields.login, passwd: fields.passwd }),
      input_format: "json",
      output_format: "json",
      ...(id === "regru" ? { io_encoding: "utf8" } : {}),
      input_data: inputJson(call.input),
    });
    const response = await fetch(API_BASE[id] + path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form.toString(),
      signal: controller.signal,
    });
    return finish(response, id, path);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("Нет ответа от регистратора: превышено время ожидания");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ответ как есть: агент должен видеть настоящий код и тело, чтобы объяснить отказ, а не
 * догадываться о нём. `ok` — не только HTTP-код: регистраторы отвечают 200 и на ошибку.
 */
async function finish(response: Response, registrar: DomainRegistrarId, path: string): Promise<RegistrarCallResult> {
  const text = await response.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* ответ не JSON — отдаётся текстом */ }
  const record = (body && typeof body === "object" ? body : {}) as { result?: unknown; status?: unknown; error_code?: unknown };
  const failed = !response.ok
    || (typeof record.result === "string" && record.result !== "success")
    || (typeof record.status === "string" && record.status !== "success");
  const hint = record.error_code === "ACCESS_DENIED_FROM_IP"
    ? "Разрешите IP сервера в REG.RU: «Настройки API» → «Диапазоны IP-адресов» → «Добавить IP»."
    : undefined;
  return { ok: !failed, status: response.status, registrar, path, body, ...(hint ? { hint } : {}) };
}

/** Список доменов в кабинете подключённого регистратора — без единого изменения. */
export async function listRegistrarDomains(id: DomainRegistrarId, fields: Record<string, string>): Promise<RegistrarListResult> {
  if (id === "beget") return begetDomains(fields);
  if (id === "timeweb") return timewebDomains(fields);
  return regRuDomains(fields);
}
