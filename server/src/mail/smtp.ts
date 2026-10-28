import tls from "node:tls";
import { dotStuffed } from "./mime.js";

/**
 * Один SMTP-разговор для всей платформы: письма поддержки, оплаты и предупреждения о списании
 * уходят одним и тем же кодом, поэтому поведение, таймауты и тексты ошибок совпадают.
 *
 * Поддерживается только шифрование сразу (порт 465): STARTTLS требует отдельного разговора, а
 * молчаливая отправка без шифрования отдала бы пароль сервисного аккаунта открытым текстом.
 * Yandex Cloud Postbox принимает такое подключение на postbox.cloud.yandex.net:465.
 */

const DEFAULT_TIMEOUT_MS = 20_000;

type Step = "greeting" | "ehlo" | "auth" | "user" | "password" | "from" | "to" | "data" | "message";

/**
 * Имена шагов для текста ошибки. «SMTP ответил 550 на шаге «from»» не говорит ни админу, ни
 * человеку ничего: MAIL FROM — это конверт, адрес отправителя, и именно его чаще всего отвергают.
 */
const STEP_LABEL: Record<Step, string> = {
  greeting: "приветствие",
  ehlo: "EHLO",
  auth: "AUTH LOGIN",
  user: "логин",
  password: "пароль",
  from: "MAIL FROM (адрес отправителя)",
  to: "RCPT TO (адрес получателя)",
  data: "DATA",
  message: "передача текста письма",
};

/**
 * Что делать с отказом. Код без подсказки заставляет искать расшифровку SMTP в интернете, а
 * причина почти всегда одна из четырёх: адрес отправителя, ключ, получатель или квота.
 */
export function smtpRefusalHint(code: number, step: Step, response = ""): string {
  const text = response.toLowerCase();
  if (step === "from" && (code === 550 || code === 553 || code === 554)) {
    // Postbox отдаёт 550 и на неподтверждённый адрес, и на выбранную суточную квоту; текст ответа
    // различает их, поэтому он всегда идёт рядом с подсказкой.
    if (text.includes("quota")) return "Выбрана суточная квота отправки: письма пойдут после того, как окно освободится.";
    return "Postbox не принимает адрес отправителя: домен должен быть подтверждён в Postbox, а сам адрес — создан в том же каталоге, что и сервисный аккаунт. Проверьте POSTBOX_SENDER (или MAIL_FROM): в /api/health он виден как mail.sender.";
  }
  if (code === 535 || code === 534) {
    return "Ключ не подошёл: нужен идентификатор и секрет API-ключа сервисного аккаунта с областью yc.postbox.send и ролью postbox.sender.";
  }
  if (step === "to" && (code === 550 || code === 553 || code === 551 || code === 450)) {
    return "Получатель отклонён сервисом: адрес не существует или отказывается принимать почту.";
  }
  if (code === 454 || code === 421) {
    return "Сервис просит снизить скорость отправки: повтор уйдёт позже, настройка — POSTBOX_RATE_PER_SECOND.";
  }
  return "";
}

export type SmtpCredentials = {
  host: string;
  port: number;
  user: string;
  password: string;
};

/** Только те методы, которые использует разговор: тест подменяет сокет целиком. */
export type MailSocket = {
  write(data: string): unknown;
  destroy(): void;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: () => void): unknown;
};

export type MailDeps = {
  /** Подмена TLS-соединения в тестах: живого SMTP в CI нет. */
  connect?: (options: { host: string; port: number; servername: string }) => MailSocket;
  timeoutMs?: number;
};

/**
 * Разговор по SMTP короткий: приветствие, EHLO, AUTH LOGIN, MAIL FROM, RCPT TO, DATA, QUIT.
 * Любой отказ сервера превращается в понятную ошибку, чтобы её было видно в логе.
 */
export function smtpSend(
  credentials: SmtpCredentials,
  envelope: { from: string; to: string },
  message: string,
  deps: MailDeps = {},
): Promise<void> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const socket: MailSocket = deps.connect
      ? deps.connect({ host: credentials.host, port: credentials.port, servername: credentials.host })
      : (tls.connect({ host: credentials.host, port: credentials.port, servername: credentials.host }) as unknown as MailSocket);
    let buffer = "";
    let settled = false;
    let step: Step = "greeting";
    /** Последняя строка ответа сервиса: без неё «550» неотличимо от «550 с причиной». */
    let lastReply = "";
    const timer = setTimeout(() => finish(new Error("SMTP не ответил за " + timeoutMs / 1000 + " секунд")), timeoutMs);

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
      const advice = smtpRefusalHint(code, step, lastReply);
      finish(
        new Error(
          "SMTP ответил " + code + " на шаге «" + STEP_LABEL[step] + "»" +
          (lastReply ? ": " + lastReply : "") +
          (advice ? ". " + advice : ""),
        ),
      );
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
          send(Buffer.from(credentials.user, "utf8").toString("base64"));
          return;
        case "user":
          if (code !== 334) return refuse(code);
          step = "password";
          send(Buffer.from(credentials.password, "utf8").toString("base64"));
          return;
        case "password":
          if (code !== 235) return refuse(code);
          step = "from";
          send("MAIL FROM:<" + envelope.from + ">");
          return;
        case "from":
          if (code !== 250) return refuse(code);
          step = "to";
          send("RCPT TO:<" + envelope.to + ">");
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
        lastReply = line.slice(0, 300);
        handle(Number(line.slice(0, 3)));
        if (settled) return;
      }
    });
  });
}
