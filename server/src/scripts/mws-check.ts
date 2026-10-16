/**
 * Проверка доступа к МТС Web Services (МВС, mws.ru).
 *
 * Запуск с ключом из окружения:
 *   npm run mws:check --workspace=server
 * Или с ключом, который ещё не вставлен в переменные:
 *   npm run mws:check --workspace=server -- --key-file /путь/key.json
 *
 * Что делает: показывает, к какому проекту относится ключ (сам ключ и токен не печатаются),
 * обменивает ключ на IAM-токен, читает список проектов и виртуальные машины проекта из
 * `keyId`. Последняя строка `MWS-ACCESS=…` — машинный вердикт, как `SANDBOX-MOUNT=…`
 * у проверки песочницы.
 *
 * Код возврата: 0 — доступ есть, 1 — доступа нет (нет ключа, ключ не разобран, отклонён, сеть).
 */
import { readFile } from "node:fs/promises";
import { mwsIamToken, mwsKeySummary, mwsRequest, mwsSummary, type MwsCredentialOverride } from "../mws/mws-auth.js";

const flag = (name: string) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const keyFile = flag("--key-file");
const rawKey = flag("--key");
const credential: MwsCredentialOverride | undefined = keyFile ? { keyFile } : rawKey ? { key: rawKey } : undefined;

console.log("[mws] настройка: " + (credential ? "ключ передан для проверки (" + (keyFile ? "файл " + keyFile : "--key") + ")" : JSON.stringify(mwsSummary())));

let project: string | undefined;
if (credential) {
  try {
    const secret = keyFile ? await readFile(keyFile, "utf8") : (rawKey as string);
    const key = mwsKeySummary(secret);
    project = key.project;
    console.log("[mws] ключ: проект " + key.project + ", сервисный аккаунт " + key.serviceAccount + ", ключ " + key.keyName + (key.keyExpiresAt ? ", ключ истекает " + key.keyExpiresAt : ""));
  } catch (error) {
    console.log("[mws] ключ не разобран: " + messageOf(error));
    console.log("MWS-ACCESS=bad-key");
    process.exit(1);
  }
} else {
  const summary = mwsSummary();
  if (!summary.configured) {
    console.log("[mws] доступ не настроен: задайте MWS_SA_KEY (содержимое key.json авторизованного ключа) или MWS_SA_KEY_FILE");
    console.log("MWS-ACCESS=no-key");
    process.exit(1);
  }
  project = "project" in summary ? summary.project : undefined;
}

try {
  await mwsIamToken(credential);
  console.log("[mws] IAM-токен получен");
} catch (error) {
  const message = messageOf(error);
  console.log("[mws] IAM-токен не получен: " + message);
  // Недоступная сеть и отказ авторизации — разные причины, и лечатся они по-разному.
  console.log("MWS-ACCESS=" + (/Не удалось обратиться/.test(message) ? "unreachable" : "rejected"));
  process.exit(1);
}

// Список проектов — не признак доступа: у сервисного аккаунта может не быть права
// rm.project.list на организацию, и это не мешает работать с тем проектом, который назван
// в ключе. Поэтому отказ здесь только сообщается, а вердикт даёт проверка проекта.
const projects = await mwsRequest({ path: "/rm/v3/projects" }, credential);
if (!projects.ok) {
  console.log("[mws] список проектов недоступен (нужно право rm.project.list на организацию): HTTP " + projects.status + " " + slice(projects.body));
} else {
  const visible = itemsOf(projects.body);
  console.log("[mws] проектов видно: " + visible.length + (visible.length === 0 ? "" : " — " + visible.map(describeItem).join(", ")));
}

if (!project) {
  console.log("[mws] проект не определён: доступ по готовому токену (MWS_IAM_TOKEN) не называет проект");
  console.log("MWS-ACCESS=ok");
  process.exit(0);
}

const machines = await mwsRequest({ host: "compute.mwsapis.ru", path: "/compute/v1/projects/" + encodeURIComponent(project) + "/virtualMachines" }, credential);
if (!machines.ok) {
  console.log("[mws] проект " + project + " недоступен: HTTP " + machines.status + " " + slice(machines.body));
  console.log("MWS-ACCESS=no-project-access");
  process.exit(1);
}
const instances = itemsOf(machines.body);
console.log("[mws] виртуальных машин в проекте " + project + ": " + instances.length + (instances.length === 0 ? "" : " — " + instances.map(describeItem).join(", ")));

console.log("MWS-ACCESS=ok");

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** В ответах МВС список лежит в `items`; у сервисов с другим именем поле ищется по типу. */
function itemsOf(body: unknown) {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  if (Array.isArray(record.items)) return record.items;
  const array = Object.values(record).find(Array.isArray);
  return Array.isArray(array) ? array : [];
}

/** Метка элемента списка для человека: идентификатор и отображаемое имя, если они есть. */
function describeItem(item: unknown) {
  if (!item || typeof item !== "object") return String(item);
  const metadata = (item as { metadata?: Record<string, unknown> }).metadata;
  if (metadata) {
    const id = metadata.id === undefined ? undefined : String(metadata.id);
    const display = metadata.displayName === undefined ? undefined : String(metadata.displayName);
    if (id || display) return [id, display].filter(Boolean).join(" / ");
  }
  const name = (item as { name?: unknown }).name;
  return name === undefined ? "элемент без имени" : String(name);
}

function slice(body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > 240 ? text.slice(0, 240) + "…" : text;
}
