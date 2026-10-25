import { randomUUID } from "node:crypto";
import { checkPostboxSmtp } from "./postbox.js";
import { listS3Buckets } from "./s3.js";
import { describeTlsError, httpsJson, russianTrustedCa } from "./russian-ca.js";
import type { ServiceDefinition } from "./catalog.js";

/**
 * Проверка ключа каждого сервиса — свой запрос, потому что своей у каждого только авторизация.
 * Общее правило то же, что у облаков: ключ сохраняется лишь после того, как провайдер его принял,
 * а сообщение об отказе говорит, что именно случилось (нет доступа, нет права, сервис не ответил).
 *
 * Разбор ответов вынесен в чистые функции: они проверяются тестами без сети.
 */

const TIMEOUT_MS = 15_000;
const MAX_DETAIL = 300;

type FetchLike = typeof fetch;

export type ServiceVerifyDeps = {
  fetch?: FetchLike;
  /** Подменяет SMTP-разговор Postbox: тесты проверяют логику без сети. */
  postboxSmtp?: (username: string, password: string) => Promise<void>;
};

function detail(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL);
}

async function request(url: string, init: RequestInit, label: string, deps: ServiceVerifyDeps) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await (deps.fetch ?? fetch)(url, { ...init, signal: controller.signal });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error(label + " не ответил: превышено время ожидания");
    throw new Error("Нет ответа от " + label + ": " + (error instanceof Error ? error.message : String(error)));
  } finally {
    clearTimeout(timer);
  }
}

function asJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(label + " вернул не JSON: " + detail(text));
  }
}

function fail(label: string, status: number, text: string) {
  const body = text.trim().startsWith("<") ? "сервис ответил страницей вместо JSON — вероятно, ключ отклонён шлюзом" : detail(text);
  return new Error(label + " отклонил ключ (HTTP " + status + "): " + (body || "пустой ответ"));
}

/**
 * Адрес, который ввёл пользователь, уходит с нашего сервера. Пускаем только https и только
 * публичные имена: иначе этот же механизм стал бы способом постучаться во внутреннюю сеть.
 */
export function assertPublicHttpsUrl(raw: string, label: string) {
  let url: URL;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new Error(label + ": нужен адрес вида https://example.com");
  }
  if (url.protocol !== "https:") throw new Error(label + ": адрес должен начинаться с https://");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home")) {
    throw new Error(label + ": внутренние адреса запрещены");
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[") || host.includes(":")) {
    throw new Error(label + ": укажите домен, а не IP-адрес");
  }
  if (!host.includes(".")) throw new Error(label + ": укажите полный адрес аккаунта");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

// ─── Разбор ответов ──────────────────────────────────────────────────────────

/** Unisender: успех — объект с result, ошибка — error/code. */
export function parseUnisender(payload: unknown): string {
  const root = payload as { error?: unknown; code?: unknown; result?: unknown } | null;
  if (root && typeof root.error === "string" && root.error) {
    const code = typeof root.code === "string" ? " (" + root.code + ")" : "";
    throw new Error("Unisender отклонил ключ: " + detail(root.error) + code);
  }
  if (!root || !Array.isArray(root.result)) throw new Error("Unisender вернул ответ без списка адресов: " + detail(JSON.stringify(payload)));
  return "Unisender · " + root.result.length + " списков";
}

/** Sendsay: успешный pong содержит ping; ошибки приходят массивом errors. */
export function parseSendsay(payload: unknown, account: string): string {
  const root = payload as { errors?: unknown; ping?: unknown; account?: unknown } | null;
  if (root && Array.isArray(root.errors) && root.errors.length) {
    throw new Error("Sendsay отклонил доступ: " + detail(JSON.stringify(root.errors)));
  }
  if (!root || root.ping === undefined) throw new Error("Sendsay вернул неожиданный ответ: " + detail(JSON.stringify(payload)));
  const name = typeof root.account === "string" ? root.account : account;
  return "Sendsay · " + name;
}

