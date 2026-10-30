import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { amzDate, awsEncode, parseS3ErrorCode, signAwsV4 } from "../services/s3.js";

/**
 * S3-совместимое хранилище платформы — не путать с ключами пользователя из «Интеграций».
 *
 * Здесь лежит то, что не обязано занимать диск ВМ: архив рабочей папки проекта, а в будущем —
 * загруженные файлы и снимки. Живая рабочая папка остаётся на диске: агенту и dev-серверу нужен
 * обычный POSIX-файл, а не объект в бакете. Бакет — это холодный ярус, с диска в него уезжает
 * то, что давно не открывали (`storage/project-archive.ts`).
 *
 * Подпись AWS Signature V4 уже есть в репозитории (`services/s3.ts`): она проверена на
 * контрольном векторе AWS и используется для проверки ключей пользователя. Здесь она же, чтобы не
 * тянуть SDK ради четырёх запросов. Стиль адресации — path-style (`/<bucket>/<key>`): его
 * поддерживают все российские S3-провайдеры и MinIO.
 */

export type ObjectStoreConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  prefix: string;
};

export type BucketSummary = {
  objects: number;
  bytes: number;
  /** Обход остановлен на пределе страниц: цифры точные только для просмотренных объектов. */
  truncated: boolean;
};

export type ObjectStore = {
  readonly prefix: string;
  /** Загружает файл целиком и возвращает его размер. */
  putFile(key: string, filePath: string, contentType?: string): Promise<number>;
  /**
   * Скачивает объект в файл; `false`, если объекта нет. `onProgress` нужен холодному ярусу:
   * восстановление проекта идёт в фоне, и панель показывает, сколько байт уже на диске.
   */
  getToFile(
    key: string,
    filePath: string,
    options?: { onProgress?: (received: number, total: number) => void },
  ): Promise<boolean>;
  head(key: string): Promise<{ size: number } | null>;
  remove(key: string): Promise<void>;
};

const DEFAULT_REGION = "ru-1";
const DEFAULT_PREFIX = "webnestdev";
const READ_TIMEOUT_MS = 20_000;
const TRANSFER_TIMEOUT_MS = 15 * 60 * 1000;
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

function envValue(env: NodeJS.ProcessEnv, name: string) {
  return env[name]?.trim() ?? "";
}

/** Адрес сервиса — только хост. Путь и query в `PLATFORM_S3_ENDPOINT` означали бы, что бакет
 *  указан дважды, и подпись молча разошлась бы с реальным запросом. */
function endpointParts(endpoint: string, allowHttp: boolean) {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Некорректный адрес объектного хранилища: " + endpoint);
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new Error("Адрес объектного хранилища должен начинаться с https:// (http допускается только при PLATFORM_S3_ALLOW_HTTP=1 для локального MinIO)");
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("PLATFORM_S3_ENDPOINT — это только адрес сервиса, без бакета и пути");
  }
  return { host: url.host, origin: url.origin };
}

function normalizePrefix(prefix: string) {
  const trimmed = prefix.replace(/^\/+|\/+$/g, "");
  return trimmed || DEFAULT_PREFIX;
}

/**
 * Конфигурация из окружения. `null` — хранилище не настроено, и это нормальное состояние:
 * платформа работает так же, как до холодного яруса. Частично заполненные переменные — ошибка
 * конфигурации: с половиной ключей архивация падала бы уже на первом проекте.
 */
export function objectStoreConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ObjectStoreConfig | null {
  const endpoint = envValue(env, "PLATFORM_S3_ENDPOINT");
  const bucket = envValue(env, "PLATFORM_S3_BUCKET");
  const accessKey = envValue(env, "PLATFORM_S3_ACCESS_KEY_ID");
  const secretKey = envValue(env, "PLATFORM_S3_SECRET_ACCESS_KEY");
  if (!endpoint && !bucket && !accessKey && !secretKey) return null;
  if (!endpoint || !bucket || !accessKey || !secretKey) {
    throw new Error(
      "Объектное хранилище настроено не полностью: нужны PLATFORM_S3_ENDPOINT, PLATFORM_S3_BUCKET, " +
      "PLATFORM_S3_ACCESS_KEY_ID и PLATFORM_S3_SECRET_ACCESS_KEY",
    );
  }
  endpointParts(endpoint, envValue(env, "PLATFORM_S3_ALLOW_HTTP") === "1");
  return {
    endpoint,
    region: envValue(env, "PLATFORM_S3_REGION") || DEFAULT_REGION,
    bucket,
    accessKey,
    secretKey,
    prefix: normalizePrefix(envValue(env, "PLATFORM_S3_PREFIX") || DEFAULT_PREFIX),
  };
}

