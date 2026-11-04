import { createHash, randomUUID } from "node:crypto";
import { mwsRequest } from "../mws/mws-auth.js";
import { amzDate, awsEncode, parseS3ErrorCode, presignAwsV4, signAwsV4 } from "../services/s3.js";

/**
 * Медиа для проектов: большие картинки, видео и архивы, которые нельзя гнать через JSON
 * и тело API. Файл уходит прямо в публичный S3-бакет по presigned multipart URL, а сервер
 * только создаёт загрузку, подписывает части и завершает её.
 *
 * Отдельный HMAC-ключ здесь не хранится: сервисный аккаунт MWS обменивается на короткую
 * storage-сессию (`IssueSessionToken`). Если ключ отозван, доступ к медиа исчезает вместе
 * с ним, а в окружении не появляется ещё один бессрочный секрет.
 */

export type MediaConfig = {
  endpoint: string;
  host: string;
  bucket: string;
  region: string;
  publicBaseUrl: string;
  prefix: string;
  maxFileBytes: number;
  partSizeBytes: number;
  maxParts: number;
  urlTtlSeconds: number;
};

export class MediaError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "MediaError";
  }
}

const DEFAULT_PART_SIZE = 64 * 1024 * 1024;
const MAX_PARTS = 10_000;

function envValue(env: NodeJS.ProcessEnv, name: string) {
  return env[name]?.trim() ?? "";
}

function endpointParts(endpoint: string) {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Некорректный MEDIA_S3_ENDPOINT: " + endpoint);
  }
  if (url.protocol !== "https:") {
    throw new Error("MEDIA_S3_ENDPOINT должен начинаться с https://");
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("MEDIA_S3_ENDPOINT — это только адрес сервиса, без бакета и пути");
  }
  return { host: url.host, origin: url.origin };
}

function positiveInt(value: string, fallback: number, name: string) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(name + " должен быть положительным целым числом");
  return parsed;
}

export function mediaConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MediaConfig | null {
  const endpoint = envValue(env, "MEDIA_S3_ENDPOINT");
  const bucket = envValue(env, "MEDIA_S3_BUCKET");
  const mwsConfigured = Boolean(envValue(env, "MWS_SA_KEY") || envValue(env, "MWS_SA_KEY_ID") || envValue(env, "MWS_SA_KEY_FILE"));
  if (!endpoint && !bucket) return null;
  if (!endpoint || !bucket) {
    throw new Error("Медиа настроено не полностью: нужны MEDIA_S3_ENDPOINT и MEDIA_S3_BUCKET");
  }
  if (!mwsConfigured) {
    throw new Error("Для медиа нужен сервисный аккаунт MWS (MWS_SA_KEY, MWS_SA_KEY_ID или MWS_SA_KEY_FILE)");
  }
  const { host } = endpointParts(endpoint);
  const prefix = (envValue(env, "MEDIA_S3_PREFIX") || "media").replace(/^\/+|\/+$/g, "");
  if (!prefix || prefix.split("/").some(segment => segment === ".." || segment === ".")) {
    throw new Error("MEDIA_S3_PREFIX не должен быть пустым или содержать ..");
  }
  const publicBaseUrl = (envValue(env, "MEDIA_PUBLIC_BASE_URL") || endpoint.replace(/\/+$/, "") + "/" + bucket).replace(/\/+$/, "");
  const maxFileBytes = positiveInt(envValue(env, "MEDIA_MAX_FILE_BYTES"), 10 * 1024 * 1024 * 1024, "MEDIA_MAX_FILE_BYTES");
  const partSizeBytes = positiveInt(envValue(env, "MEDIA_PART_SIZE_BYTES"), DEFAULT_PART_SIZE, "MEDIA_PART_SIZE_BYTES");
  const maxParts = positiveInt(envValue(env, "MEDIA_MAX_PARTS"), MAX_PARTS, "MEDIA_MAX_PARTS");
  if (partSizeBytes < 5 * 1024 * 1024) throw new Error("MEDIA_PART_SIZE_BYTES не может быть меньше 5 МиБ");
  if (maxParts > MAX_PARTS) throw new Error("MEDIA_MAX_PARTS не может быть больше " + MAX_PARTS);
  return {
    endpoint,
    host,
    bucket,
    region: envValue(env, "MEDIA_S3_REGION") || "ru-1",
    publicBaseUrl,
    prefix,
    maxFileBytes,
    partSizeBytes,
    maxParts,
    urlTtlSeconds: positiveInt(envValue(env, "MEDIA_URL_TTL_SECONDS"), 3600, "MEDIA_URL_TTL_SECONDS"),
  };
}

