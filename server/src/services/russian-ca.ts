import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpsRequest } from "node:https";

/**
 * GigaChat работает на сертификате российского доверенного УЦ (НУЦ Минцифры), которого нет в
 * стандартном наборе Node. Поэтому цепочка российских корневых сертификатов лежит рядом с кодом
 * (`server/certs/`) и передаётся только тем запросам, которым она нужна, — глобально доверие не
 * расширяется.
 *
 * Сертификаты публичные (gu-st.ru). При ротации их нужно заменить — файлы лежат в репозитории.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA_FILES = ["russian_trusted_root_ca.pem", "russian_trusted_sub_ca.pem"];

/** Каталоги, где могут лежать сертификаты: сборка (`dist`) и исходники. */
function caDirectories() {
  return [path.resolve(HERE, "../../certs"), path.resolve(HERE, "../../../certs")];
}

export function russianTrustedCa(): Buffer[] | null {
  for (const directory of caDirectories()) {
    try {
      return CA_FILES.map(file => Buffer.from(readFileSync(path.join(directory, file), "utf8").trim() + "\n", "utf8"));
    } catch {
      // пробуем следующий каталог
    }
  }
  return null;
}

export type HttpsJsonResult = { ok: boolean; status: number; text: string };

/**
 * Запрос через `node:https` вместо `fetch`: только здесь можно передать конкретную цепочку
 * доверия для конкретного хоста.
 */
export async function httpsJson(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string; ca?: Buffer[] | null; timeoutMs?: number } = {},
): Promise<HttpsJsonResult> {
  const target = new URL(url);
  if (target.protocol !== "https:") throw new Error("Ожидался https-адрес: " + url);
  const timeoutMs = options.timeoutMs ?? 15_000;

  return await new Promise<HttpsJsonResult>((resolve, reject) => {
    const request = httpsRequest(
      target,
      {
        method: options.method ?? "GET",
        headers: { ...(options.headers ?? {}) },
        ...(options.ca && options.ca.length ? { ca: options.ca } : {}),
        timeout: timeoutMs,
      },
      response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          resolve({ ok: status >= 200 && status < 300, status, text: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("превышено время ожидания")));
    request.on("error", error => reject(error));
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

/** Понятное сообщение, если цепочка сертификатов всё-таки не собралась. */
export function describeTlsError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/certificate|self.signed|issuer|UNABLE_TO_VERIFY/i.test(message)) {
    return "не удалось проверить сертификат сервиса: на сервере нет российского доверенного корневого сертификата (server/certs). Сообщите об этом администратору платформы.";
  }
  return message;
}
