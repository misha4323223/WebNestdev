import type { SecretFiles } from "../secrets/secret-store.js";

/**
 * Политика внешних запросов агента.
 *
 * Запрос идёт через сервер, а не через песочницу: у контейнера проекта нет исходящей сети, и это
 * остаётся правилом. Здесь же — единственное место, где решается, что можно отправить наружу:
 * заголовки с учётными данными запрещены, ключ берётся только из сохранённых секретов проекта и
 * только после явного подтверждения человека в панели, а значение ключа вырезается из ответа.
 */

/**
 * Заголовки, которые отправляет только платформа. `authorization` и `cookie` не принимаются от
 * модели вовсе: иначе ключ можно было бы передать в вызове инструмента, обойдя окно подтверждения.
 */
const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "expect",
]);

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]{0,1024}$/;

/** Заголовки запроса: только обычные имена и значения без переводов строк. */
export function sanitizeHeaders(input: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(input ?? {})) {
    const name = rawName.toLowerCase().trim();
    if (FORBIDDEN_HEADERS.has(name)) {
      throw new Error(
        "Заголовок " + rawName + " нельзя задать вручную: ключи передаются только через auth.variable с подтверждением в панели, а cookie — браузером пользователя",
      );
    }
    if (!HEADER_NAME.test(name)) throw new Error("Некорректное имя заголовка: " + rawName.slice(0, 80));
    if (typeof value !== "string" || !HEADER_VALUE.test(value)) {
      throw new Error("Некорректное значение заголовка " + name + ": переводы строк в запросе запрещены");
    }
    result[name] = value;
  }
  return result;
}

/**
 * Ключ отправляется заголовком, поэтому он обязан быть одной строкой без управляющих символов.
 * Многострочный PEM или значение с переводом строки заголовком отправить нельзя — об этом лучше
 * сказать до запроса, чем получить невнятную ошибку Node.
 */
export function assertHeaderSafeSecret(value: string) {
  if (!value.trim()) throw new Error("Значение ключа пустое: отправлять нечего");
  if (!/^[\t\x20-\x7e\x80-\xff]+$/.test(value)) {
    throw new Error("Значение ключа содержит перевод строки или управляющие символы: такой ключ нельзя отправить в заголовке");
  }
}

/** Значение переменной из сохранённых файлов проекта; `null`, если её нет. */
export function findSecretValue(
  files: SecretFiles,
  variable: string,
  file?: string,
): { value: string; file: string } | null {
  if (file) {
    const value = files[file]?.[variable];
    return typeof value === "string" ? { value, file } : null;
  }
  for (const [name, variables] of Object.entries(files)) {
    const value = variables[variable];
    if (typeof value === "string") return { value, file: name };
  }
  return null;
}

/**
 * Текст подтверждения: человек видит, куда именно и каким методом уйдёт ключ.
 *
 * Хост и метод важнее длинного пути и имени файла: вопрос ограничен 400 символами, и обрезать
 * нужно хвост пути, а не адрес назначения. Имя переменной тоже укорачивается — оно нужно для
 * узнавания, а не как единственная защита.
 */
export function approvalQuestion(input: { variable: string; method: string; url: URL; file: string }) {
  const path = (input.url.pathname || "/").slice(0, 80);
  return (
    "Ключ " +
    input.variable.slice(0, 48) +
    " → " +
    input.url.host +
    path +
    " (" +
    input.method.toUpperCase() +
    ")? Разрешить отправку?"
  ).slice(0, 400);
}

export const APPROVAL_OPTIONS = [
  { label: "Разрешить один раз", description: "Запрос выполнится, ключ в ответе модели не появится" },
  { label: "Запретить", description: "Запрос не выполняется, данные проекта не уходят" },
];

/**
 * Ответ сервера не должен вернуть ключ обратно модели: ключ может оказаться эхом в теле, в
 * заголовке или в тексте ошибки. Замена идёт по точному значению, пустые строки пропускаются.
 */
export function redactSecret(text: string, secret?: string) {
  if (!secret || secret.length < 4) return text;
  return text.split(secret).join("[ключ скрыт]");
}

/** Заголовки ответа, которые нужны агенту; остальные (cookie, server, via) не пересказываются. */
const RESPONSE_HEADERS = ["content-type", "location", "retry-after", "www-authenticate", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"];

export function publicResponseHeaders(headers: Record<string, string | string[] | undefined>) {
  const result: Record<string, string> = {};
  for (const name of RESPONSE_HEADERS) {
    const value = headers[name];
    if (value === undefined) continue;
    result[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}