/** ЮKassa: /v3/me отдаёт сведения о магазине. */
export function parseYookassa(payload: unknown): string {
  const root = payload as { account_id?: unknown; status?: unknown; test?: unknown } | null;
  if (!root || typeof root.account_id !== "string") {
    throw new Error("ЮKassa вернула ответ без сведений о магазине: " + detail(JSON.stringify(payload)));
  }
  const test = root.test === true ? " · тестовый магазин" : "";
  return "ЮKassa · " + root.account_id + test;
}

/** CloudPayments: служебный /test отвечает Success. */
export function parseCloudpayments(payload: unknown): string {
  const root = payload as { Success?: unknown; Message?: unknown } | null;
  if (!root || root.Success !== true) {
    const message = root && typeof root.Message === "string" ? root.Message : JSON.stringify(payload);
    throw new Error("CloudPayments отклонил ключ: " + detail(message));
  }
  return "CloudPayments";
}

/** GigaChat: токен живёт 30 минут, поэтому сохраняем авторизационный ключ, а не токен. */
export function parseGigachatToken(payload: unknown): string {
  const root = payload as { access_token?: unknown } | null;
  if (!root || typeof root.access_token !== "string" || !root.access_token) {
    throw new Error("GigaChat не выдал токен: " + detail(JSON.stringify(payload)));
  }
  return root.access_token;
}

/** Yandex Geocoder: успех — непустая коллекция объектов. */
export function parseGeocoder(payload: unknown): string {
  const root = payload as { response?: { GeoObjectCollection?: { member?: unknown } } } | null;
  const members = root?.response?.GeoObjectCollection?.member;
  if (!Array.isArray(members)) {
    throw new Error("Геокодер вернул ответ без результатов: " + detail(JSON.stringify(payload)));
  }
  return "Yandex Maps · геокодер отвечает";
}

/** 2GIS: успех — meta.code 200. */
export function parse2gis(payload: unknown): string {
  const root = payload as { meta?: { code?: unknown }; result?: { items?: unknown } } | null;
  const code = root?.meta?.code;
  if (code !== 200) {
    throw new Error("2GIS вернул код " + String(code) + ": " + detail(JSON.stringify(payload)));
  }
  const items = Array.isArray(root?.result?.items) ? root.result.items.length : 0;
  return "2GIS · регионов в ответе: " + items;
}

/** RetailCRM: credentials отвечает success:true. */
export function parseRetailcrm(payload: unknown): string {
  const root = payload as { success?: unknown; errorMsg?: unknown } | null;
  if (root?.success !== true) {
    const message = root && typeof root.errorMsg === "string" ? root.errorMsg : JSON.stringify(payload);
    throw new Error("RetailCRM отклонил ключ: " + detail(message));
  }
  return "RetailCRM";
}

/** Битрикс24: user.current отдаёт текущего пользователя вебхука. */
export function parseBitrix(payload: unknown): string {
  const root = payload as { result?: { ID?: unknown; NAME?: unknown; EMAIL?: unknown }; error?: unknown } | null;
  if (root && root.error) throw new Error("Битрикс24 отклонил вебхук: " + detail(JSON.stringify(root.error)));
  const id = root?.result?.ID;
  if (id === undefined || id === null || String(id).length === 0) {
    throw new Error("Битрикс24 вернул ответ без пользователя: " + detail(JSON.stringify(payload)));
  }
  const name = typeof root?.result?.NAME === "string" && root.result.NAME ? " · " + root.result.NAME : "";
  return "Битрикс24 · пользователь " + String(id) + name;
}

/**
 * Expo GraphQL отвечает на токен объектом meActor. Пользователь может быть User, SSOUser
 * или Robot — имя берём там, где оно есть, а для проверки достаточно самого аккаунта.
 */
