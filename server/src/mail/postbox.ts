import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getPlatformEnv } from "../platform/platform-env.js";
import { parseServiceAccountKey, signServiceAccountJwt } from "../yandex/yandex-api.js";

/**
 * Отправка писем через Yandex Cloud Postbox по REST API v2.
 *
 * Это транспорт рассылок, а не замена почте платформы: обычные письма (оплата, предупреждение о
 * списании, поддержка) уходят по SMTP через `mail/mailer.ts`, потому что там достаточно пары
 * «логин + секрет API-ключа». Рассылке нужен другой транспорт, и причина не в удобстве: у очереди
 * свои требования — один получатель на письмо, идентификатор отправленного письма в ответе,
 * возможность остановиться на середине и посчитать, сколько ушло за сутки. REST отвечает
 * `MessageId` и не требует держать SMTP-соединение открытым.
 *
 * Аутентификация — любой из настроенных путей:
 *   POSTBOX_IAM_TOKEN — готовый токен (живёт около 12 часов);
 *   POSTBOX_KEY_ID + POSTBOX_SECRET — SigV4 со статическим ключом;
 *   ключ сервисного аккаунта (POSTBOX_SA_KEY / POSTBOX_SA_KEY_FILE, а также YANDEX_SA_KEY /
 *     YANDEX_SA_KEY_FILE) — обменивается на IAM-токен и обновляется сам;
 *   метаданные ВМ — когда на ней привязан сервисный аккаунт с ролью `postbox.sender`.
 *
 * Ключи читаются через getPlatformEnv: значение, введённое в панели «Ключи сервера», побеждает
 * переменную окружения и начинает работать без перезапуска.
 */

const DEFAULT_ENDPOINT = "https://postbox.cloud.yandex.net";
const SEND_PATH = "/v2/email/outbound-emails";
const IAM_TOKEN_URL = "https://iam.api.cloud.yandex.net/iam/v1/tokens";
const METADATA_TOKEN_URL = "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token";
const METADATA_TIMEOUT_MS = 1_500;
const METADATA_CACHE_MS = 60_000;
const SEND_TIMEOUT_MS = 20_000;
const DEFAULT_DAILY_LIMIT = 200;
const DEFAULT_PER_SECOND = 1;
/** Первые 2 000 писем в месяц Postbox не тарифицирует (см. docs/MAIL.md). */
export const POSTBOX_FREE_MONTHLY = 2_000;

function env(name: string) {
  return getPlatformEnv(name)?.trim() || undefined;
}

function positive(raw: string | undefined, fallback: number, max: number) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

export type PostboxAuth =
  | { kind: "iam"; token: string; source: string }
  | { kind: "sigv4"; keyId: string; secret: string }
  | { kind: "serviceAccount"; raw: string; source: string }
  | { kind: "serviceAccountFile"; file: string; source: string }
  | { kind: "metadata" };

export type PostboxConfig = {
  sender: string;
  fromName?: string;
  endpoint: string;
  platformUrl: string;
  dailyLimit: number;
  perSecond: number;
  /** Цена за 1 000 писем в рублях; null — не задана, и тогда стоимость не выдумывается. */
  pricePer1000: number | null;
  /** Селекторы DKIM для проверки домена; пусто — проверить можно только SPF. */
  dkimSelectors: string[];
  auth: PostboxAuth | null;
};

export type MailFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type PostboxDeps = {
  fetch: MailFetch;
  now?: () => number;
};

const defaultDeps: PostboxDeps = { fetch: (input, init) => fetch(input, init) };

