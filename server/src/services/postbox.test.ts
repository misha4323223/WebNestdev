import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { connect as tlsConnect } from "node:tls";
import { checkPostboxSmtp } from "./postbox.js";

/** Поддельный сокет: отвечает на SMTP-команды так же, как Postbox, не выходя в сеть. */
function fakePostbox(options: { rejectCode?: number } = {}) {
  const socket = new EventEmitter() as EventEmitter & {
    written: string[];
    setEncoding: () => void;
    write: (line: string) => void;
    destroy: () => void;
  };
  socket.written = [];
  socket.setEncoding = () => {};
  socket.destroy = () => {};
  let stage: "username" | "password" = "username";
  socket.write = raw => {
    const line = raw.trim();
    socket.written.push(line);
    // Ответ приходит следующим тиком, как из настоящего сокета: синхронный emit внутри write
    // ломал бы порядок разбора многострочных ответов.
    if (line === "QUIT") return;
    let reply: string;
    if (line === "EHLO webnestdev") reply = "250-postbox.cloud.yandex.net\r\n250 AUTH LOGIN\r\n";
    else if (line === "AUTH LOGIN") reply = "334 VXNlcm5hbWU6\r\n";
    else if (stage === "username") {
      stage = "password";
      reply = "334 UGFzc3dvcmQ6\r\n";
    } else if (options.rejectCode) reply = options.rejectCode + " 5.7.8 Authentication credentials invalid\r\n";
    else reply = "235 2.7.0 Authentication successful\r\n";
    process.nextTick(() => socket.emit("data", reply));
  };
  process.nextTick(() => socket.emit("data", "220 postbox.cloud.yandex.net ESMTP\r\n"));
  return socket;
}

function factory(socket: EventEmitter): typeof tlsConnect {
  return (() => socket) as unknown as typeof tlsConnect;
}

test("Postbox проверяет ключ входом по SMTP и не отправляет письмо", async () => {
  const socket = fakePostbox();
  await checkPostboxSmtp("key-id", "secret", { connect: factory(socket) });
  assert.deepEqual(socket.written, [
    "EHLO webnestdev",
    "AUTH LOGIN",
    Buffer.from("key-id", "utf8").toString("base64"),
    Buffer.from("secret", "utf8").toString("base64"),
    "QUIT",
  ]);
  assert.equal(socket.written.includes("DATA"), false);
});

test("Postbox объясняет отказ, а не прячет его за общим сообщением", async () => {
  // 538 — так Postbox отвечает на неверный ключ, 535 — общий код SMTP для отказа в доступе.
  for (const rejectCode of [535, 538]) {
    await assert.rejects(
      () => checkPostboxSmtp("key-id", "wrong", { connect: factory(fakePostbox({ rejectCode })) }),
      /отклонил ключ.*yc\.postbox\.send/,
    );
  }
});