export function parseExpo(payload: unknown): string {
  const root = payload as { data?: { meActor?: { __typename?: unknown; username?: unknown; email?: unknown; firstName?: unknown; displayName?: unknown } | null }; errors?: Array<{ message?: unknown }> } | null;
  if (root && Array.isArray(root.errors) && root.errors.length) {
    const message = root.errors.map(item => typeof item?.message === "string" ? item.message : "").filter(Boolean).join("; ");
    throw new Error("Expo отклонил токен: " + detail(message || "неизвестная ошибка API"));
  }
  const actor = root?.data?.meActor;
  if (!actor || typeof actor !== "object") throw new Error("Expo не подтвердил токен: API не вернул аккаунт");
  const name = [actor.username, actor.displayName, actor.email, actor.firstName].find(value => typeof value === "string" && value) as string | undefined;
  return "Expo · " + (name || actor.__typename || "аккаунт");
}

/** amoCRM: /api/v4/account отдаёт сведения об аккаунте. */
export function parseAmocrm(payload: unknown): string {
  const root = payload as { id?: unknown; name?: unknown; subdomain?: unknown } | null;
  if (!root || (root.id === undefined && root.subdomain === undefined)) {
    throw new Error("amoCRM вернул ответ без аккаунта: " + detail(JSON.stringify(payload)));
  }
  const label = typeof root.subdomain === "string" ? root.subdomain : typeof root.name === "string" ? root.name : String(root.id);
  return "amoCRM · " + label;
}

// ─── Проверки ───────────────────────────────────────────────────────────────

const S3_SERVICES = new Set(["selectel-storage", "vk-storage", "yandex-storage", "timeweb-storage", "cloudru-storage"]);

async function verifyNotisend(fields: Record<string, string>, deps: ServiceVerifyDeps) {
  const response = await request("https://api.notisend.ru/v1/email/templates", {
    headers: { Authorization: "Bearer " + fields.apiKey, Accept: "application/json" },
  }, "NotiSend", deps);
  if (!response.ok) throw fail("NotiSend", response.status, response.text);
  return "NotiSend";
}

async function verifySendsay(fields: Record<string, string>, deps: ServiceVerifyDeps) {
  const account = encodeURIComponent(fields.account);
  const response = await request("https://api.sendsay.ru/general/api/v100/json/" + account, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ action: "pong", apikey: fields.apiKey }),
  }, "Sendsay", deps);
  const payload = asJson(response.text, "Sendsay");
  if (!response.ok) throw fail("Sendsay", response.status, response.text);
  return parseSendsay(payload, fields.account);
}

async function verifyRusender(fields: Record<string, string>, deps: ServiceVerifyDeps) {
  const response = await request("https://api.rusender.ru/api/v1/public/external-mails/keys", {
    headers: { Authorization: "Bearer " + fields.apiKey, Accept: "application/json" },
  }, "RuSender", deps);
  if (response.status === 403) {
    throw new Error("RuSender принял токен, но у ключа нет права external_mail.read: добавьте право и повторите.");
  }
  if (!response.ok) throw fail("RuSender", response.status, response.text);
  return "RuSender";
}

async function verifyUnisender(fields: Record<string, string>, deps: ServiceVerifyDeps) {
  const body = new URLSearchParams({ api_key: fields.apiKey, format: "json" });
  const response = await request("https://api.unisender.com/ru/api/getLists", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  }, "Unisender", deps);
  const payload = asJson(response.text, "Unisender");
  if (!response.ok) throw fail("Unisender", response.status, response.text);
  return parseUnisender(payload);
}

async function verifyPostbox(fields: Record<string, string>, deps: ServiceVerifyDeps) {
  await (deps.postboxSmtp ?? checkPostboxSmtp)(fields.apiKeyId, fields.apiKeySecret);
  return "Yandex Cloud Postbox · SMTP";
}

async function verifyYookassa(fields: Record<string, string>, deps: ServiceVerifyDeps) {
  const basic = Buffer.from(fields.shopId + ":" + fields.secretKey, "utf8").toString("base64");
  const response = await request("https://api.yookassa.ru/v3/me", {
    headers: { Authorization: "Basic " + basic, Accept: "application/json" },
  }, "ЮKassa", deps);
  if (!response.ok) throw fail("ЮKassa", response.status, response.text);
  return parseYookassa(asJson(response.text, "ЮKassa"));
}