export function postboxPricePer1000(): number | null {
  const raw = env("POSTBOX_PRICE_PER_1000");
  if (!raw) return null;
  const value = Number(raw.replace(",", "."));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function credentialFromEnvironment(): PostboxAuth | null {
  const token = env("POSTBOX_IAM_TOKEN");
  if (token) return { kind: "iam", token, source: "POSTBOX_IAM_TOKEN" };

  const keyId = env("POSTBOX_KEY_ID");
  const secret = env("POSTBOX_SECRET");
  if (keyId && secret) return { kind: "sigv4", keyId, secret };

  const rawKey = env("POSTBOX_SA_KEY");
  if (rawKey) return { kind: "serviceAccount", raw: rawKey, source: "POSTBOX_SA_KEY" };
  const keyFile = env("POSTBOX_SA_KEY_FILE");
  if (keyFile) return { kind: "serviceAccountFile", file: keyFile, source: "POSTBOX_SA_KEY_FILE" };
  // Ключ сервисного аккаунта платформы уже лежит на ВМ (им подписывается вход по SMS), и той же
  // роли можно выдать postbox.sender: тогда рассылке не нужен отдельный ключ.
  const sharedKey = env("YANDEX_SA_KEY");
  if (sharedKey) return { kind: "serviceAccount", raw: sharedKey, source: "YANDEX_SA_KEY" };
  const sharedFile = env("YANDEX_SA_KEY_FILE");
  if (sharedFile) return { kind: "serviceAccountFile", file: sharedFile, source: "YANDEX_SA_KEY_FILE" };

  return null;
}

export function postboxConfig(): PostboxConfig {
  const sender = env("POSTBOX_SENDER");
  const dkim = (env("POSTBOX_DKIM_SELECTORS") ?? "").split(",").map(value => value.trim()).filter(Boolean);
  return {
    sender: sender ?? "",
    ...(env("POSTBOX_FROM_NAME") ? { fromName: env("POSTBOX_FROM_NAME")! } : {}),
    endpoint: (env("POSTBOX_ENDPOINT") ?? DEFAULT_ENDPOINT).replace(/\/+$/, ""),
    platformUrl: (env("PLATFORM_URL") ?? "https://nestdev.ru").replace(/\/+$/, ""),
    dailyLimit: positive(env("POSTBOX_DAILY_LIMIT"), DEFAULT_DAILY_LIMIT, 100_000),
    perSecond: positive(env("POSTBOX_RATE_PER_SECOND"), DEFAULT_PER_SECOND, 50),
    pricePer1000: postboxPricePer1000(),
    dkimSelectors: dkim,
    auth: credentialFromEnvironment(),
  };
}

let metadataCache: { ok: boolean; at: number } | null = null;

/**
 * Метаданные ВМ — последний вариант, но не ошибка: на ВМ с привязанным сервисным аккаунтом токен
 * приходит сам, и ключ хранить не нужно. Проверка короткая и кэшируется на минуту, поэтому
 * недоступный адрес метаданных не задерживает ни отправку, ни экран админки.
 */
async function metadataAvailable(deps: PostboxDeps, now: number): Promise<boolean> {
  if (metadataCache && metadataCache.at + METADATA_CACHE_MS > now) return metadataCache.ok;
  const ok = await deps
    .fetch(METADATA_TOKEN_URL, { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) })
    .then(response => response.ok)
    .catch(() => false);
  metadataCache = { ok, at: now };
  return ok;
}

export type PostboxStatus = {
  configured: boolean;
  reason?: string;
  config: PostboxConfig;
  /** Как именно отправляем: подпись ключом, IAM-токен или токен из метаданных ВМ. */
  authKind?: PostboxAuth["kind"];
  authSource?: string;
};

/**
 * Готова ли рассылка к отправке — без единого письма. Проверяются адрес отправителя и наличие
 * ключа: «ключ есть» и «ключ читается» — разные вещи, и разница должна быть видна до рассылки.
 */
