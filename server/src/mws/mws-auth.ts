import { createPrivateKey, sign as signWithKey, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseAuthorizedKeyJson } from "../yandex/yandex-api.js";

/**
 * Доступ к МТС Web Services (МВС, mws.ru) сервисным аккаунтом.
 *
 * У МВС нет «одной» переменной с готовым токеном: вместо этого в консоли создаётся
 * авторизованный ключ сервисного аккаунта (файл `key.json`), и уже он обменивается на
 * IAM-токен. Схема взята из официальной спецификации, а не угадана:
 *
 * - `openapi/iam/openapi.gen.yaml` (github.com/mws-cloud-platform/api): выпуск токена —
 *   `GET https://iam.mwsapis.ru/iam/v2/tokens:issueServiceAccountToken?serviceAccount=<sa>`
 *   с подписанным JWT в `Authorization: Bearer`, ответ `{ accessToken, expirationTs }`;
 * - `mws/iam/service_account.go` (github.com/mws-cloud-platform/go-sdk): файл ключа —
 *   `{ keyId, privateKey, publicKey, expirationTime, algorithm }`, где `privateKey` —
 *   это base64 от PKCS8 DER ключа ES256 (P-256), а `keyId` имеет вид
 *   `projects/<project>/serviceAccounts/<sa>/authorizedKeys/<ключ>`;
 * - `mws/iam/authorized_key.go`: JWT подписывается ES256, в заголовке `kid` — имя ключа,
 *   в payload — `sub` (сервисный аккаунт) и `exp`, TTL по умолчанию час.
 *
 * Проект и сервисный аккаунт целиком выводятся из `keyId`, поэтому для работы хватает
 * одного `MWS_SA_KEY`: отдельный идентификатор проекта вводить не нужно.
 */
const DEFAULT_IAM_HOST = "iam.mwsapis.ru";
/**
 * `:` здесь — отдельный сегмент пути, а не разделитель схемы: в спецификации и в SDK
 * операция записана как `/iam/v2/tokens/:issueServiceAccountToken`, и именно в таком
 * виде её принимает шлюз. Проверено на живом API: без этого сегмента ответ —
 * `404 No static resource`, с ним запрос доходит до выпуска токена (для несуществующего
 * сервисного аккаунта — `403 Subject does not exist`).
 */
const TOKEN_PATH = "/iam/v2/tokens/:issueServiceAccountToken";
const ES256 = "ES256";
const MAX_ERROR_CHARS = 400;
/** Срок готового JWT, если у ключа нет expirationTime (как в SDK: defaultClaimsTTL). */
const JWT_TTL_SECONDS = 3600;

/** Разрешены только API-хосты МВС: список хостов — api.mwsapis.ru/endpoint. */
const HOST_PATTERN = /^[a-z0-9-]+\.mwsapis\.ru$/;
/** keyId авторизованного ключа из консоли МВС. */
const KEY_ID_PATTERN = /^projects\/([^/]+)\/serviceAccounts\/([^/]+)\/authorizedKeys\/([^/]+)$/;

/**
 * Сервисы MWS и их хосты — для каталога в `cloud.request` и подсказки на 404. Путь называет
 * сервис, поэтому без этого списка агент угадывает между `virtualMachines` и `instances`.
 */
export function mwsServiceCatalog() {
  return Object.entries(SERVICE_HOSTS).map(([prefix, host]) => ({ prefix: "/" + prefix, host }));
}

/**
 * Хост сервиса по первому сегменту пути. `api.mwsapis.ru` — только каталог эндпоинтов:
 * `/rm/v3/projects` на нём отвечает `404 No static resource`, потому что Resource Manager
 * живёт на `iam.mwsapis.ru`. Поэтому путь сам называет сервис, и хост выводится из него,
 * а явный `host` по-прежнему главнее.
 */