export function mediaConfigured(env: NodeJS.ProcessEnv = process.env) {
  return mediaConfigFromEnv(env) !== null;
}

type StorageSession = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiresAt: number;
};

let sessionCache: StorageSession | null = null;
let sessionRequest: Promise<StorageSession> | null = null;

async function storageSession(): Promise<StorageSession> {
  if (sessionCache && sessionCache.expiresAt > Date.now() + 60_000) return sessionCache;
  if (sessionRequest) return sessionRequest;
  sessionRequest = (async () => {
    const response = await mwsRequest({ path: "/iam/v1/tokens/:issueSessionToken" });
    if (!response.ok) {
      throw new MediaError(
        "MEDIA_AUTH_FAILED",
        "MWS не выдал сессию для хранилища: HTTP " + response.status + " " + slice(response.body),
        502,
      );
    }
    const body = response.body as Record<string, unknown> | null;
    const accessKeyId = textField(body, "AccessKeyId", "accessKeyId");
    const secretAccessKey = textField(body, "SecretAccessKey", "secretAccessKey");
    const sessionToken = textField(body, "SessionToken", "sessionToken");
    const expiration = textField(body, "Expiration", "expiration");
    if (!accessKeyId || !secretAccessKey || !sessionToken) {
      throw new MediaError("MEDIA_AUTH_FAILED", "MWS вернул неполную storage-сессию", 502);
    }
    const expiresAt = expiration ? Date.parse(expiration) : Date.now() + 10 * 60_000;
    sessionCache = {
      accessKeyId,
      secretAccessKey,
      sessionToken,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 10 * 60_000,
    };
    return sessionCache;
  })().finally(() => {
    sessionRequest = null;
  });
  return sessionRequest;
}

