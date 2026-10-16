import { readFile } from "node:fs/promises";
import { parseServiceAccountKey, signServiceAccountJwt } from "../yandex/yandex-api.js";

/**
 * SMS delivery through Yandex Cloud Notification Service (CNS).
 *
 * CNS exposes an Amazon SNS-compatible HTTP API: a form-urlencoded POST to
 * https://notifications.yandexcloud.net/ with `Action=Publish` and either
 * `Authorization: Bearer <IAM-токен>` or AWS SigV4 with a static access key. The IAM
 * token is preferred here because it needs no request signing.
 *
 * Authentication is either a ready token (YANDEX_NOTIFY_IAM_TOKEN) or a service account
 * authorized key (YANDEX_SA_KEY / YANDEX_SA_KEY_FILE): the key is signed into a JWT and
 * exchanged for an IAM token — the same flow the Yandex integration card uses, reused
 * here instead of duplicating the signing.
 *
 * Two limits come from the service itself and are reported as readable errors rather
 * than generic failures: SMS is delivered only to Russian numbers, and until an
 * individual sender is registered the channel is in the sandbox, where only verified
 * test numbers receive messages.
 */

const DEFAULT_ENDPOINT = "https://notifications.yandexcloud.net/";
const IAM_TOKEN_URL = "https://iam.api.cloud.yandex.net/iam/v1/tokens";

/**
 * Every SMS must carry the SenderID attribute. A channel with a common sender is
 * addressed by this reserved name; the registered text name of an individual sender
 * replaces it through YANDEX_SMS_SENDER.
 */
const SHARED_SENDER = "cns.shared";

function firstEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

type Credential = { kind: "token"; token: string } | { kind: "rawKey"; raw: string } | { kind: "keyFile"; file: string };

export type YandexNotifyConfig = {
  endpoint: string;
  /** SenderID sent with every message: the reserved shared name or a registered one. */
  sender: string;
  folderId?: string;
  /** Cloud id — CNS requires it as `Account` when authenticating with an IAM token. */
  cloudId?: string;
  credential: Credential | null;
};

/**
 * An environment field holds one line, so a multi-line authorized key pasted into
 * YANDEX_SA_KEY is usually cut off at the first `{`. When a key file is configured as
 * well, it is the reliable source and takes over from an inline value that cannot be
 * parsed, instead of failing every send with a parse error.
 *
 * The key is preferred over a ready IAM token even when both are set, and that order is
 * the point: an IAM token lives about 12 hours, so an installation that pasted one sends
 * SMS fine for an evening and then fails every request with 401 — which is
 * indistinguishable from "SMS stopped arriving". The key path mints a fresh token from
 * the service account and caches it, so it heals itself; a leftover token variable must
 * not win over it.
 */
function credentialFromEnvironment(): Credential | null {
  const rawKey = firstEnv("YANDEX_SA_KEY");
  const keyFile = firstEnv("YANDEX_SA_KEY_FILE");
  if (rawKey && keyFile && !isUsableInlineKey(rawKey)) return { kind: "keyFile", file: keyFile };
  if (rawKey) return { kind: "rawKey", raw: rawKey };
  if (keyFile) return { kind: "keyFile", file: keyFile };
  const token = firstEnv("YANDEX_NOTIFY_IAM_TOKEN");
  if (token) return { kind: "token", token };
  return null;
}

function isUsableInlineKey(rawKey: string) {
  try {
    parseServiceAccountKey(rawKey);
    return true;
  } catch {
    return false;
  }
}

export function yandexNotifyConfig(): YandexNotifyConfig {
  const credential = credentialFromEnvironment();
  return {
    endpoint: firstEnv("YANDEX_NOTIFY_ENDPOINT") ?? DEFAULT_ENDPOINT,
    sender: firstEnv("YANDEX_SMS_SENDER", "SMS_SENDER") ?? SHARED_SENDER,
    folderId: firstEnv("YANDEX_FOLDER_ID"),
    cloudId: firstEnv("YANDEX_CLOUD_ID"),
    credential,
  };
}