async function verifyCloudpayments(fields: Record<string, string>, deps: ServiceVerifyDeps) {
  const basic = Buffer.from(fields.publicId + ":" + fields.apiSecret, "utf8").toString("base64");
  const response = await request("https://api.cloudpayments.ru/test", {
    method: "POST",
    headers: { Authorization: "Basic " + basic, "Content-Type": "application/json", Accept: "application/json" },
    body: "{}",
  }, "CloudPayments", deps);
  if (!response.ok) throw fail("CloudPayments", response.status, response.text);
  return parseCloudpayments(asJson(response.text, "CloudPayments"));
}

async function verifyGigachat(fields: Record<string, string>, deps: ServiceVerifyDeps) {
  /** GigaChat живёт за российским доверенным УЦ: цепочку передаём только этим двум запросам. */
  const ca = russianTrustedCa();
  const call = async (url: string, options: Parameters<typeof httpsJson>[1]) => {
    if (deps.fetch) {
      // Тесты подставляют свой fetch: сеть и сертификаты им не нужны.
      const response = await request(url, { method: options?.method, headers: options?.headers, body: options?.body }, "GigaChat", deps);
      return response;
    }
    try {
      return await httpsJson(url, { ...options, ca });
    } catch (error) {
      throw new Error("GigaChat не ответил: " + describeTlsError(error));
    }
  };

  const body = new URLSearchParams({ scope: fields.scope });
  const tokenResponse = await call("https://api.giga.chat/api/v2/oauth", {
    method: "POST",
    headers: {
      Authorization: "Basic " + fields.authKey,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      RqUID: randomUUID(),
    },
    body: body.toString(),
  });
  if (!tokenResponse.ok) throw fail("GigaChat", tokenResponse.status, tokenResponse.text);
  const token = parseGigachatToken(asJson(tokenResponse.text, "GigaChat"));

  const models = await call("https://api.giga.chat/v1/models", {
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
  });
  if (!models.ok) throw fail("GigaChat", models.status, models.text);
  return "GigaChat · " + fields.scope;
}

async function verifyYandexAi(fields: Record<string, string>, deps: ServiceVerifyDeps) {
  const response = await request("https://ai.api.cloud.yandex.net/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Api-Key " + fields.apiKey, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      model: "gpt://" + fields.folderId + "/yandexgpt-lite/latest",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    }),
  }, "Yandex AI Studio", deps);
  if (!response.ok) throw fail("Yandex AI Studio", response.status, response.text);
  const payload = asJson(response.text, "Yandex AI Studio") as { choices?: unknown };
  if (!Array.isArray(payload.choices)) {
    throw new Error("Yandex AI Studio вернул ответ без результата: " + detail(response.text));
  }
  return "Yandex AI Studio · " + fields.folderId;
}

async function verifyYandexMaps(fields: Record<string, string>, deps: ServiceVerifyDeps) {
  const url = "https://geocode-maps.yandex.ru/v1/?apikey=" + encodeURIComponent(fields.apiKey) + "&geocode=" + encodeURIComponent("Москва") + "&lang=ru_RU&format=json";
  const response = await request(url, { headers: { Accept: "application/json" } }, "Геокодер", deps);
  if (!response.ok) throw fail("Геокодер Яндекса", response.status, response.text);
  return parseGeocoder(asJson(response.text, "Геокодер"));
}

async function verify2gis(fields: Record<string, string>, deps: ServiceVerifyDeps) {
  const url = "https://catalog.api.2gis.com/2.0/region/search?q=" + encodeURIComponent("Москва") + "&key=" + encodeURIComponent(fields.apiKey);
  const response = await request(url, { headers: { Accept: "application/json" } }, "2GIS", deps);
  const payload = asJson(response.text, "2GIS");
  if (!response.ok) throw fail("2GIS", response.status, response.text);
  return parse2gis(payload);
}

