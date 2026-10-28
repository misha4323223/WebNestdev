import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { smtpSend, smtpRefusalHint, type MailSocket } from "./smtp.js";

/**
 * Отказ SMTP проверяется на поддельном соединении: важно не «функция вернула ошибку», а что в
 * тексте есть шаг, дословный ответ сервиса и подсказка, что именно настраивать. Именно этого не
 * хватало в разборе «письмо не ушло: SMTP ответил 550 на шаге «from»» — ни адреса, ни причины.
 */
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

const CREDS = { host: "postbox.cloud.yandex.net", port: 465, user: "aje-key", password: "aje-secret" };
const AUTH_OK = [
  "250-postbox.cloud.yandex.net\r\n250-AUTH LOGIN PLAIN\r\n250 SIZE 35882577\r\n",
  "334 VXNlcm5hbWU6\r\n",
  "334 UGFzc3dvcmQ6\r\n",
  "235 2.7.0 Authentication successful\r\n",
];

function sendWith(replies: string[]) {
  const socket = new FakeSocket(replies);
  return {
    socket,
    result: smtpSend(CREDS, { from: "noreply@nestdev.ru", to: "client@example.ru" }, "Subject: Тест\r\n\r\nПривет", {
      connect: () => socket,
      timeoutMs: 2_000,
    }),
  };
}

test("550 на MAIL FROM: видно шаг, ответ сервиса и что проверить", async () => {
  const { result } = sendWith([
    ...AUTH_OK,
    "550 5.7.1 Sender address is not verified: noreply@nestdev.ru\r\n",
  ]);
  await assert.rejects(result, (error: Error) => {
    assert.match(error.message, /550/);
    assert.match(error.message, /MAIL FROM/);
    assert.match(error.message, /Sender address is not verified/, "ответ сервиса сохраняется дословно");
    assert.match(error.message, /POSTBOX_SENDER/, "подсказка называет переменную");
    return true;
  });
});

test("550 с суточной квотой не отправляет человека проверять домен", async () => {
  const { result } = sendWith([
    ...AUTH_OK,
    "550 5.7.0 Daily sending quota exceeded\r\n",
  ]);
  await assert.rejects(result, (error: Error) => {
    assert.match(error.message, /квота/);
    assert.doesNotMatch(error.message, /домен должен быть подтверждён/);
    return true;
  });
});

test("535 на пароле подсказывает про ключ сервисного аккаунта", async () => {
  const { result } = sendWith([
    "250-postbox.cloud.yandex.net\r\n250-AUTH LOGIN PLAIN\r\n250 SIZE 35882577\r\n",
    "334 VXNlcm5hbWU6\r\n",
    "334 UGFzc3dvcmQ6\r\n",
    "535 5.7.8 Error: authentication failed\r\n",
  ]);
  await assert.rejects(result, (error: Error) => {
    assert.match(error.message, /535/);
    assert.match(error.message, /«пароль»/);
    assert.match(error.message, /API-ключа/);
    return true;
  });
});

test("550 на RCPT TO говорит о получателе, а не об отправителе", async () => {
  const { result } = sendWith([
    ...AUTH_OK,
    "250 2.1.0 Ok\r\n",
    "550 5.1.1 No such user\r\n",
  ]);
  await assert.rejects(result, (error: Error) => {
    assert.match(error.message, /RCPT TO/);
    assert.match(error.message, /Получатель отклонён/);
    return true;
  });
});

test("подсказка не выдумывается там, где причину знает только сервис", () => {
  assert.equal(smtpRefusalHint(451, "message", "451 4.3.0 Temporary failure"), "");
});
