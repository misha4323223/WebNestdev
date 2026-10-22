import tls from "node:tls";
import { randomUUID } from "node:crypto";
import { getPlatformEnv } from "../platform/platform-env.js";

/**
 * Почта поддержки: обращение из кнопки «Поддержка» уходит письмом на ящик платформы.
 *
 * Отдельный сервис для этого не нужен: подходит SMTP обычной почты (Яндекс, Mail.ru, Gmail) —
 * сервер входит в ящик и отправляет письмо на него же. Ключи вводятся в «Ключи сервера» и
 * читаются через getPlatformEnv, поэтому включение почты не требует перезапуска.
 *
 * Reply-To указывает на автора обращения: ответ на письмо уходит пользователю напрямую, без
 * ручного копирования адреса из тикета.
 *
 * Поддерживается только шифрование сразу (порт 465): STARTTLS требует отдельного разговора, а
 * молчаливая отправка без шифрования отдала бы пароль приложения открытым текстом.
 */

const DEFAULT_PORT = 465;
const TIMEOUT_MS = 20_000;

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
};

function env(name: string) {
  const value = getPlatformEnv(name)?.trim();
  return value || undefined;
}

export function supportMailSettings(): SupportMailSettings | null {
  const host = env("SUPPORT_SMTP_HOST");
  const user = env("SUPPORT_SMTP_USER");
  const password = env("SUPPORT_SMTP_PASSWORD");
  const to = env("SUPPORT_EMAIL_TO");
  if (!host || !user || !password || !to) return null;
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

/** Заголовок в UTF-8 по RFC 2047: русская тема иначе приходит как «=?UTF-8?» мусор. */
function encodedHeader(value: string) {
  const clean = value.replace(/[\r\n]+/g, " ").trim();
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  return "=?UTF-8?B?" + Buffer.from(clean, "utf8").toString("base64") + "?=";
}

/** Длинная base64-строка без переводов строк превышает лимит SMTP в 998 байт на строку. */
function wrap76(value: string) {
  return value.replace(/(.{76})/g, "$1\r\n").replace(/\r\n$/, "");
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

/** Строка, начинающаяся с точки, в DATA означает «конец письма» — её нужно удвоить. */
function dotStuffed(message: string) {
  return message.split("\r\n").map(line => (line.startsWith(".") ? "." + line : line)).join("\r\n");
}

/** Только те методы, которые использует разговор: тест подменяет сокет целиком. */
export type SupportMailSocket = {
  write(data: string): unknown;
  destroy(): void;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: () => void): unknown;
};

export type SupportMailDeps = {
  /** Подмена TLS-соединения в тестах: живого SMTP в CI нет. */
  connect?: (options: { host: string; port: number; servername: string }) => SupportMailSocket;
};

/**
 * Разговор по SMTP короткий: приветствие, EHLO, AUTH LOGIN, MAIL FROM, RCPT TO, DATA, QUIT.
 * Любой отказ сервера превращается в понятную ошибку, чтобы её было видно в логе, а обращение
 * при этом осталось сохранённым на диске.
 */
export function sendSupportMail(
  settings: SupportMailSettings,
  ticket: SupportMailTicket,
  screenshot?: { buffer: Buffer; mime: string } | null,
  deps: SupportMailDeps = {},
): Promise<void> {
  const message = supportMailMessage(settings, ticket, screenshot);
  return new Promise((resolve, reject) => {
    const socket: SupportMailSocket = deps.connect
      ? deps.connect({ host: settings.host, port: settings.port, servername: settings.host })
      : (tls.connect({ host: settings.host, port: settings.port, servername: settings.host }) as unknown as SupportMailSocket);
    let buffer = "";
    let settled = false;
    let step: "greeting" | "ehlo" | "auth" | "user" | "password" | "from" | "to" | "data" | "message" = "greeting";
    const timer = setTimeout(() => finish(new Error("SMTP не ответил за " + TIMEOUT_MS / 1000 + " секунд")), TIMEOUT_MS);

    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    }

    function send(line: string) {
      socket.write(line + "\r\n");
    }

    function refuse(code: number) {
      finish(new Error("SMTP ответил " + code + " на шаге «" + step + "»"));
    }

    function handle(code: number) {
      switch (step) {
        case "greeting":
          if (code !== 220) return refuse(code);
          step = "ehlo";
          send("EHLO webnestdev");
          return;
        case "ehlo":
          if (code !== 250) return refuse(code);
          step = "auth";
          send("AUTH LOGIN");
          return;
        case "auth":
          if (code !== 334) return refuse(code);
          step = "user";
          send(Buffer.from(settings.user, "utf8").toString("base64"));
          return;
        case "user":
          if (code !== 334) return refuse(code);
          step = "password";
          send(Buffer.from(settings.password, "utf8").toString("base64"));
          return;
        case "password":
          if (code !== 235) return refuse(code);
          step = "from";
          send("MAIL FROM:<" + settings.from + ">");
          return;
        case "from":
          if (code !== 250) return refuse(code);
          step = "to";
          send("RCPT TO:<" + settings.to + ">");
          return;
        case "to":
          if (code !== 250) return refuse(code);
          step = "data";
          send("DATA");
          return;
        case "data":
          if (code !== 354) return refuse(code);
          step = "message";
          send(dotStuffed(message) + "\r\n.");
          return;
        case "message":
          if (code !== 250) return refuse(code);
          send("QUIT");
          finish();
          return;
      }
    }

    socket.on("error", (error: Error) => finish(new Error("SMTP: " + error.message)));
    socket.on("close", () => finish(new Error("SMTP закрыл соединение до конца отправки")));
    socket.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let index = buffer.indexOf("\r\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf("\r\n");
        // Многострочный ответ EHLO: строки с дефисом — продолжение, решение принимает последняя.
        if (line[3] === "-") continue;
        if (!/^\d{3}/.test(line)) {
          finish(new Error("SMTP вернул неожиданный ответ: " + (line.slice(0, 200) || "пустая строка")));
          return;
        }
        handle(Number(line.slice(0, 3)));
        if (settled) return;
      }
    });
  });
}