const SERVICE_HOSTS: Record<string, string> = {
  auditlogs: "audit.mwsapis.ru",
  billing: "billing.mwsapis.ru",
  cdn: "cdn.mwsapis.ru",
  certmanager: "certmanager.mwsapis.ru",
  compute: "compute.mwsapis.ru",
  gpt: "gpt.mwsapis.ru",
  iam: "iam.mwsapis.ru",
  kms: "kms.mwsapis.ru",
  metastore: "metastore.mwsapis.ru",
  mclickhouse: "mclickhouse.mwsapis.ru",
  mk8s: "mk8s.mwsapis.ru",
  mkafka: "mkafka.mwsapis.ru",
  mmysql: "mmysql.mwsapis.ru",
  monitoring: "monitoring.mwsapis.ru",
  mpostgres: "mpostgres.mwsapis.ru",
  mvalkey: "mvalkey.mwsapis.ru",
  nlb: "vpc.mwsapis.ru",
  queue: "queue-api.mwsapis.ru",
  registry: "registry.mwsapis.ru",
  rm: "iam.mwsapis.ru",
  secretmanager: "secretmanager.mwsapis.ru",
  serialconsole: "compute.mwsapis.ru",
  spg: "spg-internal.mwsapis.ru",
  storage: "storage.mwsapis.ru",
  support: "support.mwsapis.ru",
  vi: "vi.mwsapis.ru",
  vpc: "vpc.mwsapis.ru",
};

export function mwsHostForPath(path: string) {
  const service = path.split("?")[0].split("#")[0].split("/").filter(Boolean)[0]?.toLowerCase();
  const host = service ? SERVICE_HOSTS[service] : undefined;
  if (!host) {
    throw new Error(
      "MWS: не удалось определить сервис по пути " + path + ". Укажите host из https://api.mwsapis.ru/endpoint (например, compute.mwsapis.ru).",
    );
  }
  return host;
}

function firstEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export type MwsAuthorizedKey = {
  project: string;
  serviceAccountName: string;
  /** Полное имя ресурса: `projects/<project>/serviceAccounts/<sa>` — это и есть `sub` JWT. */
  serviceAccount: string;
  keyName: string;
  privateKey: KeyObject;
  /** Момент истечения ключа (мс), если он указан в файле. */
  expiresAt?: number;
};

function describeKeyId(value: string) {
  if (!value) return "поле keyId пустое";
  return "keyId: " + (value.length > 80 ? value.slice(0, 80) + "…" : value);
}

/**
 * Разбирает файл авторизованного ключа. Поля называются `keyId`, `privateKey`,
 * `algorithm` — так их пишет консоль МВС, и это же поле читает официальный SDK; при
 * этом принимаются и старые варианты (`id`/`service_account_id`) на случай, если ключ
 * выгружен из другого инструмента.
 */
/**
 * Что вставлено в переменную — по форме, а не по значению. Это единственный способ назвать
 * ошибку, когда ключ скопирован частично («не начинается с {» ничего не говорит о причине),
 * и он же не выдаёт секрет: печатается только длина и вид строки.
 */
