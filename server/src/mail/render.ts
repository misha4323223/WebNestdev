import { createHmac, timingSafeEqual } from "node:crypto";
import { hashKey } from "../security/hash-key.js";
import { normalizeEmail } from "./address.js";

/**
 * Подстановки и ссылка отписки.
 *
 * Тема и текст письма пишутся один раз на кампанию, а уходят каждому своему: `{{name}}`,
 * `{{email}}`, `{{project}}`, `{{plan}}`. Неизвестный тег остаётся в письме как есть — админка
 * предупреждает о таком до отправки, и это честнее, чем молча выбросить часть текста.
 *
 * Ссылка отписки обязана быть в каждом письме: человек, который её не нашёл, нажимает «спам», и
 * это бьёт по репутации домена сильнее, чем сама отписка. Поэтому подпись отписки подставляется
 * отдельным тегом `{{unsubscribe}}`, а если автор письма его не использовал — строка дописывается
 * в конец и в текстовой, и в HTML-версии.
 */

export type MailTags = {
  name?: string;
  email?: string;
  project?: string;
  plan?: string;
  unsubscribe?: string;
};

/** Теги, которые платформа умеет раскрывать; остальные остаются в тексте и попадают в warnings. */
export const KNOWN_TAGS = ["name", "email", "project", "plan", "unsubscribe"] as const;

// Любое содержимое в двойных скобках, а не только латиница: `{{ник}}` — тоже тег, который не
// раскроется, и человек должен узнать об этом до отправки, а не увидеть в письме скобки.
const TAG_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Неизвестные теги в тексте: админка показывает их до отправки, чтобы человек поправил письмо. */
export function unknownTags(text: string) {
  const found = new Set<string>();
  for (const match of text.matchAll(TAG_PATTERN)) {
    const name = match[1];
    if (!KNOWN_TAGS.includes(name as (typeof KNOWN_TAGS)[number])) found.add(name);
  }
  return [...found];
}

function substitute(text: string, tags: MailTags) {
  return text.replace(TAG_PATTERN, (whole, name: string) => {
    const value = (tags as Record<string, string | undefined>)[name];
    return value === undefined ? whole : value;
  });
}

export function renderSubject(template: string, tags: MailTags) {
  return substitute(template, tags).replace(/\s+/g, " ").trim();
}

export function renderText(template: string, tags: MailTags) {
  return substitute(template, tags).trim();
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character] ?? character);
}

/**
 * HTML-версия из текста письма. Письмо пишется текстом, потому что так его не сломает случайная
 * вставка тега; HTML собирается здесь: абзацы, переносы и ссылка отписки становятся настоящей
 * ссылкой, а не текстом.
 */
export function textToHtml(text: string, unsubscribeUrl: string) {
  const paragraphs = text.split(/\n{2,}/).map(block =>
    block
      .split("\n")
      .map(line => {
        const escaped = escapeHtml(line);
        if (!unsubscribeUrl) return escaped;
        const marker = escapeHtml(unsubscribeUrl);
        return escaped.includes(marker) ? escaped.replace(marker, '<a href="' + marker + '">' + marker + "</a>") : escaped;
      })
      .join("<br>"),
  );
  return paragraphs.map(block => "<p>" + block + "</p>").join("\n");
}

/** Строка-подпись с отпиской для текстовой версии. */
export function unsubscribeFooter(url: string) {
  return "Отписаться от рассылки: " + url;
}

function unsubscribeSecret() {
  return hashKey(process.env.WEBNESTDEV_MAIL_UNSUBSCRIBE_SECRET, "WEBNESTDEV_MAIL_UNSUBSCRIBE_SECRET");
}

/**
 * Подпись адреса для ссылки отписки: `t=<адрес в base64url>.<HMAC>`.
 *
 * Адрес попадает в ссылку не «просто так»: страница отписки должна знать, кого отписывать, а
 * хранить список выданных ссылок — это ещё одна таблица и ещё один срок жизни. HMAC делает
 * ссылку неподделываемой: подставить чужой адрес нельзя, не зная ключа, а ключ — тот же секрет
 * платформы, что и у остальных подписей.
 */
export function unsubscribeToken(email: string) {
  const normalized = normalizeEmail(email);
  const payload = Buffer.from(normalized, "utf8").toString("base64url");
  const signature = createHmac("sha256", unsubscribeSecret()).update(normalized, "utf8").digest("hex");
  return payload + "." + signature;
}

/** Разбор ссылки: `null` — подпись не сходится или адрес испорчен. */
export function readUnsubscribeToken(token: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  let email: string;
  try {
    email = Buffer.from(token.slice(0, dot), "base64url").toString("utf8");
  } catch {
    return null;
  }
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  // Сравнение в постоянном времени: подпись — это пароль к адресу, и по скорости ответа не должно
  // быть видно, насколько близко подобрана чужая подпись.
  const expected = createHmac("sha256", unsubscribeSecret()).update(normalized, "utf8").digest("hex");
  const provided = token.slice(dot + 1).toLowerCase();
  if (provided.length !== expected.length) return null;
  return timingSafeEqual(Buffer.from(provided, "utf8"), Buffer.from(expected, "utf8")) ? normalized : null;
}

export function unsubscribeUrl(platformUrl: string, email: string) {
  return platformUrl.replace(/\/+$/, "") + "/unsubscribe?t=" + unsubscribeToken(email);
}
