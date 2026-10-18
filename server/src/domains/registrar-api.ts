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
      const expires = record.date_expire ?? record.expiration ?? record.expires_at ?? null;
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

/** REG.API 2: `result:"success"`, `answer.domains[].dname`; ошибки — `error_code`/`error_text`. */
export function parseRegRuDomains(payload: unknown): RegistrarDomain[] {
  const root = payload as { result?: unknown; error_code?: unknown; error_text?: unknown; answer?: { domains?: unknown; error_text?: unknown } } | null;
  if (root?.result !== "success") {
    const reason = textOf(root?.error_text) || textOf(root?.answer?.error_text) || textOf(JSON.stringify(root));
    throw new Error("REG.RU отклонил доступ: " + (reason || "неизвестная ошибка") + (root?.error_code ? " (код " + String(root.error_code) + ")" : ""));
  }
  const list = Array.isArray(root.answer?.domains) ? root.answer.domains : [];
  return namesOf(list, ["dname", "name"]);
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
 * REG.RU принимает запросы только с IP, добавленных в настройках безопасности. Сообщение
 * «Access to API from this IP denied» без подсказки ничего не говорит пользователю, поэтому
 * к нему добавляется найденный IP сервера: именно его нужно разрешить в кабинете.
 */
export function regRuAccessHint(message: string, serverIp: string | null) {
  if (!message.includes("ACCESS_DENIED_FROM_IP")) return message;
  const where = " Разрешите IP сервера в REG.RU: «Безопасность» → «Ограничения доступа» → IP-адреса для API.";
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
    input_data: JSON.stringify({ limit: 1000 }),
  });
  const payload = await getJson("https://api.reg.ru/api/regru2/domain/get_list", {
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

/** Список доменов в кабинете подключённого регистратора — без единого изменения. */
export async function listRegistrarDomains(id: DomainRegistrarId, fields: Record<string, string>): Promise<RegistrarListResult> {
  if (id === "beget") return begetDomains(fields);
  if (id === "timeweb") return timewebDomains(fields);
  return regRuDomains(fields);
}