export async function postboxStatus(config = postboxConfig(), deps: PostboxDeps = defaultDeps): Promise<PostboxStatus> {
  if (!config.sender || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(config.sender)) {
    return {
      configured: false,
      reason: config.sender
        ? "Адрес отправителя не похож на почтовый: " + config.sender
        : "Не задан адрес отправителя (POSTBOX_SENDER) — рассылка не может представиться.",
      config,
    };
  }
  if (config.auth) {
    return {
      configured: true,
      config,
      authKind: config.auth.kind,
      authSource: config.auth.kind === "sigv4" ? "POSTBOX_KEY_ID" : config.auth.kind === "metadata" ? "метаданные ВМ" : config.auth.source,
    };
  }
  if (await metadataAvailable(deps, deps.now?.() ?? Date.now())) {
    return { configured: true, config: { ...config, auth: { kind: "metadata" } }, authKind: "metadata", authSource: "метаданные ВМ" };
  }
  return {
    configured: false,
    reason:
      "Нет ключа Postbox: задайте POSTBOX_IAM_TOKEN, либо POSTBOX_KEY_ID и POSTBOX_SECRET, либо ключ сервисного аккаунта с ролью postbox.sender.",
    config,
  };
}

/** Строка в логе старта: чем отправляется рассылка и с какими пределами. */
export function describePostbox(status: PostboxStatus) {
  const config = status.config;
  if (!status.configured) return "рассылки: не настроены — " + status.reason;
  const auth = status.authKind === "sigv4" ? "SigV4 (статический ключ)" : status.authKind === "metadata" ? "токен из метаданных ВМ" : status.authKind === "iam" ? "IAM-токен" : "ключ сервисного аккаунта";
  return (
    "рассылки: Postbox, отправитель " + (config.fromName ? config.fromName + " <" + config.sender + ">" : config.sender) +
    ", ключ: " + auth + ", предел " + config.dailyLimit + " писем в сутки, " + config.perSecond + " в секунду" +
    (config.pricePer1000 === null ? ", цена за 1000 писем не задана" : ", " + config.pricePer1000 + " ₽ за 1000")
  );
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: Buffer | string, value: string) {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

/**
 * SigV4: подпись запроса статическим ключом (регион ru-central1, сервис ses — так Postbox устроен
 * внутри: это AWS-совместимый API Yandex Cloud). Подписываются ровно те заголовки, которые
 * отправляются, иначе подпись не сойдётся.
 */
export function signPostboxRequest(input: {
  method: string;
  host: string;
  path: string;
  body: string;
  keyId: string;
  secret: string;
  date?: Date;
}) {
  const date = input.date ?? new Date();
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const region = "ru-central1";
  const service = "ses";
  const payloadHash = sha256Hex(input.body);

  const canonicalHeaders = "host:" + input.host + "\n" + "x-amz-date:" + amzDate + "\n";
  const signedHeaders = "host;x-amz-date";
  const canonicalRequest = [input.method, input.path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = day + "/" + region + "/" + service + "/aws4_request";
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac("AWS4" + input.secret, day), region), service), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  return {
    amzDate,
    headers: {
      "x-amz-date": amzDate,
      authorization:
        "AWS4-HMAC-SHA256 Credential=" + input.keyId + "/" + scope + ", SignedHeaders=" + signedHeaders + ", Signature=" + signature,
    } as Record<string, string>,
  };
}

let cachedIam: { token: string; expiresAt: number } | null = null;

/** Тесты начинают с чистого кеша: токен и метаданные живут на процесс. */
export function resetPostboxCache() {
  cachedIam = null;
  metadataCache = null;
}

async function readServiceAccountKey(auth: PostboxAuth): Promise<string> {
  if (auth.kind === "serviceAccount") return auth.raw;
  if (auth.kind !== "serviceAccountFile") throw new Error("Ключ сервисного аккаунта не задан");
  try {
    return await readFile(auth.file, "utf8");
  } catch {
    throw new Error(
      "Файл ключа сервисного аккаунта не открылся: " + auth.file +
      ". Путь должен существовать внутри контейнера сервера (например /var/lib/webnestdev/secrets/yandex-sa-key.json), либо задайте ключ одной строкой в POSTBOX_SA_KEY.",
    );
  }
}

