import { constants, createSign, randomUUID } from "node:crypto";
import { getYandexConnection, saveYandexConnection, type YandexConnection, type YandexCredentialKind } from "./yandex-connection-store.js";

const IAM_HOST = "iam.api.cloud.yandex.net";
const IAM_TOKEN_URL = "https://" + IAM_HOST + "/iam/v1/tokens";
const RESOURCE_MANAGER = "resource-manager.api.cloud.yandex.net";
const COMPUTE = "compute.api.cloud.yandex.net";
const STORAGE = "storage.api.cloud.yandex.net";
const FUNCTIONS = "serverless-functions.api.cloud.yandex.net";
const OPERATION = "operation.api.cloud.yandex.net";
const MAX_BODY_CHARS = 8000;
const MAX_ITEMS = 50;

/** Every control-plane API of Yandex Cloud lives on this host pattern. */
const HOST_PATTERN = /^[a-z0-9-]+\.api\.cloud\.yandex\.net$/;

export const YANDEX_HOSTS = { IAM_HOST, RESOURCE_MANAGER, COMPUTE, STORAGE, FUNCTIONS, OPERATION } as const;

/**
 * The card accepts three credential formats: a service account authorized key (the
 * recommended one), an IAM token, or a legacy OAuth token.
 */
export function detectCredentialKind(secret: string): YandexCredentialKind | null {
  const value = secret.trim();
  if (value.startsWith("{")) return "key";
  if (/^t1\./.test(value)) return "iam";
  if (/^y[0-3]_/.test(value)) return "oauth";
  return null;
}

export type ServiceAccountKey = { id: string; service_account_id: string; private_key: string };

export function parseServiceAccountKey(secret: string): ServiceAccountKey {
  const key = parseAuthorizedKeyJson(secret) as Partial<ServiceAccountKey> | null;
  if (!key?.id || !key.service_account_id || !key.private_key) {
    throw new Error("В ключе нет id, service_account_id или private_key");
  }
  // A key that is not a PEM private key fails deep inside the signing call with an
  // OpenSSL message, so the format is checked here where the answer can be useful.
  if (!key.private_key.includes("BEGIN") || !key.private_key.includes("PRIVATE KEY")) {
    throw new Error("Поле private_key не похоже на PEM-ключ: вставьте JSON authorized key целиком, вместе с блоком -----BEGIN PRIVATE KEY----- и -----END PRIVATE KEY-----");
  }
  return { id: key.id, service_account_id: key.service_account_id, private_key: key.private_key };
}

/**
 * The key arrives the way it was copied, not the way the console wrote it: an editor
 * or the environment field may wrap the document in quotes, and the line breaks of the
 * downloaded file may still be real characters inside `private_key`, where JSON does
 * not allow them. Both shapes are accepted here so a correct key does not fail on the
 * transport.
 */
function parseAuthorizedKeyJson(secret: string): unknown {
  const original = secret.trim();
  let candidate = original;
  // A quoted value arrives as a JSON string, so unwrapping can take a few rounds.
  for (let round = 0; round < 4; round += 1) {
    const inner = parseQuotedDocument(candidate);
    if (inner !== undefined) {
      candidate = inner.trim();
      continue;
    }
    for (const shape of [candidate, escapeRawLineBreaks(candidate)]) {
      try { return JSON.parse(shape); } catch { /* try the next shape */ }
    }
    break;
  }
  throw new Error("Ключ сервисного аккаунта должен быть JSON-файлом authorized key. " + describePastedKey(original));
}

