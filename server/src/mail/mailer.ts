import { getPlatformEnv } from "../platform/platform-env.js";
import { encodedHeader, messageId, wrap76 } from "./mime.js";
import { smtpSend, type MailDeps } from "./smtp.js";
import { recordMailFailure } from "./mail-health.js";

/**
 * Почта платформы: письма покупателям и служебные уведомления.
 *
 * Ключи группы «Почта (Yandex Cloud Postbox)» в «Настройки → Ключи сервера»: хост, порт, логин,
 * пароль и адрес отправителя. У Postbox логин и пароль — это идентификатор и секретная часть
 * API-ключа сервисного аккаунта (область `yc.postbox.send`), а не адрес ящика; домен отправителя
 * должен быть подтверждён в Postbox (DKIM). Пошаговая настройка — в docs/MAIL.md.
 *
 * `getPlatformEnv` читается на каждое письмо: ключ, сохранённый в панели, начинает работать без
 * перезапуска, а стенд без ключей честно сообщает, что почта не настроена.
 *
 * Вторая пара имён — `POSTBOX_KEY_ID` + `POSTBOX_SECRET` + `POSTBOX_SENDER`: это тот же API-ключ
 * сервисного аккаунта, только названный так, как его добавляют в секреты выкатки. Идентификатор
 * ключа — логин SMTP, секретная часть — пароль, адрес отправителя — `POSTBOX_SENDER`. Такой ключ
 * **не** подписывает REST-запросы рассылки (SigV4 требует статический ключ доступа), но для писем
 * платформы, включая ответ поддержки, его достаточно — и именно на нём письма работают на ВМ.
 */

const DEFAULT_PORT = 465;
/** Хост Postbox SMTP: подставляется, когда задана только пара POSTBOX_KEY_ID / POSTBOX_SECRET. */
export const POSTBOX_SMTP_HOST = "postbox.cloud.yandex.net";

/** Откуда взяты настройки SMTP: явные MAIL_SMTP_* или запасная пара POSTBOX_*. */
export type MailSettingsSource = "MAIL_SMTP" | "POSTBOX_KEY";

export type MailSettings = {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
  fromName?: string;
};

export type MailInput = {
  to: string;
  subject: string;
  text: string;
  /** Куда уходит ответ на письмо, если он должен попасть не на адрес отправителя. */
  replyTo?: string;
};

function env(name: string) {
  const value = getPlatformEnv(name)?.trim();
  return value || undefined;
}

function portFrom(raw: string | undefined) {
  const port = Number(raw ?? DEFAULT_PORT);
  return Number.isFinite(port) && port > 0 && port < 65536 ? Math.trunc(port) : DEFAULT_PORT;
}

/** Явные ключи SMTP: главный путь, если их заполнили в панели. */
function explicitSmtpSettings(): MailSettings | null {
  const host = env("MAIL_SMTP_HOST");
  const user = env("MAIL_SMTP_USER");
  const password = env("MAIL_SMTP_PASSWORD");
  const from = env("MAIL_FROM");
  if (!host || !user || !password || !from) return null;
  return {
    host,
    port: portFrom(env("MAIL_SMTP_PORT")),
    user,
    password,
    from,
    ...(env("MAIL_FROM_NAME") ? { fromName: env("MAIL_FROM_NAME")! } : {}),
  };
}

/**
 * Запасной путь: пара `POSTBOX_KEY_ID` / `POSTBOX_SECRET` как логин и пароль SMTP.
 *
 * Это разные вещи с ключом рассылки: здесь идентификатор и секрет API-ключа сервисного аккаунта
 * (область `yc.postbox.send`), и по SMTP он работает. Для REST тот же ключ не годится, поэтому
 * почта платформы не должна зависеть от ключей рассылки — иначе ответ на обращение падал бы
 * вместе с рассылкой.
 */
function postboxSmtpSettings(): MailSettings | null {
  const user = env("POSTBOX_KEY_ID");
  const password = env("POSTBOX_SECRET");
  const from = env("POSTBOX_SENDER");
  if (!user || !password || !from) return null;
  return {
    host: env("POSTBOX_SMTP_HOST") ?? POSTBOX_SMTP_HOST,
    port: portFrom(env("POSTBOX_SMTP_PORT")),
    user,
    password,
    from,
    ...(env("POSTBOX_FROM_NAME") ? { fromName: env("POSTBOX_FROM_NAME")! } : {}),
  };
}

export function mailSettings(): MailSettings | null {
  return explicitSmtpSettings() ?? postboxSmtpSettings();
}

/** Какие именно имена дали настройки — это видно в `/api/health`. */
export function mailSettingsSource(): MailSettingsSource | null {
  if (explicitSmtpSettings()) return "MAIL_SMTP";
  if (postboxSmtpSettings()) return "POSTBOX_KEY";
  return null;
}

export function mailConfigured() {
  return mailSettings() !== null;
}

/**
 * Простое текстовое письмо: адреса, закодированная тема и тело в base64.
 *
 * `id` передаётся вызывающим, когда он хранит идентификатор письма (ответ на обращение
 * записывается в переписку): значение в заголовке и возвращённое значение обязаны совпадать.
 */
export function buildMailMessage(settings: MailSettings, input: MailInput, date = new Date(), id = messageId()) {
  const from = settings.fromName
    ? "\"" + encodedHeader(settings.fromName) + "\" <" + settings.from + ">"
    : settings.from;
  const parts = [
    "From: " + from,
    "To: " + input.to,
    ...(input.replyTo ? ["Reply-To: " + input.replyTo] : []),
    "Subject: " + encodedHeader(input.subject),
    "Date: " + date.toUTCString(),
    "Message-ID: " + id,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(input.text, "utf8").toString("base64")),
    "",
  ];
  return parts.join("\r\n");
}

/**
 * Отправка письма. Настроек нет — это ошибка вызывающего кода с понятным текстом, а не тихий
 * пропуск: письма платформы отправляются только там, где она (настройка) уже проверена.
 *
 * Возвращается идентификатор письма: ответ на обращение хранит его в переписке, и «отправлено»
 * должно быть видно по той же строке, что и в заголовке письма. Отказ запоминается для `/api/health`
 * — снаружи иначе не отличить «не настроено» от «сервис отказал».
 */
export async function sendMail(input: MailInput, deps: MailDeps = {}): Promise<{ messageId: string }> {
  const settings = mailSettings();
  if (!settings) {
    const error = new Error(
      "Почта платформы не настроена: заполните MAIL_SMTP_HOST, MAIL_SMTP_USER, MAIL_SMTP_PASSWORD и MAIL_FROM — " +
      "либо POSTBOX_KEY_ID, POSTBOX_SECRET и POSTBOX_SENDER (ключ Postbox).",
    );
    recordMailFailure("smtp", error);
    throw error;
  }
  const id = messageId();
  try {
    await smtpSend(settings, { from: settings.from, to: input.to }, buildMailMessage(settings, input, new Date(), id), deps);
  } catch (error) {
    recordMailFailure("smtp", error);
    throw error;
  }
  return { messageId: id };
}
