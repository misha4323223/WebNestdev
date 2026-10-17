import { sendYandexSms, yandexNotifyConfigured, yandexNotifyCredentialKind, yandexNotifyCredentialStatus, yandexNotifyLabel } from "./yandex-notify.js";
import { getPlatformEnv } from "../platform/platform-env.js";

/**
 * SMS delivery for phone login. Only Russian providers are supported, because that is
 * where this product's users are: Yandex Cloud Notification Service, SMS.RU, SMSC.ru,
 * MTS Exolve and SMS Aero. Each is a plain HTTP API with a credential in the
 * environment, so the login flow does not depend on a specific vendor and can be
 * switched with SMS_PROVIDER.
 *
 * Yandex Cloud Notification Service is the first choice when configured: it keeps the
 * whole stack inside Yandex Cloud and authenticates with an IAM token or a service
 * account key (see yandex-notify.ts).
 *
 * Without a key the server runs in test mode: the code is never sent, it is logged and
 * (outside production) returned to the caller so the whole flow can be tested.
 */
export type SmsProviderId = "yandex" | "smsru" | "smsc" | "exolve" | "smsaero";

export type SmsConfig = {
  provider: SmsProviderId | null;
  sender: string;
  /** Test mode is on when the operator asked for it or no provider is configured. */
  test: boolean;
};

/** The sender name is registered at the provider; empty means the provider default. */
const DEFAULT_SENDER = "WebNestdev";

function firstEnv(...names: string[]) {
  for (const name of names) {
    const value = getPlatformEnv(name)?.trim();
    if (value) return value;
  }
  return undefined;
}

