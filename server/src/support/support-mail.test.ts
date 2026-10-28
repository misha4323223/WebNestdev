import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  sendSupportMail,
  supportMailBody,
  supportMailMessage,
  supportMailSettings,
  supportMailSubject,
  type SupportMailSettings,
  type SupportMailSocket,
  type SupportMailTicket,
} from "./support-mail.js";

/**
 * Поддельный SMTP: приветствие приходит после подключения, на каждую команду — заранее
 * заготовленный ответ. Так проверяется весь разговор (AUTH LOGIN, MAIL FROM, DATA, QUIT) и
 * содержимое письма без сети и без живого ящика.
 */
class FakeSocket extends EventEmitter implements SupportMailSocket {
  written: string[] = [];
  destroyed = false;
  private replies: string[];

  constructor(replies: string[]) {
    super();
    this.replies = [...replies];
    // Приветствие — после того, как отправитель повесил слушатели.
    setImmediate(() => this.emit("data", Buffer.from("220 mail.example ESMTP\r\n")));
  }

  write(data: string) {
    this.written.push(data);
    const reply = this.replies.shift();
    if (reply) setImmediate(() => this.emit("data", Buffer.from(reply)));
    return true;
  }

  destroy() {
    this.destroyed = true;
  }
}

const okReplies = [
  "250-mail.example\r\n250-AUTH LOGIN PLAIN\r\n250 SIZE 35882577\r\n",
  "334 VXNlcm5hbWU6\r\n",
  "334 UGFzc3dvcmQ6\r\n",
  "235 2.7.0 Authentication successful\r\n",
  "250 2.1.0 Ok\r\n",
  "250 2.1.5 Ok\r\n",
  "354 End data with <CR><LF>.<CR><LF>\r\n",
  "250 2.0.0 Ok: queued as 4A2B\r\n",
  "221 2.0.0 Bye\r\n",
];

const settings: SupportMailSettings = {
  host: "smtp.example.ru",
  port: 465,
  user: "support@example.ru",
  password: "app-password",
  from: "support@example.ru",
  to: "owner@example.ru",
};

const ticket: SupportMailTicket = {
  id: "3f1c2d4e-1111-2222-3333-444455556666",
  category: "bug",
  severity: 7,
  email: "client@example.com",
  description: "Кнопка «Сохранить» ничего не делает.",
  steps: "Открыл проект, нажал «Сохранить».",
  context: "Chrome, macOS",
  page: "https://panel.example.ru/project",
  projectId: "proj-1",
  createdAt: "2026-10-22T10:00:00.000Z",
};

const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

test("the SMTP conversation authenticates, sends the letter and quits", async () => {
  const socket = new FakeSocket(okReplies);
  await sendSupportMail(settings, ticket, { buffer: png, mime: "image/png" }, { connect: () => socket });

  assert.equal(socket.written[0], "EHLO webnestdev\r\n");
  assert.equal(socket.written[1], "AUTH LOGIN\r\n");
  assert.equal(Buffer.from(socket.written[2].trim(), "base64").toString(), "support@example.ru");
  assert.equal(Buffer.from(socket.written[3].trim(), "base64").toString(), "app-password");
  assert.equal(socket.written[4], "MAIL FROM:<support@example.ru>\r\n");
  assert.equal(socket.written[5], "RCPT TO:<owner@example.ru>\r\n");
  assert.equal(socket.written[6], "DATA\r\n");
  assert.equal(socket.written.at(-1), "QUIT\r\n");
  assert.equal(socket.destroyed, true);
});

test("the letter carries the ticket, the author's address and the screenshot", async () => {
  const socket = new FakeSocket(okReplies);
  await sendSupportMail(settings, ticket, { buffer: png, mime: "image/png" }, { connect: () => socket });

  const message = socket.written[7];
  assert.match(message, /To: owner@example\.ru/);
  assert.match(message, /From: support@example\.ru/);
  // Ответ на письмо уходит автору обращения, а не в пустоту.
  assert.match(message, /Reply-To: client@example\.com/);
  assert.match(message, /X-Support-Ticket: 3f1c2d4e-1111-2222-3333-444455556666/);
  assert.match(message, /Content-Type: image\/png/);
  assert.ok(message.includes(png.toString("base64").slice(0, 24)), "скриншот приложен в base64");
  assert.ok(message.trimEnd().endsWith("."), "письмо закрыто точкой: иначе сервер ждёт продолжения");
});

