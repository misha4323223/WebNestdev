import { randomUUID } from "node:crypto";
import { getPlatformEnv } from "../platform/platform-env.js";
import { mailSettings } from "../mail/mailer.js";
import { encodedHeader, wrap76 } from "../mail/mime.js";
import { smtpSend, type MailDeps, type MailSocket } from "../mail/smtp.js";
import type { SupportReporter } from "./support-store.js";

/**
 * Почта поддержки: обращение из кнопки «Поддержка» уходит письмом на ящик платформы.
 *
 * Ключи берутся в порядке важности: сначала почта платформы — группа «Почта (Yandex Cloud
 * Postbox)», потом личный SMTP обычной почты (`SUPPORT_SMTP_*`: Яндекс, Mail.ru, Gmail). Так
 * Postbox и есть основной путь: письма уходят от подтверждённого домена сервиса, а старые
 * ключи отдельного ящика продолжают работать. Значения читаются через getPlatformEnv, поэтому
 * включение почты не требует перезапуска.
 *
 * Reply-To указывает на автора обращения: ответ на письмо уходит пользователю напрямую, без
 * ручного копирования адреса из тикета.
 *
 * Разговор по SMTP общий для всей платформы (mail/smtp.ts) и поддерживает только шифрование
 * сразу (порт 465): STARTTLS требует отдельного шага, а молчаливая отправка без шифрования
 * отдала бы пароль сервисного аккаунта открытым текстом.
 */

const DEFAULT_PORT = 465;

export type SupportMailSettings = {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
  to: string;
};

/** Данные тикета, которые попадают в письмо. Скриншот кладётся вложением. */
export type SupportMailTicket = {
  id: string;
  category: "bug" | "idea";
  severity: number;
  email: string;
  description: string;
  createdAt: string;
  steps?: string;
  context?: string;
  page?: string;
  projectId?: string;
  ip?: string;
  /** Снимок аккаунта: письмо должно отвечать «кто пишет» без открытия админки. */
  reporter?: SupportReporter;
};

function env(name: string) {
  const value = getPlatformEnv(name)?.trim();
  return value || undefined;
}

export function supportMailSettings(): SupportMailSettings | null {
  const to = env("SUPPORT_EMAIL_TO");
  if (!to) return null;
  // Почтовая служба платформы важнее личного SMTP: с Postbox письма уходят от подтверждённого
  // домена сервиса и не зависят от пароля приложения в чужом ящике.
  const platform = mailSettings();
  if (platform) {
    return { host: platform.host, port: platform.port, user: platform.user, password: platform.password, from: platform.from, to };
  }
  const host = env("SUPPORT_SMTP_HOST");
  const user = env("SUPPORT_SMTP_USER");
  const password = env("SUPPORT_SMTP_PASSWORD");
  if (!host || !user || !password) return null;
  const port = Number(env("SUPPORT_SMTP_PORT") ?? DEFAULT_PORT);
  return {
    host,
    port: Number.isFinite(port) && port > 0 && port < 65536 ? Math.trunc(port) : DEFAULT_PORT,
    user,
    password,
    to,
    from: env("SUPPORT_EMAIL_FROM") ?? user,
  };
}

const CATEGORY: Record<SupportMailTicket["category"], string> = { bug: "Баг", idea: "Идея" };

export function supportMailSubject(ticket: SupportMailTicket) {
  return "[Поддержка] " + CATEGORY[ticket.category] + " · важность " + ticket.severity + "/10";
}

export function supportMailBody(ticket: SupportMailTicket) {
  const lines = [
    "Новое обращение в поддержку.",
    "",
    "Тип: " + CATEGORY[ticket.category],
    "Важность: " + ticket.severity + " / 10",
    "Пользователь: " + ticket.email,
    "Получено: " + new Date(ticket.createdAt).toLocaleString("ru-RU"),
  ];
  const reporter = ticket.reporter;
  if (reporter) {
    if (reporter.name) lines.push("Имя: " + reporter.name);
    if (reporter.contactEmail && reporter.contactEmail !== ticket.email) lines.push("Почта для связи: " + reporter.contactEmail);
    if (reporter.phone) lines.push("Телефон: " + reporter.phone);
    lines.push("Тариф: " + reporter.planName);
    lines.push("Аккаунт с: " + new Date(reporter.accountCreatedAt).toLocaleString("ru-RU"));
    lines.push("Проектов: " + reporter.projects);
    if (reporter.lastActiveAt) lines.push("Последняя активность: " + new Date(reporter.lastActiveAt).toLocaleString("ru-RU"));
  }
  if (ticket.ip) lines.push("IP: " + ticket.ip);
  if (ticket.projectId) lines.push("Проект: " + ticket.projectId);
  if (ticket.page) lines.push("Страница: " + ticket.page);
  lines.push("", "Описание", "--------", ticket.description);
  if (ticket.steps) lines.push("", "Как повторить", "-------------", ticket.steps);
  if (ticket.context) lines.push("", "Дополнительный контекст", "-----------------------", ticket.context);
  lines.push(
    "",
    "Скриншот — во вложении.",
    "Ответить можно прямо на это письмо: Reply-To указывает на автора обращения.",
  );
  return lines.join("\n");
}

export function supportMailMessage(
  settings: SupportMailSettings,
  ticket: SupportMailTicket,
  screenshot?: { buffer: Buffer; mime: string } | null,
) {
  const boundary = "support-" + randomUUID();
  const parts = [
    "From: " + encodedHeader(settings.from),
    "To: " + encodedHeader(settings.to),
    "Reply-To: " + encodedHeader(ticket.email),
    "Subject: " + encodedHeader(supportMailSubject(ticket)),
    "Date: " + new Date(ticket.createdAt).toUTCString(),
    "Message-ID: <" + ticket.id + "@webnestdev>",
    "X-Support-Ticket: " + ticket.id,
    "MIME-Version: 1.0",
    "Content-Type: multipart/mixed; boundary=\"" + boundary + "\"",
    "",
    "--" + boundary,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(supportMailBody(ticket), "utf8").toString("base64")),
  ];
  if (screenshot) {
    const extension = screenshot.mime === "image/png" ? "png" : screenshot.mime === "image/webp" ? "webp" : "jpg";
    parts.push(
      "--" + boundary,
      "Content-Type: " + screenshot.mime + "; name=\"screenshot." + extension + "\"",
      "Content-Transfer-Encoding: base64",
      "Content-Disposition: attachment; filename=\"screenshot." + extension + "\"",
      "",
      wrap76(screenshot.buffer.toString("base64")),
    );
  }
  parts.push("--" + boundary + "--", "");
  return parts.join("\r\n");
}

/** Socket и deps — общие для всей платформы (mail/smtp.ts); псевдонимы сохраняют прежние имена. */
export type SupportMailSocket = MailSocket;
export type SupportMailDeps = MailDeps;

/**
 * Письмо поддержки уходит тем же SMTP-разговором, что и остальные письма платформы. Любой отказ
 * сервера превращается в понятную ошибку, чтобы её было видно в логе, а обращение при этом
 * осталось сохранённым на диске.
 */
export function sendSupportMail(
  settings: SupportMailSettings,
  ticket: SupportMailTicket,
  screenshot?: { buffer: Buffer; mime: string } | null,
  deps: SupportMailDeps = {},
): Promise<void> {
  const message = supportMailMessage(settings, ticket, screenshot);
  return smtpSend(settings, { from: settings.from, to: settings.to }, message, deps);
}
