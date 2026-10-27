import { randomUUID } from "node:crypto";

/**
 * Заголовки и тело письма — общие для всех писем платформы (поддержка, оплата, предупреждение
 * о списании), чтобы русская тема и большие вложения не ломались в одном месте и работали в
 * другом.
 *
 * Тема кодируется по RFC 2047: без этого русская тема приходит как «=?UTF-8?» мусор. Тело —
 * base64 с разбивкой по 76 символов: у SMTP есть лимит в 998 байт на строку, и длинная строка
 * молча превращается в отказ на больших письмах.
 */

/** Заголовок в UTF-8 по RFC 2047. */
export function encodedHeader(value: string) {
  const clean = value.replace(/[\r\n]+/g, " ").trim();
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  return "=?UTF-8?B?" + Buffer.from(clean, "utf8").toString("base64") + "?=";
}

/** Длинная base64-строка без переводов строк превышает лимит SMTP в 998 байт на строку. */
export function wrap76(value: string) {
  return value.replace(/(.{76})/g, "$1\r\n").replace(/\r\n$/, "");
}

/** Строка, начинающаяся с точки, в DATA означает «конец письма» — её нужно удвоить. */
export function dotStuffed(message: string) {
  return message.split("\r\n").map(line => (line.startsWith(".") ? "." + line : line)).join("\r\n");
}

/** Идентификатор письма: уникальный и на своём домене, чтобы фильтры не считали письмо дублем. */
export function messageId() {
  return "<" + randomUUID() + "@webnestdev>";
}