async function iamToken(config: PostboxConfig, deps: PostboxDeps): Promise<string> {
  const now = deps.now?.() ?? Date.now();
  if (config.auth?.kind === "iam") return config.auth.token;
  if (cachedIam && cachedIam.expiresAt - 60_000 > now) return cachedIam.token;

  if (config.auth?.kind === "metadata") {
    const response = await deps.fetch(METADATA_TOKEN_URL, { headers: { "Metadata-Flavor": "Google" } });
    if (!response.ok) throw new Error("Метаданные ВМ не выдали токен сервисного аккаунта: " + response.status);
    const parsed = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!parsed.access_token) throw new Error("Метаданные ВМ ответили без access_token");
    cachedIam = { token: parsed.access_token, expiresAt: now + Math.max(60, Number(parsed.expires_in ?? 3600)) * 1000 };
    return cachedIam.token;
  }
  if (config.auth?.kind !== "serviceAccount" && config.auth?.kind !== "serviceAccountFile") {
    throw new Error("Postbox не настроен: нет ни IAM-токена, ни ключа сервисного аккаунта");
  }

  const key = parseServiceAccountKey(await readServiceAccountKey(config.auth));
  const response = await deps.fetch(IAM_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jwt: signServiceAccountJwt(key) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error("Yandex IAM вернул " + response.status + ": " + text.slice(0, 300));
  const parsed = JSON.parse(text) as { iamToken?: string; expiresAt?: string };
  if (!parsed.iamToken) throw new Error("Yandex IAM не выдал токен");
  cachedIam = {
    token: parsed.iamToken,
    expiresAt: parsed.expiresAt ? Date.parse(parsed.expiresAt) : now + 30 * 60 * 1000,
  };
  return cachedIam.token;
}

export type PostboxMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /**
   * Адрес для ответа. Нужен письмам-ответам поддержки: письмо уходит от сервисного ящика, а
   * человек, нажав «Ответить», должен попасть в поддержку, а не на адрес без ответа.
   */
  replyTo?: string;
};

export type PostboxSendResult = { messageId: string; status: number };

/**
 * Одно письмо — один получатель. Не SendBulkEmail: пакетный режим требует шаблонов на стороне
 * сервиса, не даёт остановить очередь на середине и плохо дружит с отписками, а чужие адреса в
 * одном запросе ещё и попадают в общую транзакцию.
 */
export async function sendPostboxEmail(message: PostboxMessage, deps: PostboxDeps = defaultDeps): Promise<PostboxSendResult> {
  const status = await postboxStatus(postboxConfig(), deps);
  if (!status.configured) throw new Error(status.reason);
  const config = status.config;

  const from = config.fromName ? config.fromName + " <" + config.sender + ">" : config.sender;
  const body = JSON.stringify({
    FromEmailAddress: from,
    Destination: { ToAddresses: [message.to] },
    ...(message.replyTo ? { ReplyToAddresses: [message.replyTo] } : {}),
    Content: {
      Simple: {
        Subject: { Data: message.subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: message.text, Charset: "UTF-8" },
          ...(message.html ? { Html: { Data: message.html, Charset: "UTF-8" } } : {}),
        },
      },
    },
  });

  const url = config.endpoint + SEND_PATH;
  const headers: Record<string, string> = { "content-type": "application/json" };

  if (config.auth?.kind === "sigv4") {
    const host = new URL(url).host;
    const signed = signPostboxRequest({
      method: "POST",
      host,
      path: SEND_PATH,
      body,
      keyId: config.auth.keyId,
      secret: config.auth.secret,
      date: new Date(deps.now?.() ?? Date.now()),
    });
    Object.assign(headers, signed.headers);
  } else {
    headers["X-YaCloud-SubjectToken"] = await iamToken(config, deps);
  }

  const response = await deps.fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
  const text = await response.text();
  if (!response.ok) {
    throw new Error("Postbox отказал (" + response.status + "): " + (text.replace(/\s+/g, " ").trim().slice(0, 300) || "пустой ответ"));
  }
  let messageId = "";
  try {
    const parsed = JSON.parse(text) as { MessageId?: string; messageId?: string };
    messageId = parsed.MessageId ?? parsed.messageId ?? "";
  } catch {
    messageId = "";
  }
  return { messageId, status: response.status };
}