async function verifyRetailcrm(fields: Record<string, string>, deps: ServiceVerifyDeps) {
  const host = assertPublicHttpsUrl(fields.accountUrl, "Адрес аккаунта RetailCRM");
  const url = host + "/api/v5/credentials?apiKey=" + encodeURIComponent(fields.apiKey);
  const response = await request(url, { headers: { Accept: "application/json" } }, "RetailCRM", deps);
  const payload = asJson(response.text, "RetailCRM");
  if (!response.ok) throw fail("RetailCRM", response.status, response.text);
  return parseRetailcrm(payload);
}

async function verifyBitrix24(fields: Record<string, string>, deps: ServiceVerifyDeps) {
  const base = assertPublicHttpsUrl(fields.webhookUrl, "Ссылка вебхука Битрикс24");
  const response = await request(base + "/user.current", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: "{}",
  }, "Битрикс24", deps);
  const payload = asJson(response.text, "Битрикс24");
  if (!response.ok) throw fail("Битрикс24", response.status, response.text);
  return parseBitrix(payload);
}

async function verifyExpo(fields: Record<string, string>, deps: ServiceVerifyDeps) {
  const response = await request("https://api.expo.dev/graphql", {
    method: "POST",
    headers: { Authorization: "Bearer " + fields.token, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      // Только поля базового Actor: их схема гарантирует и для User, и для SSOUser, и для Robot.
      query: "query CurrentUser { meActor { __typename id displayName firstName } }",
    }),
  }, "Expo", deps);
  const payload = asJson(response.text, "Expo");
  if (!response.ok) throw fail("Expo", response.status, response.text);
  return parseExpo(payload);
}

async function verifyAmocrm(fields: Record<string, string>, deps: ServiceVerifyDeps) {
  const host = assertPublicHttpsUrl(fields.host, "Адрес аккаунта amoCRM");
  const response = await request(host + "/api/v4/account", {
    headers: { Authorization: "Bearer " + fields.token, Accept: "application/json" },
  }, "amoCRM", deps);
  const payload = asJson(response.text, "amoCRM");
  if (!response.ok) throw fail("amoCRM", response.status, response.text);
  return parseAmocrm(payload);
}

/** Проверка ключа сервиса: возвращает подпись для карточки («Подключено · …»). */
export async function verifyServiceCredential(
  service: ServiceDefinition,
  fields: Record<string, string>,
  deps: ServiceVerifyDeps = {},
): Promise<{ account: string }> {
  if (S3_SERVICES.has(service.id)) {
    const result = await listS3Buckets(
      { endpoint: fields.endpoint, region: fields.region, accessKey: fields.accessKey, secretKey: fields.secretKey },
      deps,
    );
    return { account: result.host + " · бакетов видно: " + result.buckets.length };
  }

  switch (service.id) {
    case "notisend": return { account: await verifyNotisend(fields, deps) };
    case "sendsay": return { account: await verifySendsay(fields, deps) };
    case "rusender": return { account: await verifyRusender(fields, deps) };
    case "unisender": return { account: await verifyUnisender(fields, deps) };
    case "yandex-postbox": return { account: await verifyPostbox(fields, deps) };
    case "yookassa": return { account: await verifyYookassa(fields, deps) };
    case "cloudpayments": return { account: await verifyCloudpayments(fields, deps) };
    case "gigachat": return { account: await verifyGigachat(fields, deps) };
    case "yandex-ai": return { account: await verifyYandexAi(fields, deps) };
    case "yandex-maps": return { account: await verifyYandexMaps(fields, deps) };
    case "2gis": return { account: await verify2gis(fields, deps) };
    case "retailcrm": return { account: await verifyRetailcrm(fields, deps) };
    case "bitrix24": return { account: await verifyBitrix24(fields, deps) };
    case "amocrm": return { account: await verifyAmocrm(fields, deps) };
    case "expo": return { account: await verifyExpo(fields, deps) };
    default:
      throw new Error("Для сервиса " + service.id + " нет проверки — сообщите об этом разработчику");
  }
}
