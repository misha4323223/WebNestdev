/**
 * Разбор HTML без новых зависимостей.
 *
 * Провайдеры отдают нам две разные вещи: сниппеты поиска (небольшие куски HTML, которые надо
 * превратить в текст) и страницы целиком для `web.read` (где нужен читаемый текст, а не разметка).
 * Парсер здесь нарочно простой и недоверчивый: он не исполняет ничего, не ходит по ссылкам и
 * ограничивает результат, а неожидаемую разметку оставляет пустой строкой вместо исключения.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  times: "×",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  euro: "€",
  pound: "£",
  yen: "¥",
  rarr: "→",
  larr: "←",
};

/** `&amp;`, `&#39;`, `&#x2F;` — три формы, которые реально встречаются в выдаче. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Текст из короткого куска разметки: теги выкидываются, сущности раскрываются. */
export function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

const DROPPED_BLOCKS = /<(script|style|noscript|template|svg|iframe|object|canvas)\b[^>]*>[\s\S]*?<\/\1>/gi;
/**
 * Навигация вокруг статьи не является содержанием страницы, а места занимает больше его.
 * В документации VitePress/Docusaurus боковое меню идёт перед текстом и без этого шага `web.read`
 * возвращал бы одни названия разделов.
 */
const DROPPED_CHROME = /<(nav|aside|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi;
const BLOCK_BREAKS = /<\/?(p|div|section|article|header|footer|main|nav|aside|h[1-6]|li|ul|ol|tr|td|th|table|blockquote|pre|figure|figcaption|form|br|hr)\b[^>]*>/gi;

/**
 * Читаемый текст страницы: то, что человек увидел бы без разметки.
 *
 * Блочные теги становятся переводами строк (иначе абзацы склеиваются в одну строку и текст
 * теряет смысл), строчные просто исчезают, `<title>` достаётся отдельно в `extractTitle`.
 */
export function readableText(html: string): string {
  const withoutBlocks = html
    .replace(DROPPED_BLOCKS, " ")
    .replace(DROPPED_CHROME, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const withBreaks = withoutBlocks.replace(BLOCK_BREAKS, "\n");
  const withoutTags = withBreaks.replace(/<[^>]*>/g, " ");
  return decodeEntities(withoutTags)
    .split("\n")
    .map(line => line.replace(/[ \t\f\v\u00a0]+/g, " ").trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && lines[index - 1].length > 0))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Основное содержимое страницы, если оно размечено: `<main>` или `<article>`.
 *
 * Документация и статьи почти всегда держат текст в одном из этих контейнеров, а всё остальное —
 * меню, хлебные крошки, подвал. Без этого шага `web.read` отдавал бы первые сотни символов навигации,
 * и модель платила бы контекстом за ссылки вместо ответа. Если контейнера нет или в нём мало текста,
 * возвращается страница целиком — терять содержимое из-за отсутствия разметки нельзя.
 */
export function mainContent(html: string): string {
  const lower = html.toLowerCase();
  for (const tag of ["main", "article"]) {
    const start = lower.search(new RegExp("<" + tag + "\\b", "i"));
    const end = lower.lastIndexOf("</" + tag + ">");
    if (start < 0 || end <= start) continue;
    const block = html.slice(start, end + tag.length + 3);
    if (readableText(block).length >= 400) return block;
  }
  return html;
}

/** `<title>` страницы, раскрытый и обрезанный: он же служит заголовком результата `web.read`. */
export function extractTitle(html: string): string {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? textOf(match[1]).slice(0, 300) : "";
}

/**
 * Ссылка из выдачи DuckDuckGo.
 *
 * Результат приходит редиректом `//duckduckgo.com/l/?uddg=<адрес>`; сам адрес лежит в параметре
 * `uddg`. Рекламные ссылки (`duckduckgo.com/y.js`) и служебные страницы в результаты не годятся,
 * поэтому такой адрес превращается в пустую строку, а вызывающий его пропускает.
 */
export function resolveDuckDuckGoHref(href: string): string {
  const raw = decodeEntities(href).trim();
  if (!raw) return "";
  let parsed: URL;
  try {
    parsed = new URL(raw.startsWith("//") ? "https:" + raw : raw, "https://duckduckgo.com");
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  const host = parsed.hostname.toLowerCase();
  if (host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) {
    if (parsed.pathname === "/l/") {
      const target = parsed.searchParams.get("uddg");
      return target ? safeHttpUrl(target) : "";
    }
    // Реклама и служебные переходы (`/y.js`, `/settings`, `/feedback`).
    return "";
  }
  return parsed.href;
}

/** Адрес, который можно отдать модели: только http(s), без учётных данных внутри ссылки. */
export function safeHttpUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (url.username || url.password) return "";
    return url.href;
  } catch {
    return "";
  }
}