function describeMwsSecretShape(value: string) {
  const facts = ["длина " + value.length + " символов"];
  if (/^projects\/[^/]+\/serviceAccounts\//.test(value)) {
    facts.push("это идентификатор авторизованного ключа (keyId), а нужен файл key.json целиком");
  } else if (/^ey[A-Za-z0-9_-]+\./.test(value)) {
    facts.push("это похоже на JWT, а нужен файл key.json авторизованного ключа");
  } else if (/^[{[\"']{1,3}$/.test(value)) {
    // Самая частая настоящая ошибка: key.json многострочный, поле переменной — нет,
    // и от файла остаётся только открывающая скобка первой строки.
    facts.push("вставка сохранила только первый символ файла («{») — многострочный key.json не влезает в однострочное поле целиком");
  } else if (value.includes("BEGIN")) {
    facts.push("похоже на голый PEM-ключ без JSON-обёртки");
  } else if (/^[A-Za-z0-9+/=]{40,}$/.test(value)) {
    facts.push("похоже на одну строку base64 — скопирована только часть файла");
  } else if (value.startsWith("{") && !value.endsWith("}")) {
    facts.push("начинается с «{», но не заканчивается на «}» — значение обрезалось при вставке");
  } else {
    facts.push("не похоже на JSON-файл ключа");
  }
  if (value.includes("\n")) facts.push("содержит переводы строк вне JSON");
  return facts.join(", ");
}

/**
 * Что делать с ключом — одним текстом, потому что без этого шага установка повторяется:
 * файл многострочный, а переменная окружения — одна строка.
 */
const HOW_TO_PASTE_KEY =
  "Проще всего — двумя переменными, потому что они однострочные: MWS_SA_KEY_ID (значение keyId целиком) и " +
  "MWS_SA_PRIVATE_KEY (значение privateKey). Либо сожмите key.json в одну строку и вставьте в MWS_SA_KEY: " +
  "python3 -c \"import json;print(json.dumps(json.load(open('key.json'))))\" " +
  "(в PowerShell: (Get-Content -Raw key.json | ConvertFrom-Json | ConvertTo-Json -Compress)). " +
  "Либо положите файл как есть и задайте MWS_SA_KEY_FILE с путём к нему.";

export function parseMwsAuthorizedKey(secret: string): MwsAuthorizedKey {
  let document: Record<string, unknown> | null;
  try {
    document = parseAuthorizedKeyJson(secret) as Record<string, unknown> | null;
  } catch {
    throw new Error("Ключ МВС должен быть содержимым файла key.json (поля keyId, privateKey, publicKey, algorithm). Что вставлено: " + describeMwsSecretShape(secret.trim()) + ". " + HOW_TO_PASTE_KEY);
  }
  return buildMwsKey(document);
}

/**
 * Ключ, разложенный на однострочные значения — ровно так, как они лежат внутри key.json.
 * Это не украшение: файл ключа многострочный, а поле переменной окружения — одна строка,
 * и вставка файла целиком сохраняет от него один символ «{». `keyId` и `privateKey`
 * внутри файла однострочные, поэтому их можно вставить по отдельности и ничего не сжимать.
 */
export type MwsKeyParts = { keyId: string; privateKey: string; algorithm?: string; expirationTime?: string };

export function mwsKeyFromParts(parts: MwsKeyParts): MwsAuthorizedKey {
  return buildMwsKey({ keyId: parts.keyId, privateKey: parts.privateKey, algorithm: parts.algorithm, expirationTime: parts.expirationTime });
}

function buildMwsKey(document: Record<string, unknown> | null): MwsAuthorizedKey {
  const keyId = String(document?.keyId ?? document?.key_id ?? document?.id ?? "").trim();
  const algorithm = String(document?.algorithm ?? ES256).trim().toUpperCase();
  if (algorithm !== ES256) {
    throw new Error("Ключ МВС подписан алгоритмом " + algorithm + ", а принимается только " + ES256 + ". Создайте авторизованный ключ ES256 в консоли МВС.");
  }
  const match = KEY_ID_PATTERN.exec(keyId);
  if (!match) {
    throw new Error("В ключе МВС нет keyId вида projects/<проект>/serviceAccounts/<аккаунт>/authorizedKeys/<ключ> (" + describeKeyId(keyId) + "). Нужен файл key.json авторизованного ключа целиком.");
  }
  const privateKeyValue = String(document?.privateKey ?? document?.private_key ?? "").trim();
  if (!privateKeyValue) throw new Error("В ключе МВС нет поля privateKey");
  const expiresAt = parseExpiration(document?.expirationTime);

  return {
    project: match[1],
    serviceAccountName: match[2],
    serviceAccount: "projects/" + match[1] + "/serviceAccounts/" + match[2],
    keyName: match[3],
    privateKey: decodePrivateKey(privateKeyValue),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

/**
 * `privateKey` из консоли МВС — base64 от PKCS8 DER. PEM принимается тоже: так выглядит
 * ключ, выгруженный через `openssl` или выданный другим инструментом, и разбирать его
 * здесь дешевле, чем объяснять пользователю, почему правильный ключ не подошёл.
 */
function decodePrivateKey(value: string): KeyObject {
  let key: KeyObject;
  if (value.includes("BEGIN")) {
    try {
      key = createPrivateKey(value);
    } catch (error) {
      throw new Error("privateKey не читается как PEM-ключ: " + messageOf(error));
    }
  } else {
    const der = Buffer.from(value, "base64");
    try {
      key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    } catch (error) {
      throw new Error("privateKey не читается как base64 PKCS8 (ключ ES256 из консоли МВС): " + messageOf(error));
    }
  }
  // Несовпадение кривой обнаруживается иначе только отказом MWS IAM при обмене токена,
  // где причина не видна: ES256 — это именно P-256.
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("Ключ МВС должен быть эллиптическим P-256 (ES256), а в файле " + (key.asymmetricKeyType ?? "неизвестный") + "/" + (key.asymmetricKeyDetails?.namedCurve ?? "неизвестная кривая"));
  }
  return key;
}

function parseExpiration(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * JWT для обмена на IAM-токен: ES256, `kid` — имя авторизованного ключа, `sub` —
 * сервисный аккаунт. Подпись — сырая пара R||S (`ieee-p1363`), как требует JWS: DER,
 * который Node отдаёт по умолчанию, сервер подписи не примет.
 */
export function signMwsJwt(key: MwsAuthorizedKey, now = Math.floor(Date.now() / 1000)) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const keyExpiresAt = key.expiresAt === undefined ? undefined : Math.floor(key.expiresAt / 1000);
  const exp = keyExpiresAt === undefined ? now + JWT_TTL_SECONDS : Math.min(now + JWT_TTL_SECONDS, keyExpiresAt);
  const signingInput = encode({ alg: ES256, typ: "JWT", kid: key.keyName }) + "." + encode({ sub: key.serviceAccount, iat: now, exp });
  const signature = signWithKey("sha256", Buffer.from(signingInput, "utf8"), { key: key.privateKey, dsaEncoding: "ieee-p1363" });
  return signingInput + "." + signature.toString("base64url");
}

type MwsCredential =
  | { kind: "key"; secret: string }
  | { kind: "keyFile"; file: string }
  | { kind: "parts" } & MwsKeyParts
  | { kind: "token"; token: string };

/**
 * Явный источник вместо окружения: так ключ проверяется до того, как он попадёт в
 * переменные — `npm run mws:check --workspace=server -- --key-file key.json`.
 */
export type MwsCredentialOverride = { key?: string; keyFile?: string; token?: string };

/**
 * Ключ предпочтительнее готового токена по той же причине, что и в интеграции Yandex
 * Cloud: IAM-токен живёт ограниченное время, а ключ даёт свежий токен при каждом обмене,
 * поэтому установка лечится сама вместо «доступ вдруг перестал работать».
 */
/** Две однострочные переменные, из которых собирается тот же ключ, что лежит в key.json. */
function partsFromEnvironment(): ({ kind: "parts" } & MwsKeyParts) | null {
  const keyId = firstEnv("MWS_SA_KEY_ID");
  const privateKey = firstEnv("MWS_SA_PRIVATE_KEY");
  if (!keyId || !privateKey) return null;
  const algorithm = firstEnv("MWS_SA_KEY_ALGORITHM");
  const expirationTime = firstEnv("MWS_SA_KEY_EXPIRATION");
  return { kind: "parts", keyId, privateKey, ...(algorithm === undefined ? {} : { algorithm }), ...(expirationTime === undefined ? {} : { expirationTime }) };
}

/** Разбирается ли значение целиком: обрезанная вставка не должна перекрывать однострочные переменные. */
function looksLikeWholeKey(secret: string) {
  try {
    parseMwsAuthorizedKey(secret);
    return true;
  } catch {
    return false;
  }
}

function credentialFromEnvironment(): MwsCredential | null {
  const secret = firstEnv("MWS_SA_KEY");
  const parts = partsFromEnvironment();
  // Как и в Yandex-ветке: нечитаемое значение в одной переменной уступает место другой
  // форме того же ключа, вместо того чтобы ронять каждую попытку обмена токена.
  if (secret && parts && !looksLikeWholeKey(secret)) return parts;
  if (secret) return { kind: "key", secret };
  if (parts) return parts;
  const file = firstEnv("MWS_SA_KEY_FILE");
  if (file) return { kind: "keyFile", file };
  const token = firstEnv("MWS_IAM_TOKEN");
  if (token) return { kind: "token", token };
  return null;
}

function resolveCredential(override?: MwsCredentialOverride): MwsCredential | null {
  if (override?.key) return { kind: "key", secret: override.key };
  if (override?.keyFile) return { kind: "keyFile", file: override.keyFile };
  if (override?.token) return { kind: "token", token: override.token };
  return credentialFromEnvironment();
}

export function mwsConfigured() {
  return credentialFromEnvironment() !== null;
}

export type MwsCredentialKind = "key" | "token";

export function mwsCredentialKind(): MwsCredentialKind | null {
  const credential = credentialFromEnvironment();
  if (!credential) return null;
  return credential.kind === "token" ? "token" : "key";
}

/**
 * Безопасная сводка для диагностики: что за ключ настроен, к какому проекту и аккаунту
 * он относится и когда истекает. Сам ключ и токен здесь не появляются, поэтому сводку
 * можно печатать в логах и отдавать в ответе — как `sms` в `/api/health`.
 */
export function mwsSummary() {
  const credential = credentialFromEnvironment();
  if (!credential) return { configured: false as const };
  if (credential.kind === "token") return { configured: true as const, credentialKind: "token" as const };
  // Ключ-файл читается только асинхронно, а сводка синхронная: метаданные ключа из файла
  // печатает `npm run mws:check`, здесь честно сказано лишь то, что ключ задан.
  if (credential.kind === "keyFile") return { configured: true as const, credentialKind: "key" as const, source: "file" as const };
  if (credential.kind === "parts") {
    try {
      return summaryOfKey(mwsKeyFromParts(credential), "parts" as const);
    } catch {
      return { configured: true as const, credentialKind: "key" as const, source: "parts" as const, parseError: true };
    }
  }
  try {
    return mwsKeySummary(credential.secret);
  } catch {
    // Ключ задан, но не разобран — это и есть ответ; причину называет сам обмен токена.
    return { configured: true as const, credentialKind: "key" as const, source: "inline" as const, parseError: true };
  }
}

/**
 * Метаданные ключа без самого ключа: проект, сервисный аккаунт, имя ключа и его срок.
 * Этого достаточно, чтобы понять, к какому проекту МВС относится ключ, не читая секрет.
 */
export function mwsKeySummary(secret: string) {
  return summaryOfKey(parseMwsAuthorizedKey(secret), "inline" as const);
}

function summaryOfKey(key: MwsAuthorizedKey, source: "inline" | "file" | "parts") {
  return {
    configured: true as const,
    credentialKind: "key" as const,
    source,
    project: key.project,
    serviceAccount: key.serviceAccountName,
    keyName: key.keyName,
    ...(key.expiresAt === undefined ? {} : { keyExpiresAt: new Date(key.expiresAt).toISOString() }),
  };
}

let cachedToken: { token: string; expiresAt: number } | null = null;

/** Помощник тестов: токен кешируется на процесс, поэтому тесты начинают с чистого кеша. */
export function resetMwsTokenCache() {
  cachedToken = null;
}

async function readCredential(credential: { kind: "key"; secret: string } | { kind: "keyFile"; file: string }): Promise<string> {
  if (credential.kind === "key") return credential.secret;
  return readFile(credential.file, "utf8");
}

/**
 * Отказы, которые пользователь может исправить сам, звучат как инструкция, а не как код
 * ответа: истёкший ключ и сервисный аккаунт без прав выглядят одинаково (401/403), но
 * лечатся по-разному.
 */
function describeTokenError(status: number, body: string) {
  const detail = body.slice(0, MAX_ERROR_CHARS);
  if (status === 401) {
    return "MWS IAM отклонил подпись ключа (HTTP 401): проверьте, что ключ не истёк (поле expirationTime) и что он выпущен тем же проектом МВС. Ответ: " + detail;
  }
  if (status === 403) {
    // 403 приходит и когда прав нет, и когда сервисного аккаунта не существует —
    // различить их можно только по телу ответа, поэтому оно приводится целиком.
    return "MWS IAM отказал сервисному аккаунту (HTTP 403): нет прав на проект или аккаунт/ключ не существует. Проверьте роли в консоли МВС и что ключ взят из нужного проекта. Ответ: " + detail;
  }
  return "MWS IAM вернул HTTP " + status + ": " + detail;
}

/**
 * IAM-токен: обмен подписанного JWT на токен доступа. Кешируется до истечения, поэтому
 * вызывать можно перед каждым запросом.
 */
export async function mwsIamToken(override?: MwsCredentialOverride): Promise<string> {
  const credential = resolveCredential(override);
  if (!credential) {
    throw new Error("МТС Web Services не настроен: задайте MWS_SA_KEY (содержимое key.json авторизованного ключа) или MWS_SA_KEY_FILE с путём к нему");
  }
  if (credential.kind === "token") return credential.token;
  // Кеш общий на процесс и относится к окружению: ключ, переданный явно для проверки,
  // не должен ни читать его, ни оставаться в нём.
  if (!override && cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) return cachedToken.token;

  const key = credential.kind === "parts" ? mwsKeyFromParts(credential) : parseMwsAuthorizedKey(await readCredential(credential));
  const host = firstEnv("MWS_IAM_HOST") ?? DEFAULT_IAM_HOST;
  const url = "https://" + host + TOKEN_PATH + "?serviceAccount=" + encodeURIComponent(key.serviceAccount);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      // Подписанный JWT идёт в заголовке **как есть**: префикс «Bearer » для него шлюз
      // МВС не понимает и отвечает 401 «Для авторизации используйте IAM token». Так же
      // его отправляет и официальный SDK (`req.Header.Add("Authorization", signed)`),
      // а «Bearer » появляется только у выданного IAM-токена — в запросах к API.
      headers: { Authorization: signMwsJwt(key), Accept: "application/json" },
    });
  } catch (error) {
    throw new Error("Не удалось обратиться к MWS IAM (" + host + "): " + messageOf(error));
  }

  const text = await response.text();
  if (!response.ok) throw new Error(describeTokenError(response.status, text));

  let parsed: { accessToken?: string; expirationTs?: string; iamToken?: string; expiresAt?: string };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new Error("MWS IAM вернул не JSON: " + text.slice(0, MAX_ERROR_CHARS));
  }
  const token = parsed.accessToken ?? parsed.iamToken;
  if (!token) throw new Error("MWS IAM не выдал токен: " + text.slice(0, MAX_ERROR_CHARS));
  const expiresAt = parseExpiration(parsed.expirationTs ?? parsed.expiresAt);
  // Без срока в ответе токен считается часовым (DefaultTokenTTL в SDK), а не вечным.
  if (!override) cachedToken = { token, expiresAt: expiresAt ?? Date.now() + 60 * 60 * 1000 };
  return token;
}

