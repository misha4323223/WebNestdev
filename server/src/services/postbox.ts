import tls, { type TLSSocket } from "node:tls";

/**
 * Проверка ключа Yandex Cloud Postbox без отправки письма.
 *
 * Postbox не даёт безопасного HTTP-запроса для API-ключа: AWS-совместимый API принимает
 * только статический ключ или IAM-токен, а ключ с областью `yc.postbox.send` работает в SMTP.
 * Поэтому проверяем ровно то, что будет использовать приложение: вход по SMTP. Разговор
 * доходит до ответа 235 и закрывается до отправки письма, так что квота не расходуется.
 */

const HOST = "postbox.cloud.yandex.net";
const PORT = 465;
const TIMEOUT_MS = 15_000;
const MAX_DETAIL = 300;

type PostboxDeps = { connect?: typeof tls.connect };

function detail(line: string) {
  return line.replace(/^\d{3}[ -]?/, "").replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL);
}

export function checkPostboxSmtp(username: string, password: string, deps: PostboxDeps = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket: TLSSocket = (deps.connect ?? tls.connect)({ host: HOST, port: PORT, servername: HOST });
    let buffer = "";
    let step: "greeting" | "ehlo" | "auth" | "username" | "password" = "greeting";
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error("Yandex Cloud Postbox не ответил по SMTP: превышено время ожидания")),
      TIMEOUT_MS,
    );

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

    function rejectReply(code: number, line: string) {
      // Postbox отвечает 538 на неверные ключи (проверено на живом SMTP), 535 — по RFC.
      if (code === 535 || code === 538) {
        finish(new Error(
          "Yandex Cloud Postbox отклонил ключ: проверьте идентификатор API-ключа, его секрет и область действия yc.postbox.send",
        ));
        return;
      }
      finish(new Error("Yandex Cloud Postbox ответил по SMTP " + code + ": " + (detail(line) || "пустой ответ")));
    }

    function handle(line: string) {
      // Многострочный ответ EHLO: строки с дефисом — продолжение, решение принимает последняя.
      if (line[3] === "-") return;
      if (!/^\d{3}/.test(line)) {
        finish(new Error("Yandex Cloud Postbox вернул неожиданный ответ по SMTP: " + (detail(line) || "пустая строка")));
        return;
      }
      const code = Number(line.slice(0, 3));
      if (code >= 400) return rejectReply(code, line);

      switch (step) {
        case "greeting":
          if (code !== 220) return rejectReply(code, line);
          step = "ehlo";
          send("EHLO webnestdev");
          return;
        case "ehlo":
          if (code !== 250) return rejectReply(code, line);
          step = "auth";
          send("AUTH LOGIN");
          return;
        case "auth":
          if (code !== 334) return rejectReply(code, line);
          step = "username";
          send(Buffer.from(username, "utf8").toString("base64"));
          return;
        case "username":
          if (code !== 334) return rejectReply(code, line);
          step = "password";
          send(Buffer.from(password, "utf8").toString("base64"));
          return;
        case "password":
          if (code !== 235) return rejectReply(code, line);
          send("QUIT");
          finish();
          return;
      }
    }

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (settled) return;
      buffer += chunk;
      let index = buffer.indexOf("\r\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        handle(line);
        if (settled) return;
        index = buffer.indexOf("\r\n");
      }
    });
    socket.once("error", (error: Error) => {
      finish(new Error("Нет ответа от Yandex Cloud Postbox: " + error.message));
    });
    socket.once("close", () => {
      if (!settled) finish(new Error("Yandex Cloud Postbox закрыл SMTP-соединение до подтверждения ключа"));
    });
  });
}