export function smsTestMode() {
  const value = getPlatformEnv("WEBNESTDEV_SMS_TEST_MODE")?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/**
 * Provider resolution: the explicit SMS_PROVIDER wins, otherwise the first provider
 * whose credentials are present is used, so adding one key in the environment is enough.
 */
export function smsConfig(): SmsConfig {
  const sender = firstEnv("SMS_SENDER", "WEBNESTDEV_SMS_SENDER") ?? DEFAULT_SENDER;
  const requested = firstEnv("SMS_PROVIDER", "WEBNESTDEV_SMS_PROVIDER")?.toLowerCase();
  const available: SmsProviderId[] = [];
  if (yandexNotifyConfigured()) available.push("yandex");
  if (firstEnv("SMS_RU_API_ID")) available.push("smsru");
  if (firstEnv("SMSC_LOGIN") && firstEnv("SMSC_PASSWORD")) available.push("smsc");
  if (firstEnv("EXOLVE_API_KEY")) available.push("exolve");
  if (firstEnv("SMSAERO_EMAIL") && firstEnv("SMSAERO_API_KEY")) available.push("smsaero");

  const provider = (requested && available.includes(requested as SmsProviderId) ? requested as SmsProviderId : null) ?? available[0] ?? null;
  return { provider, sender, test: smsTestMode() || !provider };
}

export function smsProviderLabel(provider: SmsProviderId | null) {
  if (provider === "yandex") return yandexNotifyLabel();
  if (provider === "smsru") return "SMS.RU";
  if (provider === "smsc") return "SMSC.ru";
  if (provider === "exolve") return "МТС Exolve";
  if (provider === "smsaero") return "SMS Aero";
  return "не подключён";
}

/**
 * A short, honest note for the sign-in screen and logs: what the active provider can and
 * cannot do right now. Yandex Cloud Notification Service has real product limits here,
 * and a ready IAM token has a lifetime — both are the difference between "SMS stopped
 * arriving" and a configuration that is simply wrong.
 */
export function smsConfigHint() {
  const config = smsConfig();
  if (config.provider === "yandex") {
    const notes = ["Yandex Cloud Notification Service: SMS уходят только на российские номера. Пока у канала общий отправитель, действует песочница — сообщения получают только подтверждённые тестовые номера."];
    if (yandexNotifyCredentialKind() === "token") {
      notes.push("Вход настроен на готовый IAM-токен (YANDEX_NOTIFY_IAM_TOKEN): он живёт около 12 часов, после чего SMS перестают уходить. Поставьте ключ сервисного аккаунта — YANDEX_SA_KEY или YANDEX_SA_KEY_FILE: сервер сам получит свежий токен.");
    }
    return notes.join(" ");
  }
  if (!config.provider) {
    return "SMS-провайдер не подключён: код входа не отправляется, а только пишется в лог сервера. Задайте YANDEX_SA_KEY с YANDEX_CLOUD_ID, либо SMS_RU_API_ID, либо SMSC_LOGIN+SMSC_PASSWORD, либо EXOLVE_API_KEY, либо SMSAERO_EMAIL+SMSAERO_API_KEY.";
  }
  return undefined;
}

/**
 * Готов ли выбранный способ аутентификации к работе — проверка, которая не отправляет
 * сообщение. Выбранный ключ может быть не задан или указывать на отсутствующий файл, и тогда
 * вход по номеру не работает вообще: раньше это выяснялось только на первой отправке
 * (ENOENT в ответе), хотя /api/health и экран входа уже говорили «ключ».
 */
export async function smsReadiness(): Promise<{ ready: boolean; keyFile?: string; note?: string; problem?: string }> {
  if (smsConfig().provider !== "yandex") return { ready: true };
  const status = await yandexNotifyCredentialStatus();
  return {
    ready: status.ready,
    ...(status.file === undefined ? {} : { keyFile: status.file }),
    ...(status.note === undefined ? {} : { note: status.note }),
    ...(status.problem === undefined ? {} : { problem: status.problem }),
  };
}

/**
 * Secret-free summary of the active SMS path for `/api/health` and the operator's launch
 * checklist: the provider's name, whether messages are really sent, and how the Yandex
 * path authenticates (a self-renewing key or a token that expires).
 */
export function smsSummary() {
  const config = smsConfig();
  return {
    provider: config.provider,
    label: smsProviderLabel(config.provider),
    testMode: config.test,
    credentialKind: yandexNotifyCredentialKind(),
  };
}

export type SmsResult = {
  ok: boolean;
  provider: SmsProviderId | "test";
  providerLabel: string;
  test: boolean;
  error?: string;
};

/** One place per provider: the API call that delivers a single message. */
async function deliver(provider: SmsProviderId, phone: string, text: string, sender: string, test: boolean): Promise<SmsResult> {
  const label = smsProviderLabel(provider);
  try {
    if (provider === "yandex") {
      const result = await sendYandexSms(phone, text);
      return { ok: result.ok, provider, providerLabel: label, test, ...(result.ok ? {} : { error: result.error }) };
    }

    if (provider === "smsru") {
      const body = new URLSearchParams({
        api_id: firstEnv("SMS_RU_API_ID") ?? "",
        to: phone.replace("+", ""),
        msg: text,
        json: "1",
        ...(test ? { test: "1" } : {}),
        ...(sender ? { from: sender } : {}),
      });
      const response = await fetch("https://sms.ru/sms/send", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
      const data = await response.json().catch(() => null) as { status?: string; status_text?: string } | null;
      if (!response.ok || data?.status !== "OK") {
        return { ok: false, provider, providerLabel: label, test, error: data?.status_text ?? "SMS.RU вернул HTTP " + response.status };
      }
      return { ok: true, provider, providerLabel: label, test };
    }

    if (provider === "smsc") {
      const body = new URLSearchParams({
        login: firstEnv("SMSC_LOGIN") ?? "",
        psw: firstEnv("SMSC_PASSWORD") ?? "",
        phones: phone.replace("+", ""),
        mes: text,
        fmt: "3",
        ...(sender ? { sender } : {}),
      });
      const response = await fetch("https://smsc.ru/sys/send.php", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
      const data = await response.json().catch(() => null) as { error?: string; error_code?: number } | null;
      if (!response.ok || data?.error) {
        return { ok: false, provider, providerLabel: label, test, error: data?.error ?? "SMSC.ru вернул HTTP " + response.status };
      }
      return { ok: true, provider, providerLabel: label, test };
    }

    if (provider === "exolve") {
      const response = await fetch("https://api.exolve.ru/messaging/v1/SendSMS", {
        method: "POST",
        headers: { Authorization: "Bearer " + (firstEnv("EXOLVE_API_KEY") ?? ""), "Content-Type": "application/json" },
        body: JSON.stringify({ number: sender, destination: phone, text }),
      });
      const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      if (!response.ok) {
        return { ok: false, provider, providerLabel: label, test, error: data?.error?.message ?? "МТС Exolve вернул HTTP " + response.status };
      }
      return { ok: true, provider, providerLabel: label, test };
    }

    // SMS Aero authenticates with the account email and an API key over HTTP Basic.
    const credentials = Buffer.from((firstEnv("SMSAERO_EMAIL") ?? "") + ":" + (firstEnv("SMSAERO_API_KEY") ?? ""), "utf8").toString("base64");
    const response = await fetch("https://gateway.smsaero.ru/v2/sms/send?" + new URLSearchParams({
      number: phone.replace("+", ""),
      text,
      sign: sender,
      ...(test ? { test: "1" } : {}),
    }).toString(), { method: "POST", headers: { Authorization: "Basic " + credentials } });
    const data = await response.json().catch(() => null) as { success?: boolean; message?: string } | null;
    if (!response.ok || data?.success === false) {
      return { ok: false, provider, providerLabel: label, test, error: data?.message ?? "SMS Aero вернул HTTP " + response.status };
    }
    return { ok: true, provider, providerLabel: label, test };
  } catch (error) {
    return { ok: false, provider, providerLabel: label, test, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Sends the login code. In test mode nothing leaves the server: the caller gets
 * `test: true` and the code is written to the log for the person testing the flow.
 */
export async function sendLoginCode(phone: string, code: string): Promise<SmsResult> {
  const config = smsConfig();
  const text = "Код входа в WebNestdev: " + code + ". Никому его не сообщайте.";
  if (config.test || !config.provider) {
    console.warn("[WebNestDev] SMS test mode: login code for " + phone + " is " + code + " (configure YANDEX_NOTIFY_IAM_TOKEN or YANDEX_SA_KEY+YANDEX_CLOUD_ID, SMS_RU_API_ID, SMSC_LOGIN+SMSC_PASSWORD, EXOLVE_API_KEY or SMSAERO_EMAIL+SMSAERO_API_KEY to send real messages)");
    return { ok: true, provider: "test", providerLabel: smsProviderLabel(config.provider), test: true };
  }
  const result = await deliver(config.provider, phone, text, config.sender, false);
  if (!result.ok) {
    // Без этой строки неудачная отправка остаётся только ответом на запрос: человек
    // видит «Не удалось отправить SMS», а в логах сервера нет ничего, и причину
    // (песочница, истёкший токен, отказ провайдера) нечем объяснить.
    // Смотреть: docker compose logs webnestdev-server
    console.error("[WebNestDev] SMS не отправлено («" + result.providerLabel + "»), номер " + phone + ": " + (result.error ?? "провайдер отклонил запрос"));
  }
  return result;
}