export type MwsRequest = { method?: string; host?: string; path: string; body?: unknown };

/**
 * Авторизованный запрос к API МВС. Хосты ограничены доменом `mwsapis.ru`, потому что
 * сюда попадает токен сервисного аккаунта: он не должен уходить на чужой адрес из-за
 * опечатки в пути или в подставленном хосте.
 */
export async function mwsRequest(request: MwsRequest, credential?: MwsCredentialOverride) {
  if (!request.path.startsWith("/") || request.path.includes("..")) throw new Error("Некорректный путь запроса: " + request.path);
  if (request.host === "api.mwsapis.ru") {
    throw new Error("api.mwsapis.ru — каталог эндпоинтов, а не API-шлюз. Не передавайте host: он выводится из сервиса в пути (/rm → iam.mwsapis.ru, /compute → compute.mwsapis.ru).");
  }
  const host = request.host ?? mwsHostForPath(request.path);
  if (!HOST_PATTERN.test(host)) throw new Error("Разрешены только API-хосты МТС Web Services (*.mwsapis.ru), получен " + host);
  const method = (request.method ?? "GET").toUpperCase();
  const token = await mwsIamToken(credential);
  const response = await fetch("https://" + host + request.path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  });
  const text = await response.text();
  let body: unknown = text.slice(0, 8000);
  try { body = text ? JSON.parse(text) : null; } catch { /* ответ не JSON — отдаём текстом */ }
  return { ok: response.ok, status: response.status, host, method, path: request.path, body };
}
