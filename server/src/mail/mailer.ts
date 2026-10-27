import { getPlatformEnv } from "../platform/platform-env.js";
import { encodedHeader, messageId, wrap76 } from "./mime.js";
import { smtpSend, type MailDeps } from "./smtp.js";

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
 */

const DEFAULT_PORT = 465;

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

export function mailSettings(): MailSettings | null {
  const host = env("MAIL_SMTP_HOST");
  const user = env("MAIL_SMTP_USER");
  const password = env("MAIL_SMTP_PASSWORD");
  const from = env("MAIL_FROM");
  if (!host || !user || !password || !from) return null;
  const port = Number(env("MAIL_SMTP_PORT") ?? DEFAULT_PORT);
  return {
    host,
    port: Number.isFinite(port) && port > 0 && port < 65536 ? Math.trunc(port) : DEFAULT_PORT,
    user,
    password,
    from,
    ...(env("MAIL_FROM_NAME") ? { fromName: env("MAIL_FROM_NAME")! } : {}),
  };
}

export function mailConfigured() {
  return mailSettings() !== null;
}

/** Простое текстовое письмо: адреса, закодированная тема и тело в base64. */
export function buildMailMessage(settings: MailSettings, input: MailInput, date = new Date()) {
  const from = settings.fromName
    ? "\"" + encodedHeader(settings.fromName) + "\" <" + settings.from + ">"
    : settings.from;
  const parts = [
    "From: " + from,
    "To: " + input.to,
    ...(input.replyTo ? ["Reply-To: " + input.replyTo] : []),
    "Subject: " + encodedHeader(input.subject),
    "Date: " + date.toUTCString(),
    "Message-ID: " + messageId(),
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
 */
export function sendMail(input: MailInput, deps: MailDeps = {}): Promise<void> {
  const settings = mailSettings();
  if (!settings) {
    return Promise.reject(new Error("Почта платформы не настроена: заполните группу «Почта (Yandex Cloud Postbox)» в ключах сервера"));
  }
  return smtpSend(settings, { from: settings.from, to: input.to }, buildMailMessage(settings, input), deps);
}
