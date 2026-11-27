/**
 * Разбор публичной HTML-страницы: то, что можно прочитать из разметки без исполнения JS.
 *
 * Модуль общий для двух проверок: технический аудит опубликованного релиза
 * (`hosting/seo/audit.ts`) и `seo.check` агента до публикации. Один разбор — один набор
 * правил: иначе панель и агент считали бы разные H1 на одной и той же странице.
 */
export type PageFacts = {
  path: string;
  title: string;
  description: string;
  canonical: string;
  lang: string;
  ogTitle: string;
  ogDescription: string;
  h1: number;
  noindex: boolean;
  imagesWithoutAlt: number;
  links: string[];
};

export function decode(value: string) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .trim();
}

export function attr(tag: string, name: string) {
  const match = tag.match(new RegExp(name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i"));
  return match ? decode(match[1] ?? match[2] ?? match[3] ?? "") : "";
}

export function pageFacts(html: string, route: string): PageFacts {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  const description = metaTags
    .find(tag => attr(tag, "name").toLowerCase() === "description");
  const robots = metaTags
    .find(tag => attr(tag, "name").toLowerCase() === "robots");
  const ogTitle = metaTags.find(tag => attr(tag, "property").toLowerCase() === "og:title");
  const ogDescription = metaTags.find(tag => attr(tag, "property").toLowerCase() === "og:description");
  const canonical = (html.match(/<link\b[^>]*>/gi) ?? [])
    .find(tag => attr(tag, "rel").toLowerCase() === "canonical");
  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0] ?? "";
  const images = html.match(/<img\b[^>]*>/gi) ?? [];
  const links = [...html.matchAll(/<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)]
    .map(match => match[1] ?? match[2] ?? "")
    .filter(href => href.startsWith("/") && !href.startsWith("//"))
    .map(href => href.split("#")[0] ?? "")
    .filter(Boolean);
  return {
    path: route,
    title: decode(title),
    description: description ? attr(description, "content") : "",
    canonical: canonical ? attr(canonical, "href") : "",
    lang: attr(htmlTag, "lang"),
    ogTitle: ogTitle ? attr(ogTitle, "content") : "",
    ogDescription: ogDescription ? attr(ogDescription, "content") : "",
    h1: (html.match(/<h1\b[^>]*>/gi) ?? []).length,
    noindex: robots ? /noindex/i.test(attr(robots, "content")) : false,
    imagesWithoutAlt: images.filter(tag => !/\balt\s*=/.test(tag)).length,
    links: [...new Set(links)].slice(0, 250),
  };
}