function textField(body: Record<string, unknown> | null, ...names: string[]) {
  for (const name of names) {
    const value = body?.[name];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function slice(body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > 240 ? text.slice(0, 240) + "…" : text;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function objectPath(bucket: string, key: string) {
  const clean = key.replace(/^\/+/, "");
  if (!clean || clean.split("/").some(segment => segment === ".." || segment === ".")) {
    throw new MediaError("MEDIA_BAD_KEY", "Некорректный ключ медиа");
  }
  return "/" + awsEncode(bucket) + "/" + clean.split("/").map(awsEncode).join("/");
}

function queryString(query: Record<string, string> | undefined) {
  return Object.entries(query ?? {})
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => awsEncode(key) + "=" + awsEncode(value))
    .join("&");
}

async function s3Request(
  config: MediaConfig,
  method: string,
  key: string,
  options: { query?: Record<string, string>; body?: string; contentType?: string } = {},
) {
  const session = await storageSession();
  const body = options.body ?? "";
  const payloadHash = sha256(body);
  const date = amzDate();
  const headers: Record<string, string> = {
    host: config.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": date,
    "x-amz-security-token": session.sessionToken,
  };
  if (options.contentType) headers["content-type"] = options.contentType;
  const path = objectPath(config.bucket, key);
  const signed = signAwsV4({
    method,
    path,
    query: options.query,
    headers,
    payloadHash,
    amzDate: date,
    region: config.region,
    accessKey: session.accessKeyId,
    secretKey: session.secretAccessKey,
  });
  const query = queryString(options.query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch("https://" + config.host + path + (query ? "?" + query : ""), {
      method,
      headers: { ...headers, Authorization: signed.authorization },
      body: options.body === undefined ? undefined : body,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      const code = parseS3ErrorCode(text) ?? "HTTP " + response.status;
      throw new MediaError("MEDIA_STORAGE_FAILED", "Хранилище не дало " + method + " объект: " + code, 502);
    }
    return { response, text };
  } catch (error) {
    if (error instanceof MediaError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new MediaError("MEDIA_STORAGE_TIMEOUT", "Хранилище не ответило за 60 секунд", 504);
    }
    throw new MediaError("MEDIA_STORAGE_UNAVAILABLE", "Нет ответа от хранилища: " + (error instanceof Error ? error.message : String(error)), 502);
  } finally {
    clearTimeout(timer);
  }
}

async function s3BucketRequest(config: MediaConfig, query: Record<string, string>) {
  const session = await storageSession();
  const date = amzDate();
  const headers: Record<string, string> = {
    host: config.host,
    "x-amz-content-sha256": sha256(""),
    "x-amz-date": date,
    "x-amz-security-token": session.sessionToken,
  };
  const path = "/" + awsEncode(config.bucket);
  const signed = signAwsV4({
    method: "GET",
    path,
    query,
    headers,
    payloadHash: headers["x-amz-content-sha256"],
    amzDate: date,
    region: config.region,
    accessKey: session.accessKeyId,
    secretKey: session.secretAccessKey,
  });
  const qs = queryString(query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch("https://" + config.host + path + (qs ? "?" + qs : ""), {
      headers: { ...headers, Authorization: signed.authorization },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      const code = parseS3ErrorCode(text) ?? "HTTP " + response.status;
      throw new MediaError("MEDIA_STORAGE_FAILED", "Хранилище не дало список медиа: " + code, 502);
    }
    return text;
  } catch (error) {
    if (error instanceof MediaError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new MediaError("MEDIA_STORAGE_TIMEOUT", "Хранилище не ответило за 30 секунд", 504);
    }
    throw new MediaError("MEDIA_STORAGE_UNAVAILABLE", "Нет ответа от хранилища: " + (error instanceof Error ? error.message : String(error)), 502);
  } finally {
    clearTimeout(timer);
  }
}

export type MultipartUpload = {
  key: string;
  uploadId: string;
  publicUrl: string;
  partSizeBytes: number;
  partCount: number;
  parts: Array<{ partNumber: number; url: string }>;
};

export function safeMediaName(name: string) {
  const base = (name.split(/[\\/]/).pop() ?? "file").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 140);
  return base || "file";
}

export function mediaKey(config: MediaConfig, userId: string, projectId: string, name: string) {
  const date = new Date();
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return [config.prefix, userId, projectId, year, month, randomUUID() + "-" + safeMediaName(name)].join("/");
}

export function mediaPublicUrl(config: MediaConfig, key: string) {
  return config.publicBaseUrl + "/" + key.split("/").map(awsEncode).join("/");
}

/** Ключ, который вернул сервер, но не тот, который принадлежит этому проекту, не принимается. */
export function mediaKeyBelongsTo(config: MediaConfig, key: string, userId: string, projectId: string) {
  const expected = config.prefix + "/" + userId + "/" + projectId + "/";
  return key.startsWith(expected) && !key.split("/").some(segment => segment === "" || segment === "." || segment === "..");
}

export async function createMultipartUpload(
  config: MediaConfig,
  input: { userId: string; projectId: string; name: string; size: number; contentType?: string },
): Promise<MultipartUpload> {
  if (!Number.isSafeInteger(input.size) || input.size <= 0) {
    throw new MediaError("MEDIA_EMPTY_FILE", "Пустой файл");
  }
  if (input.size > config.maxFileBytes) {
    throw new MediaError("MEDIA_TOO_LARGE", "Файл больше " + Math.round(config.maxFileBytes / 1024 / 1024) + " МБ");
  }
  const partCount = Math.ceil(input.size / config.partSizeBytes);
  if (partCount > config.maxParts) {
    throw new MediaError("MEDIA_TOO_LARGE", "Файл требует слишком много частей: " + partCount + " > " + config.maxParts);
  }
  const key = mediaKey(config, input.userId, input.projectId, input.name);
  const created = await s3Request(config, "POST", key, {
    query: { uploads: "" },
    contentType: (input.contentType ?? "").replace(/[\r\n]/g, "").slice(0, 200) || "application/octet-stream",
  });
  const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(created.text)?.[1];
  if (!uploadId) throw new MediaError("MEDIA_STORAGE_FAILED", "Хранилище не вернуло UploadId", 502);
  const session = await storageSession();
  const date = amzDate();
  const path = objectPath(config.bucket, key);
  const parts = Array.from({ length: partCount }, (_, index) => ({
    partNumber: index + 1,
    url: presignAwsV4({
      method: "PUT",
      host: config.host,
      path,
      query: { partNumber: String(index + 1), uploadId },
      expiresSeconds: config.urlTtlSeconds,
      amzDate: date,
      region: config.region,
      accessKey: session.accessKeyId,
      secretKey: session.secretAccessKey,
      sessionToken: session.sessionToken,
    }),
  }));
  return {
    key,
    uploadId,
    publicUrl: mediaPublicUrl(config, key),
    partSizeBytes: config.partSizeBytes,
    partCount,
    parts,
  };
}

function xmlEscape(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function validEtag(value: string) {
  const clean = value.replace(/^"|"$/g, "");
  return /^[A-Fa-f0-9]{32}(?:-\d+)?$/.test(clean) ? clean : null;
}

export async function completeMultipartUpload(
  config: MediaConfig,
  input: { key: string; uploadId: string; parts: Array<{ partNumber: number; etag: string }>; expectedBytes: number },
) {
  if (!input.parts.length) throw new MediaError("MEDIA_BAD_PARTS", "Нет загруженных частей");
  const parts = [...input.parts]
    .sort((left, right) => left.partNumber - right.partNumber)
    .map(part => {
      const etag = validEtag(part.etag);
      if (!Number.isSafeInteger(part.partNumber) || part.partNumber < 1 || !etag) {
        throw new MediaError("MEDIA_BAD_PARTS", "Некорректный номер части или ETag");
      }
      return { partNumber: part.partNumber, etag };
    });
  const body = "<CompleteMultipartUpload>" + parts
    .map(part => "<Part><PartNumber>" + part.partNumber + "</PartNumber><ETag>\"" + xmlEscape(part.etag) + "\"</ETag></Part>")
    .join("") + "</CompleteMultipartUpload>";
  await s3Request(config, "POST", input.key, {
    query: { uploadId: input.uploadId },
    body,
    contentType: "application/xml",
  });
  const head = await s3Request(config, "HEAD", input.key);
  const size = Number(head.response.headers.get("content-length") ?? 0);
  if (!Number.isFinite(size) || size !== input.expectedBytes) {
    await s3Request(config, "DELETE", input.key).catch(() => undefined);
    throw new MediaError("MEDIA_SIZE_MISMATCH", "Хранилище приняло " + size + " байт вместо " + input.expectedBytes, 502);
  }
  return { key: input.key, publicUrl: mediaPublicUrl(config, input.key), bytes: size };
}

export async function abortMultipartUpload(config: MediaConfig, key: string, uploadId: string) {
  await s3Request(config, "DELETE", key, { query: { uploadId } });
}

/** Удаление готового объекта: нужно тестам и будущей очистке брошенных медиа. */
export async function deleteMediaObject(config: MediaConfig, key: string) {
  await s3Request(config, "DELETE", key);
}

/**
 * Сколько медиа уже лежит у пользователя. Считается по префиксу `media/<userId>/`; это нужно
 * для общей квоты тарифа, потому что объекты в бакете не попадают в размер проектов на диске.
 */
const mediaUsageCache = new Map<string, { bytes: number; at: number }>();

export async function mediaBytesForUser(config: MediaConfig, userId: string): Promise<number> {
  const cached = mediaUsageCache.get(userId);
  if (cached && Date.now() - cached.at < 30_000) return cached.bytes;
  const prefix = config.prefix + "/" + userId + "/";
  let total = 0;
  let token = "";
  let pages = 0;
  while (pages < 100) {
    const query: Record<string, string> = { "list-type": "2", prefix, "max-keys": "1000" };
    if (token) query["continuation-token"] = token;
    const page = await s3BucketRequest(config, query);
    for (const match of page.matchAll(/<Size>(\d+)<\/Size>/g)) total += Number(match[1]);
    if (!/<IsTruncated>true<\/IsTruncated>/.test(page)) break;
    const next = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(page)?.[1];
    if (!next) break;
    token = next;
    pages += 1;
  }
  mediaUsageCache.set(userId, { bytes: total, at: Date.now() });
  return total;
}

export function invalidateMediaUsage(userId: string) {
  mediaUsageCache.delete(userId);
}

export function describeMediaConfig(config: MediaConfig | null) {
  if (!config) return "медиа не настроено (MEDIA_S3_ENDPOINT/MEDIA_S3_BUCKET)";
  return "медиа: бакет " + config.bucket + " в " + config.host + ", публичный адрес " + config.publicBaseUrl;
}
