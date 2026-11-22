import { mwsKeySummary, mwsRequest } from "../mws/mws-auth.js";
import type { CloudProviderId } from "./providers.js";

/**
 * Проверка ключа у каждого облака — свой запрос, потому что своей у них только авторизация.
 * Общее правило: ключ сохраняется лишь после того, как провайдер его принял, а сообщение об
 * отказе содержит статус и начало ответа — иначе пользователь не поймёт, что не так.
 */

const TIMEOUT_MS = 15_000;
const MAX_DETAIL = 300;
const CLOUD_RU_COMPUTE = "https://compute.api.cloud.ru";
const CLOUD_RU_PROJECTS = "https://organization.api.cloud.ru/v3/projects";

async function call(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    throw new Error("Нет ответа от API: " + (error instanceof Error ? error.message : String(error)));
  } finally {
    clearTimeout(timer);
  }
}

function detail(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL);
}

/** В ответах МВС список лежит в `items`; пустой проект — это успех, а не отсутствие доступа. */
function itemCount(payload: unknown) {
  if (!payload || typeof payload !== "object") return 0;
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.items)) return record.items.length;
  return 0;
}

/** Timeweb Cloud: постоянный токен из личного кабинета, проверяется чтением серверов. */
async function verifyTimeweb(fields: Record<string, string>) {
  const response = await call("https://api.timeweb.cloud/api/v1/servers", {
    headers: { Authorization: "Bearer " + fields.token, Accept: "application/json" },
  });
  const text = await response.text();
  if (!response.ok) throw new Error("Timeweb Cloud отклонил токен (HTTP " + response.status + "): " + detail(text));
  return { account: "Timeweb Cloud" };
}

/**
 * Cloud.ru: Key ID + Key Secret обмениваются на токен (живёт час), а затем проверяется
 * реальный доступ к проекту. IAM-токен сам по себе не доказывает, что сервисный аккаунт
 * видит ресурсы: без роли в проекте первый же compute-запрос вернёт 403.
 */
async function verifyCloudRu(fields: Record<string, string>) {
  const response = await call("https://iam.api.cloud.ru/api/v1/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyId: fields.keyId, secret: fields.secret }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error("Cloud.ru не принял ключ (HTTP " + response.status + "): " + detail(text));
  let token = "";
  try {
    const parsed = JSON.parse(text) as { access_token?: string };
    token = parsed.access_token ?? "";
  } catch {
    /* ответ не JSON — ниже это и есть ошибка */
  }
  if (!token) throw new Error("Cloud.ru вернул ответ без токена: " + detail(text));

  const projectId = fields.projectId?.trim();
  if (projectId) {
    const probe = await call(
      CLOUD_RU_COMPUTE + "/api/v1/vms?project_id=" + encodeURIComponent(projectId) + "&limit=1",
      { headers: { Authorization: "Bearer " + token, Accept: "application/json" } },
    );
    const probeText = await probe.text();
    if (!probe.ok) {
      throw new Error("Cloud.ru не дал доступ к проекту " + projectId + " (HTTP " + probe.status + "): " + detail(probeText));
    }
    return { account: "Cloud.ru · проект " + projectId };
  }

  // Старые подключения без projectId: пробуем хотя бы список проектов, чтобы не считать
  // подключением один лишь обмен ключа на токен.
  const projects = await call(CLOUD_RU_PROJECTS, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  const projectsText = await projects.text();
  if (projects.status === 401 || projects.status === 403) {
    throw new Error("Cloud.ru не дал доступ к проектам (HTTP " + projects.status + "): " + detail(projectsText));
  }
  if (projects.ok) {
    let count = 0;
    try {
      const parsed = JSON.parse(projectsText) as { projects?: unknown[]; items?: unknown[] };
      count = Array.isArray(parsed.projects) ? parsed.projects.length : Array.isArray(parsed.items) ? parsed.items.length : 0;
    } catch {
      /* ответ не JSON — подпись останется без числа */
    }
    return { account: count ? "Cloud.ru · проектов: " + count : "Cloud.ru · проектов: 0" };
  }
  // 404/405 означают, что старый ключ всё ещё рабочий, но проект не указан. Не выдаём это
  // за проверенный доступ к ресурсам: пользователь увидит просьбу указать ID проекта.
  throw new Error("Cloud.ru принял ключ, но не подтвердил доступ к проекту. Укажите ID проекта в карточке Cloud.ru.");
}

/**
 * MWS: авторизованный ключ подписывает JWT, из него получается IAM-токен, и им читается
 * проект из `keyId`. Список всех проектов (`/rm/v3/projects`) здесь не годится: он требует
 * права `rm.project.list` на организацию, которого у сервисного аккаунта обычно нет, и
 * отвечает `403`, хотя ключ полностью рабочий. Поэтому проверка идёт по конкретному
 * проекту — так же, как `npm run mws:check`.
 */
async function verifyMws(fields: Record<string, string>) {
  let summary: ReturnType<typeof mwsKeySummary>;
  try {
    summary = mwsKeySummary(fields.key);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Ключ MWS не разобран");
  }
  const project = summary.project;
  const response = await mwsRequest(
    { host: "compute.mwsapis.ru", path: "/compute/v1/projects/" + encodeURIComponent(project) + "/virtualMachines" },
    { key: fields.key },
  );
  if (!response.ok) {
    const reason = response.status === 403
      ? "ключ действителен, но у сервисного аккаунта нет роли в проекте " + project
      : "MWS не дал доступ к проекту " + project;
    throw new Error(reason + " (HTTP " + response.status + "): " + detail(JSON.stringify(response.body)));
  }
  const machines = itemCount(response.body);
  return { account: project + (machines === 0 ? "" : " · ВМ: " + machines) };
}

/** Разбор ответа `/v1/reglets`: подпись карточки говорит, сколько серверов видно. */
export function parseRegruServers(payload: unknown): string {
  const root = payload as { reglets?: unknown } | null;
  if (!root || !Array.isArray(root.reglets)) {
    throw new Error("REG.RU Облако вернуло ответ без списка серверов: " + detail(JSON.stringify(payload)));
  }
  return "REG.RU Облако · серверов: " + root.reglets.length;
}

/**
 * REG.RU Облако (документация CloudVPS): постоянный API-ключ из настроек окружения,
 * авторизация — `Authorization: Bearer`, проверка — чтение серверов `GET /v1/reglets`.
 */
async function verifyRegru(fields: Record<string, string>) {
  const response = await call("https://api.cloudvps.reg.ru/v1/reglets", {
    headers: { Authorization: "Bearer " + fields.token, Accept: "application/json" },
  });
  const text = await response.text();
  if (!response.ok) throw new Error("REG.RU Облако отклонило ключ (HTTP " + response.status + "): " + detail(text));
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new Error("REG.RU Облако вернуло не JSON: " + detail(text));
  }
  return { account: parseRegruServers(payload) };
}

export async function verifyCloudCredential(id: CloudProviderId, fields: Record<string, string>) {
  if (id === "timeweb") return verifyTimeweb(fields);
  if (id === "cloudru") return verifyCloudRu(fields);
  if (id === "regru") return verifyRegru(fields);
  return verifyMws(fields);
}
