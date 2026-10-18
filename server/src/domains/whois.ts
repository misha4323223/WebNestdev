import net from "node:net";

/**
 * WHOIS для зон .ru/.su/.рф: у них нет RDAP, а занятость имени нужна агенту постоянно.
 * Служба TCI отдаёт обычный текст: "domain: ..." у зарегистрированного имени и
 * "No entries found for the selected source(s)." у свободного.
 *
 * Разбор намеренно строгий: всё, что не похоже ни на один из двух ответов (лимит запросов,
 * смена формата, таймаут), считается "unknown", а не "свободен" — иначе агент предложит
 * пользователю купить занятый домен.
 */

export const TCI_WHOIS_HOST = "whois.tcinet.ru";
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_ANSWER_CHARS = 20_000;

export function whoisQuery(host: string, query: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(43, host);
    let answer = "";
    let settled = false;
    const finish = (error: Error | null, text?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(text ?? answer);
    };

    socket.setTimeout(timeoutMs);
    socket.on("connect", () => socket.write(query + "\r\n"));
    socket.on("data", chunk => {
      answer += chunk.toString("utf8");
      if (answer.length > MAX_ANSWER_CHARS) finish(new Error("Слишком длинный ответ WHOIS"));
    });
    socket.on("timeout", () => finish(new Error("WHOIS не ответил за " + Math.round(timeoutMs / 1000) + " с")));
    socket.on("error", error => finish(error));
    socket.on("end", () => finish(null, answer));
  });
}

export function classifyWhois(answer: string): "available" | "taken" | "unknown" {
  if (/^domain:\s+\S+/im.test(answer)) return "taken";
  if (/No entries found/i.test(answer)) return "available";
  return "unknown";
}
