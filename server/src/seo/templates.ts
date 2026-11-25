/**
 * SEO-шаблоны для AI-агента.
 *
 * Это не генератор сайта: шаблон возвращает готовые фрагменты, которые агент переносит в
 * конкретный фреймворк. Sitemap, robots и HTML-подтверждение Search Console строит hosting
 * overlay из реального релиза, поэтому копировать их в `public/` по умолчанию не нужно:
 * пользовательский файл имел бы приоритет и мог бы разойтись с реальными страницами.
 */

export type SeoTemplateKind = "landing" | "blog" | "app" | "hybrid";

export type SeoTemplateInput = {
  kind?: SeoTemplateKind;
  siteUrl?: string;
  pagePath?: string;
  title?: string;
  description?: string;
  lang?: string;
  imageUrl?: string;
};

export type SeoTemplateResult = {
  kind: SeoTemplateKind;
  siteUrl: string;
  canonicalUrl: string;
  head: string;
  jsonLd: string;
  files: Record<string, string>;
  routing: { mode: "static" | "hybrid" | "spa"; note: string };
  robots: { managedByHosting: true; note: string };
  checklist: string[];
};

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function normalizeSiteUrl(value: string | undefined) {
  try {
    const url = new URL(value?.trim() || "https://example.com");
    if (url.protocol !== "https:" && url.protocol !== "http:") return "https://example.com";
    return (url.origin + url.pathname.replace(/\/+$/, "")).replace(/\/+$/, "");
  } catch {
    return "https://example.com";
  }
}

function normalizePath(value: string | undefined) {
  const raw = (value ?? "/").trim();
  if (!raw || raw === "/") return "/";
  return "/" + raw.replace(/^\/+/, "").replace(/\s+/g, "-");
}

function canonicalFor(siteUrl: string, pagePath: string) {
  return siteUrl + (pagePath === "/" ? "/" : pagePath);
}

function defaultTitle(kind: SeoTemplateKind) {
  if (kind === "blog") return "Блог";
  if (kind === "app") return "Приложение";
  if (kind === "hybrid") return "Продукт";
  return "Сайт";
}

function routingFor(kind: SeoTemplateKind): SeoTemplateResult["routing"] {
  if (kind === "app") {
    return {
      mode: "spa",
      note: "Закрытые маршруты приложения не индексируются; публичный лендинг должен быть отдельной HTML-страницей.",
    };
  }
  if (kind === "hybrid") {
    return {
      mode: "hybrid",
      note: "Публичные страницы и лендинг — отдельные HTML; интерактивное приложение живёт под /app/*.",
    };
  }
  return {
    mode: "static",
    note: "Каждый публичный URL — отдельный HTML-файл. Неизвестный путь должен отвечать 404, а не index.html.",
  };
}

export function buildSeoTemplate(input: SeoTemplateInput = {}): SeoTemplateResult {
  const kind = input.kind ?? "landing";
  const siteUrl = normalizeSiteUrl(input.siteUrl);
  const pagePath = normalizePath(input.pagePath);
  const canonicalUrl = canonicalFor(siteUrl, pagePath);
  const rawTitle = input.title?.trim() || defaultTitle(kind);
  const rawDescription = input.description?.trim() || "Краткое описание страницы: что здесь можно узнать или сделать.";
  const title = escapeHtml(rawTitle);
  const description = escapeHtml(rawDescription);
  const lang = (input.lang ?? "ru").replace(/[^a-z-]/gi, "").toLowerCase() || "ru";
  const noindex = kind === "app" && pagePath !== "/";
  const image = input.imageUrl?.trim() || siteUrl + "/og.png";
  const safeImage = escapeHtml(image);
  const jsonLdType = kind === "blog" ? "Blog" : "WebSite";
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": jsonLdType,
    name: rawTitle,
    url: canonicalUrl,
    description: rawDescription,
    inLanguage: lang,
  }, null, 2)
    // JSON-LD встроен в HTML. `<` внутри текста не должен закрыть script-тег.
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");

  const head = [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}">`,
    `<link rel="canonical" href="${escapeHtml(canonicalUrl)}">`,
    ...(noindex ? ['<meta name="robots" content="noindex, nofollow">'] : []),
    `<meta property="og:type" content="${kind === "blog" ? "article" : "website"}">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:url" content="${escapeHtml(canonicalUrl)}">`,
    `<meta property="og:image" content="${safeImage}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${description}">`,
    `<meta name="twitter:image" content="${safeImage}">`,
    `<script type="application/ld+json">${jsonLd}</script>`,
  ].join("\n");

  const notFound = [
    "<!doctype html>",
    `<html lang="${escapeHtml(lang)}">`,
    "<head>",
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <meta name="robots" content="noindex, nofollow">',
    `  <title>Страница не найдена — ${title}</title>`,
    "</head>",
    "<body>",
    "  <main>",
    "    <h1>Страница не найдена</h1>",
    '    <p>Возможно, адрес изменился или в ссылке опечатка.</p>',
    `    <p><a href="${escapeHtml(siteUrl + "/")}">Вернуться на главную</a></p>`,
    "  </main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");

  const redirects = [
    "# _redirects: положите файл в public/ (или в корень готового dist).",
    "# Строки с # игнорируются; внешние адреса и open redirect платформа отклонит.",
    "# /старый-адрес /новый-адрес 301",
    "# /blog/* /articles/:splat 301",
    "",
  ].join("\n");

  return {
    kind,
    siteUrl,
    canonicalUrl,
    head,
    jsonLd,
    files: {
      "public/404.html": notFound,
      "public/_redirects": redirects,
    },
    routing: routingFor(kind),
    robots: {
      managedByHosting: true,
      note: "robots.txt и sitemap.xml генерируются из HTML активного релиза. Создавайте свои файлы только если нужен нестандартный набор правил: пользовательский файл главнее overlay.",
    },
    checklist: [
      "title и description уникальны для каждой публичной страницы",
      "один H1 и семантические H2/H3",
      "canonical — абсолютный URL на SITE_URL, без query",
      "og:title, og:description, og:image заполнены",
      "у всех содержательных изображений есть alt",
      "lang соответствует языку страницы",
      "публичные страницы — отдельные HTML для static/hybrid",
      "приватные маршруты приложения закрыты noindex",
      "после публикации запустить SEO-аудит в панели публикации",
    ],
  };
}
