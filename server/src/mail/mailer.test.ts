import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { buildMailMessage, mailConfigured, mailSettings, sendMail } from "./mailer.js";
import type { MailSocket } from "./smtp.js";

/** Поддельный SMTP: тот же разговор, что с Postbox, но без сети. */
class FakeSocket extends EventEmitter implements MailSocket {
  written: string[] = [];
  destroyed = false;
  private replies: string[];

  constructor(replies: string[]) {
    super();
    this.replies = [...replies];
    setImmediate(() => this.emit("data", Buffer.from("220 postbox.cloud.yandex.net ESMTP\r\n")));
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
  "250-postbox.cloud.yandex.net\r\n250-AUTH LOGIN PLAIN\r\n250 SIZE 35882577\r\n",
  "334 VXNlcm5hbWU6\r\n",
  "334 UGFzc3dvcmQ6\r\n",
  "235 2.7.0 Authentication successful\r\n",
  "250 2.1.0 Ok\r\n",
  "250 2.1.5 Ok\r\n",
  "354 End data with <CR><LF>.<CR><LF>\r\n",
  "250 2.0.0 Ok: queued as 4A2B\r\n",
  "221 2.0.0 Bye\r\n",
];

const MANAGED = ["MAIL_SMTP_HOST", "MAIL_SMTP_PORT", "MAIL_SMTP_USER", "MAIL_SMTP_PASSWORD", "MAIL_FROM", "MAIL_FROM_NAME"] as const;

/**
 * Настройки читаются из окружения, когда панель ничего не сохраняла: тест выставляет их сам.
 * Обёртка дожидается асинхронного теста: если вернуть управление раньше, окружение успело бы
 * восстановиться посреди проверки.
 */
async function withEnv<T>(values: Partial<Record<(typeof MANAGED)[number], string>>, run: () => T | Promise<T>): Promise<T> {
  const previous = new Map(MANAGED.map(name => [name, process.env[name]]));
  try {
    for (const name of MANAGED) delete process.env[name];
    for (const [name, value] of Object.entries(values)) process.env[name] = value;
    return await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const POSTBOX = {
  MAIL_SMTP_HOST: "postbox.cloud.yandex.net",
  MAIL_SMTP_USER: "aje1k2l3m4n5",
  MAIL_SMTP_PASSWORD: "secret-part",
  MAIL_FROM: "noreply@nestdev.ru",
};

test("почта не настроена, пока не заполнены все ключи", async () => {
  await withEnv({ MAIL_SMTP_HOST: "postbox.cloud.yandex.net", MAIL_SMTP_USER: "key" }, () => {
    assert.equal(mailSettings(), null, "без адреса отправителя отправлять нечего");
    assert.equal(mailConfigured(), false);
  });
});

test("ключи Postbox дают настройки, а порт по умолчанию — 465", async () => {
  await withEnv({ ...POSTBOX, MAIL_FROM_NAME: "NestDev" }, () => {
    const settings = mailSettings();
    assert.equal(settings?.host, "postbox.cloud.yandex.net");
    assert.equal(settings?.port, 465, "шифрование сразу — единственный поддерживаемый режим");
    assert.equal(settings?.user, "aje1k2l3m4n5", "логин — идентификатор API-ключа, а не адрес ящика");
    assert.equal(settings?.from, "noreply@nestdev.ru");
    assert.equal(settings?.fromName, "NestDev");
    assert.equal(mailConfigured(), true);
  });
  // Порт читается из ключа, а мусорное значение не ломает отправку.
  await withEnv({ ...POSTBOX, MAIL_SMTP_PORT: "2525" }, () => assert.equal(mailSettings()?.port, 2525));
  await withEnv({ ...POSTBOX, MAIL_SMTP_PORT: "не порт" }, () => assert.equal(mailSettings()?.port, 465));
});

test("письмо содержит закодированную тему, Reply-To и текст в base64", async () => {
  await withEnv(POSTBOX, () => {
    const settings = mailSettings()!;
    const message = buildMailMessage(settings, {
      to: "client@example.com",
      subject: "Оплата принята — тариф «Плюс»",
      text: "Сумма: 990 ₽",
      replyTo: "support@nestdev.ru",
    });
    assert.match(message, /From: noreply@nestdev\.ru/);
    assert.match(message, /To: client@example\.com/);
    assert.match(message, /Reply-To: support@nestdev\.ru/);
    assert.match(message, /Subject: =\?UTF-8\?B\?/);
    const encoded = /Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(message)?.[1] ?? "";
    assert.equal(Buffer.from(encoded, "base64").toString("utf8"), "Оплата принята — тариф «Плюс»");
    const body = message.split("\r\n\r\n")[1].replace(/\r\n/g, "");
    assert.equal(Buffer.from(body, "base64").toString("utf8"), "Сумма: 990 ₽");
  });
});

test("письмо уходит тем же SMTP-разговором, что и остальная почта платформы", async () => {
  await withEnv(POSTBOX, async () => {
    const socket = new FakeSocket(okReplies);
    await sendMail({ to: "client@example.com", subject: "Оплата принята", text: "Спасибо" }, { connect: () => socket });

    assert.equal(socket.written[0], "EHLO webnestdev\r\n");
    assert.equal(Buffer.from(socket.written[2].trim(), "base64").toString(), "aje1k2l3m4n5");
    assert.equal(socket.written[4], "MAIL FROM:<noreply@nestdev.ru>\r\n");
    assert.equal(socket.written[5], "RCPT TO:<client@example.com>\r\n");
    assert.match(socket.written[7], /Subject: =\?UTF-8\?B\?/);
    assert.equal(socket.written.at(-1), "QUIT\r\n");
    assert.equal(socket.destroyed, true);
  });
});

test("без настроек отправка честно отказывает, а не молчит", async () => {
  await withEnv({}, async () => {
    await assert.rejects(
      () => sendMail({ to: "client@example.com", subject: "Тема", text: "Текст" }),
      /не настроена/,
    );
  });
});