/** Returns the document inside a quoted value, or undefined when the value is not quoted. */
function parseQuotedDocument(value: string) {
  if (value.length < 2) return undefined;
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (!value.startsWith('"') || !value.endsWith('"')) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Re-escapes control characters that ended up inside string literals, which is what a
 * pretty-printed key pasted into a one-line field looks like. Line breaks between
 * tokens are left alone: JSON already allows those.
 */
function escapeRawLineBreaks(value: string) {
  let result = "";
  let inString = false;
  let escaped = false;
  for (const character of value) {
    if (!inString) {
      if (character === '"') inString = true;
      result += character;
      continue;
    }
    if (escaped) {
      result += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      result += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      result += character;
      inString = false;
      continue;
    }
    result += character.charCodeAt(0) < 0x20 ? JSON.stringify(character).slice(1, -1) : character;
  }
  return result;
}

/**
 * A key that does not parse is usually a paste accident rather than a wrong key, so the
 * message reports what was actually pasted instead of restating the expected format.
 */
function describePastedKey(value: string) {
  if (!value) return "Значение переменной пустое.";
  const facts: string[] = [];
  if (!value.startsWith("{")) facts.push("не начинается с «{»");
  if (!value.endsWith("}")) facts.push("не заканчивается на «}» — похоже, вставка обрезалась по первой строке");
  const lineBreaks = (value.match(/\n/g) ?? []).length;
  if (lineBreaks > 0) facts.push("содержит " + lineBreaks + " перевод(ов) строки вне строковых значений");
  facts.push("длина " + value.length + " символов");
  return "Что вставлено: " + facts.join(", ") + ".";
}

/**
 * Service account keys are signed as a JWT (PS256) and exchanged for an IAM token —
 * Yandex Cloud does not accept the private key itself as a bearer token.
 */
export function signServiceAccountJwt(key: ServiceAccountKey, now = Math.floor(Date.now() / 1000)) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const signingInput = encode({ alg: "PS256", typ: "JWT", kid: key.id }) + "." + encode({
    iss: key.service_account_id,
    aud: IAM_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  });
  const signature = createSign("sha256").update(signingInput).sign({
    key: key.private_key,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return signingInput + "." + signature.toString("base64url");
}

async function requestIamToken(connection: YandexConnection) {
  const body = connection.kind === "key"
    ? { jwt: signServiceAccountJwt(parseServiceAccountKey(connection.secret)) }
    : { yandexPassportOauthToken: connection.secret };
  const response = await fetch(IAM_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error("Yandex IAM вернул " + response.status + ": " + text.slice(0, 500));
  const parsed = JSON.parse(text) as { iamToken?: string; expiresAt?: string };
  if (!parsed.iamToken) throw new Error("Yandex IAM не выдал токен");
  return { token: parsed.iamToken, expiresAt: parsed.expiresAt ? Date.parse(parsed.expiresAt) : Date.now() + 30 * 60 * 1000 };
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function getIamTokenFor(connection: YandexConnection) {
  if (connection.kind === "iam") return connection.secret;
  const cached = tokenCache.get(connection.userId);
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
  const fresh = await requestIamToken(connection);
  tokenCache.set(connection.userId, fresh);
  return fresh.token;
}

export async function getIamToken(userId: string) {
  const connection = await getYandexConnection(userId);
  if (!connection) throw new Error("Yandex Cloud не подключён");
  return getIamTokenFor(connection);
}

export type YandexRequest = { method?: string; host?: string; path: string; body?: unknown };

/**
 * Authenticated call to a Yandex Cloud control-plane API. Reads are always allowed on a
 * connected account; anything that changes resources needs the user's explicit consent
 * (the "разрешить изменения" switch in the card).
 */
export async function yandexFetch(userId: string, request: YandexRequest) {
  const connection = await getYandexConnection(userId);
  if (!connection) throw new Error("Yandex Cloud не подключён");
  const method = (request.method ?? "GET").toUpperCase();
  const mutating = method !== "GET" && method !== "HEAD";
  if (mutating && !connection.allowWrites) {
    throw new Error("Изменения в Yandex Cloud выключены: включите «Разрешить агенту изменять ресурсы» в интеграции Yandex Cloud");
  }
  const host = request.host ?? RESOURCE_MANAGER;
  if (!HOST_PATTERN.test(host)) throw new Error("Разрешены только API-хосты Yandex Cloud (*.api.cloud.yandex.net)");
  if (!request.path.startsWith("/") || request.path.includes("..")) throw new Error("Некорректный путь запроса");

  const token = await getIamTokenFor(connection);
  const response = await fetch("https://" + host + request.path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  });
  const text = await response.text();
  let body: unknown = text.slice(0, MAX_BODY_CHARS);
  try { body = text ? JSON.parse(text) : null; } catch {}
  return { ok: response.ok, status: response.status, host, path: request.path, method, body };
}

async function listAll(userId: string, host: string, path: string) {
  const result = await yandexFetch(userId, { host, path });
  if (!result.ok) return { error: result.body };
  const parsed = result.body as { [key: string]: unknown } | null;
  const items = parsed ? Object.values(parsed).find(Array.isArray) as unknown[] | undefined : undefined;
  return { items: (items ?? []).slice(0, MAX_ITEMS) };
}

/** Compact view of the account: clouds, folders and the resources inside one folder. */
export async function listYandexResources(userId: string, folderId?: string) {
  const connection = await getYandexConnection(userId);
  if (!connection) throw new Error("Yandex Cloud не подключён");

  const clouds = await listAll(userId, RESOURCE_MANAGER, "/resource-manager/v1/clouds");
  const cloudId = connection.cloudId ?? (clouds.items?.[0] as { id?: string } | undefined)?.id;
  if (cloudId) {
    const folders = await listAll(userId, RESOURCE_MANAGER, "/resource-manager/v1/folders?cloudId=" + encodeURIComponent(cloudId));
    const targetFolder = folderId ?? connection.folderId ?? (folders.items?.[0] as { id?: string } | undefined)?.id;
    if (targetFolder) {
      const query = "?folderId=" + encodeURIComponent(targetFolder);
      const [instances, disks, buckets, functions] = await Promise.all([
        listAll(userId, COMPUTE, "/compute/v1/instances" + query),
        listAll(userId, COMPUTE, "/compute/v1/disks" + query),
        listAll(userId, STORAGE, "/storage/v1/buckets" + query),
        listAll(userId, FUNCTIONS, "/functions/v1/functions" + query),
      ]);
      return {
        cloudId,
        folderId: targetFolder,
        folders: folders.items ?? [],
        cloudErrors: clouds.error,
        instances: instances.items ?? [],
        disks: disks.items ?? [],
        buckets: buckets.items ?? [],
        functions: functions.items ?? [],
      };
    }
    return { cloudId, folderId: null, folders: folders.items ?? [], note: "В облаке нет каталогов или у ключа нет прав resource-manager.viewer" };
  }
  return { cloudId: null, clouds: clouds.items ?? [], error: clouds.error, note: "Не удалось получить список облаков — проверьте роли ключа" };
}

export async function yandexStatus(userId: string) {
  const connection = await getYandexConnection(userId);
  if (!connection) return { connected: false as const };
  return {
    connected: true as const,
    kind: connection.kind,
    account: connection.account ?? null,
    folderId: connection.folderId ?? null,
    cloudId: connection.cloudId ?? null,
    allowWrites: connection.allowWrites,
    createdAt: connection.createdAt,
  };
}

/** Validates a new credential and remembers the cloud/folder it can see. */
export async function verifyYandexCredential(secret: string) {
  const kind = detectCredentialKind(secret);
  if (!kind) throw new Error("Неизвестный формат: вставьте JSON authorized key, IAM-токен (t1.…) или OAuth-токен (y0_…)");
  const probe: YandexConnection = {
    userId: "probe",
    id: "probe",
    kind,
    secret: secret.trim(),
    allowWrites: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  let token: string;
  try {
    token = await getIamTokenFor(probe);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.includes("Поле private_key")) throw error;
    throw new Error("Yandex Cloud не принял ключ: " + detail);
  }
  const response = await fetch("https://" + RESOURCE_MANAGER + "/resource-manager/v1/clouds", { headers: { Authorization: "Bearer " + token } });
  const text = await response.text();
  if (!response.ok) throw new Error("Yandex Cloud отклонил ключ (" + response.status + "): " + text.slice(0, 400));
  const clouds = (JSON.parse(text || "{}") as { clouds?: Array<{ id?: string; name?: string }> }).clouds ?? [];
  const cloud = clouds[0];
  let folderId: string | undefined;
  if (cloud?.id) {
    const foldersResponse = await fetch("https://" + RESOURCE_MANAGER + "/resource-manager/v1/folders?cloudId=" + encodeURIComponent(cloud.id), { headers: { Authorization: "Bearer " + token } });
    if (foldersResponse.ok) {
      const folders = (await foldersResponse.json() as { folders?: Array<{ id?: string }> }).folders ?? [];
      folderId = folders[0]?.id;
    }
  }
  return { kind, cloudId: cloud?.id, cloudName: cloud?.name, folderId, iamToken: token };
}

/** The Yandex login behind an OAuth token, so the card can name the linked account. */
export async function fetchYandexLogin(oauthToken: string) {
  try {
    const response = await fetch("https://login.yandex.ru/info?format=json", { headers: { Authorization: "OAuth " + oauthToken } });
    if (!response.ok) return undefined;
    const profile = await response.json() as { login?: string; display_name?: string };
    return profile.login ?? profile.display_name;
  } catch { return undefined; }
}

export async function saveVerifiedYandexCredential(userId: string, secret: string, allowWrites: boolean, account?: string) {
  const verified = await verifyYandexCredential(secret);
  const existing = await getYandexConnection(userId);
  await saveYandexConnection({
    userId,
    id: existing?.id ?? randomUUID(),
    kind: verified.kind,
    secret: secret.trim(),
    folderId: verified.folderId,
    cloudId: verified.cloudId,
    account: account ?? verified.cloudName ?? (verified.kind === "key" ? "сервисный аккаунт" : "IAM-токен"),
    allowWrites,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  tokenCache.delete(userId);
  return yandexStatus(userId);
}