test("the letter names the account behind the ticket", () => {
  const body = supportMailBody({
    ...ticket,
    ip: "203.0.113.10",
    reporter: {
      id: "u1",
      email: "client@example.com",
      name: "Иван Петров",
      contactEmail: "ivan@example.com",
      phone: "+7 999 123-45-67",
      signIn: ["phone"],
      plan: "pro",
      planName: "Плюс",
      accountCreatedAt: "2026-01-02T03:04:05.000Z",
      projects: 3,
      lastActiveAt: "2026-10-25T18:00:00.000Z",
    },
  });
  assert.match(body, /Имя: Иван Петров/);
  assert.match(body, /Почта для ответа: ivan@example\.com/);
  assert.match(body, /Телефон: \+7 999 123-45-67/);
  assert.match(body, /Тариф: Плюс/);
  assert.match(body, /Проектов: 3/);
  assert.match(body, /IP: 203\.0\.113\.10/);
});

test("почта из формы обращения важнее логина и профиля", () => {
  const formTicket: SupportMailTicket = { ...ticket, contactEmail: "answer@example.com" };
  const message = supportMailMessage(settings, formTicket);
  assert.match(message, /Reply-To: answer@example\.com/, "ответ уходит на адрес из формы");

  const body = supportMailBody({
    ...formTicket,
    reporter: {
      id: "u1",
      email: "client@example.com",
      name: "Иван Петров",
      contactEmail: "profile@example.com",
      phone: null,
      signIn: ["password"],
      plan: "free",
      planName: "Старт",
      accountCreatedAt: "2026-01-02T03:04:05.000Z",
      projects: 0,
      lastActiveAt: null,
    },
  });
  assert.match(body, /Почта для ответа: answer@example\.com/);
  assert.doesNotMatch(body, /profile@example\.com/, "две разные почты не путаются");
});

test("the subject is encoded for UTF-8 and names the category and severity", () => {
  const subject = supportMailSubject(ticket);
  assert.match(subject, /Баг/);
  assert.match(subject, /7\/10/);
  const message = supportMailMessage(settings, ticket);
  assert.match(message, /Subject: =\?UTF-8\?B\?/);
  const encoded = /Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(message)?.[1] ?? "";
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), subject);
});

test("mail is not configured until all SMTP values are present", () => {
  // Ключи почты платформы тоже убираются: с ними письмо поддержки настроено и без SUPPORT_SMTP_*.
  const names = ["SUPPORT_SMTP_HOST", "SUPPORT_SMTP_USER", "SUPPORT_SMTP_PASSWORD", "SUPPORT_EMAIL_TO", "SUPPORT_EMAIL_FROM", "SUPPORT_SMTP_PORT", "MAIL_SMTP_HOST", "MAIL_SMTP_USER", "MAIL_SMTP_PASSWORD", "MAIL_FROM", "MAIL_SMTP_PORT", "MAIL_FROM_NAME"];
  const saved = names.map(name => [name, process.env[name]] as const);
  for (const name of names) delete process.env[name];
  try {
    assert.equal(supportMailSettings(), null);
    process.env.SUPPORT_SMTP_HOST = "smtp.example.ru";
    process.env.SUPPORT_SMTP_USER = "support@example.ru";
    process.env.SUPPORT_SMTP_PASSWORD = "secret";
    assert.equal(supportMailSettings(), null, "без адреса получателя письмо отправлять некуда");
    process.env.SUPPORT_EMAIL_TO = "owner@example.ru";
    const configured = supportMailSettings();
    assert.equal(configured?.port, 465, "порт по умолчанию — шифрование сразу");
    assert.equal(configured?.from, "support@example.ru", "отправитель по умолчанию — логин SMTP");
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("почта платформы (Postbox) важнее личного SMTP, а получатель остаётся ящиком поддержки", () => {
  const names = ["MAIL_SMTP_HOST", "MAIL_SMTP_USER", "MAIL_SMTP_PASSWORD", "MAIL_FROM", "MAIL_SMTP_PORT", "MAIL_FROM_NAME", "SUPPORT_SMTP_HOST", "SUPPORT_SMTP_USER", "SUPPORT_SMTP_PASSWORD", "SUPPORT_EMAIL_TO", "SUPPORT_EMAIL_FROM", "SUPPORT_SMTP_PORT"];
  const saved = names.map(name => [name, process.env[name]] as const);
  for (const name of names) delete process.env[name];
  try {
    process.env.SUPPORT_EMAIL_TO = "owner@example.ru";
    process.env.SUPPORT_SMTP_HOST = "smtp.yandex.ru";
    process.env.SUPPORT_SMTP_USER = "support@example.ru";
    process.env.SUPPORT_SMTP_PASSWORD = "app-password";
    process.env.MAIL_SMTP_HOST = "postbox.cloud.yandex.net";
    process.env.MAIL_SMTP_USER = "key-id";
    process.env.MAIL_SMTP_PASSWORD = "key-secret";
    process.env.MAIL_FROM = "noreply@nestdev.ru";

    const settings = supportMailSettings();
    assert.equal(settings?.host, "postbox.cloud.yandex.net", "Postbox важнее личного ящика");
    assert.equal(settings?.from, "noreply@nestdev.ru", "письма уходят от домена сервиса");
    assert.equal(settings?.to, "owner@example.ru", "получатель — ящик поддержки");
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