export function yandexNotifyConfigured() {
  return yandexNotifyConfig().credential !== null;
}

export function yandexNotifyLabel() {
  return "Yandex Cloud Notification Service";
}

export type YandexNotifyCredentialKind = "key" | "token";

/**
 * How SMS is authenticated right now: a self-renewing key, or a ready token that expires.
 * Reported by `GET /api/auth/phone/status` and `/api/health`, so an operator can tell the
 * two apart without reading the server's environment.
 */
export function yandexNotifyCredentialKind(): YandexNotifyCredentialKind | null {
  const credential = yandexNotifyConfig().credential;
  if (!credential) return null;
  return credential.kind === "token" ? "token" : "key";
}

let cachedToken: { token: string; expiresAt: number } | null = null;

/** Test helper: IAM tokens are cached per process, so tests start from a clean cache. */
export function resetYandexNotifyCache() {
  cachedToken = null;
}

async function readCredential(credential: Credential): Promise<string> {
  if (credential.kind === "rawKey") return credential.raw;
  if (credential.kind === "keyFile") return readFile(credential.file, "utf8");
  return credential.token;
}

async function resolveIamToken(config: YandexNotifyConfig): Promise<string> {
  if (!config.credential) throw new Error("Yandex Cloud Notification Service не настроен");
  if (config.credential.kind === "token") return config.credential.token;
  if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) return cachedToken.token;

  const key = parseServiceAccountKey(await readCredential(config.credential));
  const response = await fetch(IAM_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jwt: signServiceAccountJwt(key) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error("Yandex IAM вернул " + response.status + ": " + text.slice(0, 300));
  const parsed = JSON.parse(text) as { iamToken?: string; expiresAt?: string };
  if (!parsed.iamToken) throw new Error("Yandex IAM не выдал токен");
  cachedToken = {
    token: parsed.iamToken,
    expiresAt: parsed.expiresAt ? Date.parse(parsed.expiresAt) : Date.now() + 30 * 60 * 1000,
  };
  return cachedToken.token;
}

/**
 * SubCodes the service returns for the situations a caller can actually fix. Anything
 * else falls back to the provider's own message.
 */
const ERROR_HINTS: Record<string, string> = {
  SMSSandboxNumberNotVerified: "Канал Yandex Cloud Notification Service работает в песочнице: номер не добавлен как подтверждённый тестовый. Добавьте его в консоли (канал → Телефонные номера → Добавить тестовый номер) либо зарегистрируйте индивидуального отправителя и выйдите из песочницы.",
  InvalidPhoneNumberRegion: "Yandex Cloud Notification Service отправляет SMS только на российские номера.",
  WrongSMSChannelState: "Канал SMS-уведомлений в состоянии, не позволяющем отправку (например, ещё регистрируется). Проверьте состояние канала в консоли Yandex Cloud.",
  SMSChannelIsBanned: "Канал SMS-уведомлений заблокирован сервисом.",
  SMSBodyWithMixedWords: "Текст SMS содержит слова, смешивающие латинские и кириллические символы.",
  MessageLimitExceeded: "Сообщение превышает лимит длины.",
  InvalidMessageAttribute: "Yandex Cloud отклонил атрибуты сообщения.",
};

function describeError(status: number, subCode: string | undefined, code: string | undefined, detail: string | undefined, credential: YandexNotifyCredentialKind | null) {
  if (subCode && ERROR_HINTS[subCode]) return ERROR_HINTS[subCode];
  if (status === 401 || status === 403) {
    if (credential === "token") {
      return "Yandex Cloud отклонил IAM-токен: он живёт около 12 часов, поэтому SMS идут сразу после настройки и перестают приходить позже. Поставьте ключ сервисного аккаунта (YANDEX_SA_KEY или YANDEX_SA_KEY_FILE) вместо YANDEX_NOTIFY_IAM_TOKEN — сервер сам будет получать свежий токен.";
    }
    return "Yandex Cloud отклонил авторизацию: проверьте ключ сервисного аккаунта и роль editor на каталог.";
  }
  const suffix = detail ?? subCode ?? code;
  return "Yandex Cloud вернул HTTP " + status + (suffix ? ": " + suffix : "");
}

