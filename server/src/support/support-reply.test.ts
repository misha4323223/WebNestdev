import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { MailSocket } from "../mail/smtp.js";

/**
 * Письмо-ответ проверяется на уровне транспорта: вместо Postbox подставляется тот же SMTP-разговор,
 * что и в mail/mailer.test.ts, поэтому проверяется само письмо — отправитель, Reply-To, тема и
 * текст, — а не факт вызова функции.
 *
 * Здесь же закрепляется причина, по которой ответ раньше падал с `403`: пара POSTBOX_KEY_ID /
 * POSTBOX_SECRET — это SMTP-ключ, и она должна уходить в AUTH LOGIN, а не в подпись REST-запроса.
 */
const { sendSupportReply } = await import("./support-reply.js");
const { lastMailFailure, resetMailHealth } = await import("../mail/mail-health.js");

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

const ENV = ["POSTBOX_KEY_ID", "POSTBOX_SECRET", "POSTBOX_SENDER", "POSTBOX_FROM_NAME", "SUPPORT_REPLY_TO", "MAIL_SMTP_HOST", "MAIL_SMTP_USER", "MAIL_SMTP_PASSWORD", "MAIL_FROM"] as const;

/** Окружение ставится на один тест и восстанавливается: ключи читаются на каждое письмо. */
async function withEnv<T>(values: Partial<Record<(typeof ENV)[number], string>>, run: () => Promise<T>): Promise<T> {
  const previous = new Map(ENV.map(name => [name, process.env[name]]));
  try {
    for (const name of ENV) delete process.env[name];
    for (const [name, value] of Object.entries(values)) process.env[name] = value;
    return await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const SMTP_KEY = {
  POSTBOX_KEY_ID: "aje1k2l3m4n5",
  POSTBOX_SECRET: "aje-secret-part",
  POSTBOX_SENDER: "noreply@nestdev.ru",
  POSTBOX_FROM_NAME: "NestDev",
};

function decodeBase64(value: string) {
  return Buffer.from(value.replace(/\s+/g, ""), "base64").toString("utf8");
}

test("ответ уходит по SMTP ключом Postbox, с Reply-To и без строки отписки", async () => {
  await withEnv(SMTP_KEY, async () => {
    resetMailHealth();
    const socket = new FakeSocket(okReplies);
    const sent = await sendSupportReply(
      {
        to: "ivan.petrov@yandex.ru",
        subject: "Обращение 7f1c: идея",
        text: "Здравствуйте! Проверка ответа из админки.\n\nДокументация: https://nestdev.ru/docs",
      },
      { connect: () => socket },
    );

    assert.equal(socket.written[0], "EHLO webnestdev\r\n");
    // AUTH LOGIN: идентификатор API-ключа — логин, секрет — пароль. Именно этим ключом
    // Postbox не даёт подписывать REST-запросы, поэтому ответ обязан идти по SMTP.
    assert.equal(decodeBase64(socket.written[2].trim()), "aje1k2l3m4n5");
    assert.equal(decodeBase64(socket.written[3].trim()), "aje-secret-part");
    assert.equal(socket.written[4], "MAIL FROM:<noreply@nestdev.ru>\r\n");
    assert.equal(socket.written[5], "RCPT TO:<ivan.petrov@yandex.ru>\r\n");

    const headers = socket.written[7];
    // Имя отправителя (NestDev) — ASCII, поэтому остаётся как есть; кодируется только кириллица темы.
    assert.match(headers, /From: "NestDev" <noreply@nestdev\.ru>/);
    assert.match(headers, /To: ivan\.petrov@yandex\.ru/);
    assert.match(headers, /Reply-To: support@nestdev\.ru/, "ответ человека должен попасть в поддержку");
    assert.match(headers, /Message-ID: <[0-9a-f-]{36}@webnestdev>/);
    assert.match(headers, /Subject: =\?UTF-8\?B\?/);

    // Терминатор DATA (".") в тело не входит — иначе base64-строка содержит лишний символ.
    const body = decodeBase64((headers.split("\r\n\r\n")[1] ?? "").replace(/\r\n\.[\s\S]*$/, ""));
    assert.match(body, /Проверка ответа из админки/);
    assert.match(body, /https:\/\/nestdev\.ru\/docs/);
    assert.doesNotMatch(body, /[Оо]тписаться/, "ответ на обращение — не рассылка");

    assert.equal(sent.messageId, /Message-ID: (<[^>]+>)/.exec(headers)?.[1]);
    assert.equal(lastMailFailure(), null);
    assert.equal(socket.destroyed, true);
  });
});

test("адрес для ответа настраивается и переопределяет адрес поддержки по умолчанию", async () => {
  await withEnv({ ...SMTP_KEY, SUPPORT_REPLY_TO: "help@nestdev.ru" }, async () => {
    const socket = new FakeSocket(okReplies);
    await sendSupportReply({ to: "client@example.ru", subject: "Тема", text: "Текст ответа для клиента" }, { connect: () => socket });
    assert.match(socket.written[7], /Reply-To: help@nestdev\.ru/);
  });
});

test("без настроек отказ называет переменные, а не «ошибка отправки»", async () => {
  await withEnv({}, async () => {
    resetMailHealth();
    await assert.rejects(
      () => sendSupportReply({ to: "client@example.ru", subject: "Тема", text: "Текст ответа для клиента" }),
      /MAIL_SMTP_HOST.*POSTBOX_KEY_ID.*POSTBOX_SENDER/s,
    );
    // Отказ виден в /api/health: иначе снаружи «не настроено» неотличимо от «сервис отказал».
    assert.equal(lastMailFailure()?.kind, "smtp");
  });
});

test("отказ Postbox на пароле попадает в health с кодом ответа", async () => {
  await withEnv(SMTP_KEY, async () => {
    resetMailHealth();
    const socket = new FakeSocket([
      // Многострочный ответ EHLO заканчивается строкой без дефиса: без неё разговор ждёт ответа.
      "250-postbox.cloud.yandex.net\r\n250-AUTH LOGIN PLAIN\r\n250 SIZE 35882577\r\n",
      "334 VXNlcm5hbWU6\r\n",
      "334 UGFzc3dvcmQ6\r\n",
      "535 5.7.8 Error: authentication failed\r\n",
    ]);
    await assert.rejects(
      () => sendSupportReply({ to: "client@example.ru", subject: "Тема", text: "Текст ответа для клиента" }, { connect: () => socket }),
      /SMTP ответил 535/,
    );
    assert.match(lastMailFailure()?.message ?? "", /535/);
  });
});