/** Строка для лога при старте: без неё «архив не создаётся» и «бакет не настроен» выглядят одинаково. */
export function describeObjectStore(env: NodeJS.ProcessEnv = process.env): string {
  let config: ObjectStoreConfig | null;
  try {
    config = objectStoreConfigFromEnv(env);
  } catch (error) {
    return "объектное хранилище: ошибка конфигурации — " + (error instanceof Error ? error.message : String(error));
  }
  if (!config) return "объектное хранилище не настроено (PLATFORM_S3_*) — проекты остаются только на диске";
  const { host } = endpointParts(config.endpoint, envValue(env, "PLATFORM_S3_ALLOW_HTTP") === "1");
  return "объектное хранилище: бакет " + config.bucket + " в " + host + ", префикс " + config.prefix;
}

/** Ключ архива одного проекта. Пользователь в пути — чтобы бакет можно было разбирать по аккаунтам. */
export function projectArchiveKey(prefix: string, userId: string, projectId: string) {
  return [normalizePrefix(prefix), "projects", userId, projectId, "workspace.tar.gz"].join("/");
}

/** Путь для подписи и запроса. Каждый сегмент кодируется по RFC 3986, слэши остаются слэшами. */
export function objectPathFor(config: Pick<ObjectStoreConfig, "bucket">, key: string) {
  const clean = key.replace(/^\/+/, "");
  if (!clean || clean.split("/").some(segment => segment === ".." || segment === ".")) {
    throw new Error("Некорректный ключ объекта: " + key);
  }
  return "/" + awsEncode(config.bucket) + "/" + clean.split("/").map(awsEncode).join("/");
}

function sha256Hex(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath: string) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function s3Error(response: Response, action: string) {
  const text = await response.text().catch(() => "");
  const code = parseS3ErrorCode(text);
  return new Error("Объектное хранилище не дало " + action + " объект: " + (code ?? "HTTP " + response.status));
}

type Deps = { fetch?: typeof fetch };