export type YandexSmsResult = { ok: true } | { ok: false; error: string };

/**
 * Произвольный вызов CNS (Amazon SNS-совместимый Action) с тем же токеном, что и отправка:
 * нужен для чтения состояния канала — что именно настроено в Yandex Cloud, не отправляя
 * ни одного сообщения. Так «SMS не приходят» разделяется на «канал в песочнице»,
 * «нет прав» и «отправитель не зарегистрирован» без доступа к консоли.
 */
export async function callYandexNotify(action: string, params: Record<string, string> = {}) {
  const config = yandexNotifyConfig();
  if (!config.credential) return { ok: false, status: 0, body: "Yandex Cloud Notification Service не настроен" };
  let token: string;
  try {
    token = await resolveIamToken(config);
  } catch (error) {
    return { ok: false, status: 0, body: error instanceof Error ? error.message : String(error) };
  }
  const form = new URLSearchParams({ Action: action, ResponseFormat: "JSON", ...params });
  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8", Authorization: "Bearer " + token },
      body: form.toString(),
    });
    return { ok: response.ok, status: response.status, body: (await response.text()).slice(0, 1200) };
  } catch (error) {
    return { ok: false, status: 0, body: "Не удалось обратиться к Yandex Cloud: " + (error instanceof Error ? error.message : String(error)) };
  }
}

type ErrorPayload = {
  ErrorResponse?: { Error?: { Code?: string; SubCode?: string; Message?: string } };
};

/**
 * Sends one SMS. `phone` must already be E.164 (`+7…`); the caller normalises it.
 * The message type is `Transactional`, which is what a login code is — it becomes the
 * billed type once a matching template is registered for an individual sender.
 */
export async function sendYandexSms(phone: string, text: string): Promise<YandexSmsResult> {
  const config = yandexNotifyConfig();
  if (!config.credential) return { ok: false, error: "Yandex Cloud Notification Service не настроен" };

  let token: string;
  try {
    token = await resolveIamToken(config);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const form = new URLSearchParams();
  form.set("Action", "Publish");
  form.set("ResponseFormat", "JSON");
  form.set("PhoneNumber", phone);
  form.set("Message", text);
  if (config.cloudId) form.set("Account", config.cloudId);
  // Attributes go in the Amazon SNS query encoding. The flat `key`/`value` form shown
  // in the service documentation is not parsed: the service then reports
  // "Invalid parameter 'SenderID': missing argument" no matter what is sent.
  form.set("MessageAttributes.entry.1.Name", "AWS.SNS.SMS.SenderID");
  form.set("MessageAttributes.entry.1.Value.DataType", "String");
  form.set("MessageAttributes.entry.1.Value.StringValue", config.sender);
  form.set("MessageAttributes.entry.2.Name", "AWS.SNS.SMS.SMSType");
  form.set("MessageAttributes.entry.2.Value.DataType", "String");
  // Transactional is what a login code is, and it is the type a shared-sender channel accepts.
  form.set("MessageAttributes.entry.2.Value.StringValue", "Transactional");

  let response: Response;
  try {
    response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        Authorization: "Bearer " + token,
      },
      body: form.toString(),
    });
  } catch (error) {
    return { ok: false, error: "Не удалось обратиться к Yandex Cloud: " + (error instanceof Error ? error.message : String(error)) };
  }

  const data = (await response.json().catch(() => null)) as ErrorPayload | null;
  const error = data?.ErrorResponse?.Error;
  if (!response.ok || error) {
    const credential: YandexNotifyCredentialKind = config.credential.kind === "token" ? "token" : "key";
    return { ok: false, error: describeError(response.status, error?.SubCode, error?.Code, error?.Message, credential) };
  }
  return { ok: true };
}