async function signedRequest(
  config: ObjectStoreConfig,
  method: string,
  key: string,
  options: { headers?: Record<string, string>; payloadHash: string; body?: unknown; timeoutMs: number },
  deps: Deps = {},
) {
  const { host, origin } = endpointParts(config.endpoint, process.env.PLATFORM_S3_ALLOW_HTTP === "1");
  const date = amzDate();
  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": options.payloadHash,
    "x-amz-date": date,
    ...options.headers,
  };
  const signedPath = objectPathFor(config, key);
  const signed = signAwsV4({
    method,
    path: signedPath,
    headers,
    payloadHash: options.payloadHash,
    amzDate: date,
    region: config.region,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const init = {
      method,
      headers: { ...headers, Authorization: signed.authorization },
      body: options.body,
      signal: controller.signal,
      duplex: "half",
    } as unknown as RequestInit;
    return await (deps.fetch ?? fetch)(origin + signedPath, init);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Объектное хранилище не ответило за " + Math.round(options.timeoutMs / 1000) + " с");
    }
    throw new Error("Нет ответа от объектного хранилища: " + (error instanceof Error ? error.message : String(error)));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Сколько объектов и байт лежит в бакете под нашим префиксом.
 *
 * Это отдельный запрос ListObjectsV2, а не обход через клиент объектов: клиент умеет читать и
 * писать конкретный ключ, а для счётчика нужен список. Пагинация ограничена: админ-снимок не
 * должен ходить по миллиону объектов и держать запрос минутами — если страниц больше предела,
 * `truncated` честно говорит, что посчитано не всё.
 */
export async function summarizeBucket(
  config: ObjectStoreConfig | null = objectStoreConfigFromEnv(),
  deps: Deps = {},
  options: { maxPages?: number; timeoutMs?: number } = {},
): Promise<BucketSummary | null> {
  if (!config) return null;
  const { host, origin } = endpointParts(config.endpoint, envValue(process.env, "PLATFORM_S3_ALLOW_HTTP") === "1");
  const maxPages = Math.max(1, Math.min(100, Math.floor(options.maxPages ?? 10)));
  // Общий предел важен не меньше страниц: зависший бакет не должен держать админ-запрос минутами.
  const deadline = Date.now() + Math.max(1_000, Math.min(120_000, options.timeoutMs ?? 30_000));
  const path = "/" + awsEncode(config.bucket);
  let token = "";
  let objects = 0;
  let bytes = 0;
  let pages = 0;
  let truncated = false;

  do {
    const query: Record<string, string> = {
      "list-type": "2",
      "max-keys": "1000",
      prefix: config.prefix,
    };
    if (token) query["continuation-token"] = token;
    const queryString = Object.entries(query)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => awsEncode(key) + "=" + awsEncode(value))
      .join("&");
    const date = amzDate();
    const headers = { host, "x-amz-content-sha256": EMPTY_SHA256, "x-amz-date": date };
    const signed = signAwsV4({
      method: "GET",
      path,
      query,
      headers,
      payloadHash: EMPTY_SHA256,
      amzDate: date,
      region: config.region,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
    });

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Обход бакета не уложился в отведённое время");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(READ_TIMEOUT_MS, remaining));
    let response: Response;
    try {
      response = await (deps.fetch ?? fetch)(origin + path + "?" + queryString, {
        method: "GET",
        headers: { ...headers, Authorization: signed.authorization },
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Объектное хранилище не ответило за отведённое время");
      }
      throw new Error("Нет ответа от объектного хранилища: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      clearTimeout(timer);
    }
    // Тело читается только у успешного ответа: s3Error сам читает XML, и второй вызов вернул бы пустоту.
    if (!response.ok) throw await s3Error(response, "посчитать");
    const text = await response.text();

    const objectPattern = /<Contents>([\s\S]*?)<\/Contents>/g;
    let match: RegExpExecArray | null;
    while ((match = objectPattern.exec(text)) !== null) {
      const size = /<Size>(\d+)<\/Size>/.exec(match[1]);
      objects++;
      if (size) bytes += Number(size[1]);
    }

    truncated = /<IsTruncated>true<\/IsTruncated>/i.test(text);
    const next = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(text);
    token = truncated && next ? next[1].trim() : "";
    pages++;
    // Предел страниц — это не конец списка: так и помечаем, чтобы экран не выдавал часть за всё.
    if (truncated && !token) break;
    if (pages >= maxPages) break;
  } while (token);

  // Если S3 сказал «есть ещё», но не дал токен, данные всё равно неполные: нельзя выдавать
  // часть за целое только потому, что предел страниц не был достигнут.
  return { objects, bytes, truncated };
}

/**
 * Клиент бакета. Ошибки сети и отказы S3 переводятся в один текст: вызывающему коду важно
 * «получилось или нет и почему», а не XML провайдера.
 */
export function s3ObjectStore(config: ObjectStoreConfig | null = objectStoreConfigFromEnv(), deps: Deps = {}): ObjectStore {
  if (!config) {
    throw new Error(
      "Объектное хранилище не настроено: задайте PLATFORM_S3_ENDPOINT, PLATFORM_S3_BUCKET, " +
      "PLATFORM_S3_ACCESS_KEY_ID и PLATFORM_S3_SECRET_ACCESS_KEY",
    );
  }
  return {
    prefix: config.prefix,
    async putFile(key, filePath, contentType = "application/octet-stream") {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error("Загружать можно только файл: " + filePath);
      const payloadHash = await sha256File(filePath);
      const response = await signedRequest(config, "PUT", key, {
        headers: { "content-type": contentType, "content-length": String(info.size) },
        payloadHash,
        body: createReadStream(filePath),
        timeoutMs: TRANSFER_TIMEOUT_MS,
      }, deps);
      if (!response.ok) throw await s3Error(response, "загрузить");
      await response.arrayBuffer().catch(() => undefined);
      return info.size;
    },
    async getToFile(key, filePath, options) {
      const response = await signedRequest(config, "GET", key, {
        payloadHash: EMPTY_SHA256,
        timeoutMs: TRANSFER_TIMEOUT_MS,
      }, deps);
      if (response.status === 404) return false;
      if (!response.ok) throw await s3Error(response, "скачать");
      if (!response.body) throw new Error("Хранилище вернуло пустой ответ вместо объекта " + key);
      await mkdir(path.dirname(filePath), { recursive: true });
      const temp = filePath + "." + process.pid + ".part";
      // Счётчик стоит в потоке, а не на событии `data`: подписка на `data` переводит поток в
      // flowing-режим и может потерять куски до того, как `pipeline` успеет подключиться.
      const total = Number(response.headers.get("content-length") ?? "") || 0;
      let received = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          options?.onProgress?.(received, total);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(Readable.fromWeb(response.body as never), counter, createWriteStream(temp));
        await rename(temp, filePath);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
      return true;
    },
    async head(key) {
      const response = await signedRequest(config, "HEAD", key, {
        payloadHash: sha256Hex(""),
        timeoutMs: READ_TIMEOUT_MS,
      }, deps);
      if (response.status === 404) return null;
      if (!response.ok) throw await s3Error(response, "проверить");
      const length = Number(response.headers.get("content-length") ?? "0");
      return { size: Number.isFinite(length) ? length : 0 };
    },
    async remove(key) {
      const response = await signedRequest(config, "DELETE", key, {
        payloadHash: EMPTY_SHA256,
        timeoutMs: READ_TIMEOUT_MS,
      }, deps);
      if (response.ok || response.status === 404) return;
      throw await s3Error(response, "удалить");
    },
  };
}
