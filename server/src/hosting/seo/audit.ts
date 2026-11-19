import { open } from "node:fs/promises";
import path from "node:path";
import { readRedirectsFromRelease } from "./redirects.js";
import type { HostingRouteManifest } from "./route-manifest.js";

/**
 * Технический аудит, а не «оценка SEO». Он проверяет то, за что отвечает платформа:
 * индексируемость, canonical, sitemap/robots, 404 и базовую разметку. Контент, ссылочное
 * и поведенческие факторы здесь не оцениваются и не должны выглядеть как оценка.
 */
export type SeoAuditLevel = "critical" | "warning" | "info";

export type SeoAuditIssue = {
  id: string;
  level: SeoAuditLevel;
  title: string;
  detail: string;
  url?: string;
};

export type SeoAuditResult = {
  version: 1;
  checkedAt: string;
  mode: string;
  origin: string;
  pages: number;
  issues: SeoAuditIssue[];
};

type PageFacts = {
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

function decode(value: string) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .trim();
}

function attr(tag: string, name: string) {
  const match = tag.match(new RegExp(name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i"));
  return match ? decode(match[1] ?? match[2] ?? match[3] ?? "") : "";
}

function pageFacts(html: string, route: string): PageFacts {
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

function issue(level: SeoAuditLevel, id: string, title: string, detail: string, url?: string): SeoAuditIssue {
  return { id, level, title, detail, ...(url ? { url } : {}) };
}

function normalizePath(value: string) {
  const clean = value.split("?")[0]?.split("#")[0] ?? "/";
  return clean.startsWith("/") ? clean : "/" + clean;
}

async function readOptional(file: string) {
  // Аудит читает чужой HTML; 12 страниц по 25 МБ не должны занимать память процесса.
  // Для проверки метаданных достаточно первого мегабайта, а sitemap/robots обычно
  // значительно меньше. Полный файл всё равно не нужен.
  let handle;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function liveStatus(origin: string): Promise<number | null> {
  if (process.env.SEO_AUDIT_LIVE === "0") return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(origin + "/__nestdev-seo-404-probe__", {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { "user-agent": "NestdevSeoAudit/1.0" },
    });
    return response.status;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function auditSeoRelease(input: {
  releaseDir: string;
  seoDir: string;
  manifest: HostingRouteManifest;
  origin: string;
  mode: string;
}): Promise<SeoAuditResult> {
  const issues: SeoAuditIssue[] = [];
  const pages = input.manifest.routes.slice(0, 12);
  const facts: PageFacts[] = [];
  for (const route of pages) {
    const html = await readOptional(path.join(input.releaseDir, route.file));
    if (html === null) {
      issues.push(issue("critical", "route-file-missing", "Страница из манифеста не читается", route.path, input.origin + route.path));
      continue;
    }
    facts.push(pageFacts(html, route.path));
  }

  const homepage = facts.find(page => page.path === "/") ?? facts[0];
  if (!homepage) {
    issues.push(issue("critical", "index-missing", "Нет index.html", "Caddy не сможет отдать главную страницу."));
  } else {
    if (!homepage.title) issues.push(issue("critical", "title-missing", "Нет title", "Главная страница без заголовка в выдаче.", input.origin + "/"));
    if (homepage.title.length > 65) issues.push(issue("info", "title-long", "Длинный title", "Более 65 символов может обрезаться в выдаче.", input.origin + "/"));
    if (!homepage.description) issues.push(issue("warning", "description-missing", "Нет meta description", "Поисковик покажет случайный фрагмент вместо описания.", input.origin + "/"));
    if (homepage.h1 === 0) issues.push(issue("critical", "h1-missing", "Нет H1", "У главной страницы нет основного заголовка.", input.origin + "/"));
    if (homepage.h1 > 1) issues.push(issue("warning", "h1-multiple", "Несколько H1", "Для структуры страницы лучше один H1.", input.origin + "/"));
    if (!homepage.lang) issues.push(issue("warning", "lang-missing", "Нет lang у html", "Укажите язык страницы в атрибуте lang.", input.origin + "/"));
    if (!homepage.canonical) {
      issues.push(issue("warning", "canonical-missing", "Нет canonical", "Добавьте canonical на основной адрес страницы.", input.origin + "/"));
    } else {
      let canonicalPath = "";
      let canonicalOrigin = "";
      try {
        const parsed = new URL(homepage.canonical, input.origin);
        canonicalPath = parsed.pathname;
        canonicalOrigin = parsed.origin;
      } catch {
        canonicalPath = "";
      }
      if (canonicalPath !== "/" || canonicalOrigin !== input.origin) {
        issues.push(issue("warning", "canonical-mismatch", "Canonical не совпадает с основным адресом", homepage.canonical, input.origin + "/"));
      }
    }
    if (homepage.noindex) issues.push(issue("critical", "homepage-noindex", "Главная закрыта от индексации", "В meta robots стоит noindex.", input.origin + "/"));
    if (homepage.imagesWithoutAlt > 0) {
      issues.push(issue("warning", "img-alt-missing", "У изображений нет alt", "Без alt: " + homepage.imagesWithoutAlt + " на главной.", input.origin + "/"));
    }
    if (!homepage.ogTitle && !homepage.ogDescription) {
      issues.push(issue("info", "og-missing", "Нет Open Graph", "Ссылка в соцсети покажет случайный заголовок и описание.", input.origin + "/"));
    }
  }

  const known = new Set(input.manifest.routes.map(route => route.path));
  const broken = new Set<string>();
  for (const page of facts) {
    for (const link of page.links) {
      const target = normalizePath(link);
      // `/about` и `/about/` — один маршрут: Caddy делает для каталога редирект на
      // слеш, и аудит не должен считать такую ссылку битой.
      const alternate = target.endsWith("/") ? target.slice(0, -1) : target + "/";
      if (!known.has(target) && !known.has(alternate) && target !== "/") broken.add(target);
    }
  }
  if (broken.size) {
    issues.push(issue("warning", "internal-links-broken", "Внутренние ссылки ведут на отсутствующие страницы", [...broken].slice(0, 8).join(", ")));
  }

  if (!input.manifest.has404) {
    issues.push(issue("warning", "404-missing", "Нет 404.html", "Статический сайт без своей 404-страницы покажет стандартный ответ Caddy."));
  }
  if (input.mode === "static" && !input.manifest.has404) {
    issues.push(issue("info", "static-no-404", "Статический режим без 404.html", "Добавьте 404.html, чтобы ошибки выглядели как часть сайта."));
  }

  const userSitemap = await readOptional(path.join(input.releaseDir, "sitemap.xml"));
  const generatedSitemap = await readOptional(path.join(input.seoDir, "sitemap.xml"));
  const sitemap = userSitemap ?? generatedSitemap;
  if (!sitemap) {
    issues.push(issue("warning", "sitemap-missing", "Нет sitemap.xml", "Платформа не смогла создать sitemap: проверьте route manifest.", input.origin + "/sitemap.xml"));
  } else {
    const locs = [...sitemap.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map(match => decode(match[1] ?? ""));
    if (!locs.length) {
      issues.push(issue("warning", "sitemap-empty", "Sitemap пустой", "В файле нет ни одного <loc>.", input.origin + "/sitemap.xml"));
    } else if (/<sitemapindex\b/i.test(sitemap)) {
      // Sitemap index ссылается на куски, а не на главную: проверяем, что все они на своём
      // origin и что куски не выходят за лимит поисковика. Тянуть их по сети не нужно.
      const foreign = locs.filter(loc => {
        try { return new URL(loc).origin !== input.origin; } catch { return true; }
      });
      if (foreign.length) {
        issues.push(issue("warning", "sitemap-index-origin", "Sitemap index содержит чужой origin", foreign.slice(0, 3).join(", "), input.origin + "/sitemap.xml"));
      }
      for (const loc of locs) {
        try {
          const chunkName = new URL(loc).pathname.replace(/^\/+/, "");
          const chunk = await readOptional(path.join(input.seoDir, chunkName))
            ?? await readOptional(path.join(input.releaseDir, chunkName));
          if (chunk === null) {
            issues.push(issue("critical", "sitemap-chunk-missing", "Кусок sitemap index не найден", loc, loc));
            break;
          }
          if ((chunk.match(/<url>/g) ?? []).length > 50_000) {
            issues.push(issue("warning", "sitemap-chunk-large", "В куске sitemap больше 50 000 URL", loc, loc));
            break;
          }
        } catch {
          issues.push(issue("warning", "sitemap-index-invalid", "Некорректная ссылка в sitemap index", loc, input.origin + "/sitemap.xml"));
          break;
        }
      }
    } else if (!locs.some(loc => {
      try { return new URL(loc).origin === input.origin && new URL(loc).pathname === "/"; } catch { return false; }
    })) {
      issues.push(issue("warning", "sitemap-origin", "Sitemap не указывает на главную", "Проверьте адрес сайта и canonical.", input.origin + "/sitemap.xml"));
    }
  }

  const redirects = await readRedirectsFromRelease(input.releaseDir);
  if (redirects.errors.length) {
    issues.push(issue("warning", "redirects-invalid", "Ошибки в _redirects", redirects.errors.slice(0, 4).map(error => "строка " + error.line + ": " + error.message).join("; ")));
  }

  const userRobots = await readOptional(path.join(input.releaseDir, "robots.txt"));
  const generatedRobots = await readOptional(path.join(input.seoDir, "robots.txt"));
  const robots = userRobots ?? generatedRobots;
  if (!robots) {
    issues.push(issue("warning", "robots-missing", "Нет robots.txt", "Платформа не смогла создать robots.txt.", input.origin + "/robots.txt"));
  } else if (/^\s*disallow:\s*\/\s*$/im.test(robots)) {
    issues.push(issue("critical", "robots-blocks-all", "robots.txt закрывает весь сайт", "Строка Disallow: / запрещает обход.", input.origin + "/robots.txt"));
  }

  const status = await liveStatus(input.origin);
  if (status !== null) {
    if (input.mode === "static" && status !== 404) {
      issues.push(issue("critical", "missing-page-status", "Отсутствующая страница отвечает не 404", "Получен HTTP " + status + " вместо 404.", input.origin + "/__nestdev-seo-404-probe__"));
    }
    if (input.mode === "spa" && status === 404) {
      issues.push(issue("info", "spa-missing-404", "SPA отдаёт 404 на отсутствующий путь", "Для клиентского маршрута это может быть ожидаемо."));
    }
  }

  return {
    version: 1,
    checkedAt: new Date().toISOString(),
    mode: input.mode,
    origin: input.origin,
    pages: pages.length,
    issues,
  };
}

export function parseSeoAudit(value: string | null | undefined): SeoAuditResult | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<SeoAuditResult>;
    if (parsed.version !== 1 || !Array.isArray(parsed.issues)) return null;
    return {
      version: 1,
      checkedAt: typeof parsed.checkedAt === "string" ? parsed.checkedAt : "",
      mode: typeof parsed.mode === "string" ? parsed.mode : "",
      origin: typeof parsed.origin === "string" ? parsed.origin : "",
      pages: Number.isFinite(parsed.pages) ? Number(parsed.pages) : 0,
      issues: parsed.issues.filter(item => item && typeof item.id === "string" && (item.level === "critical" || item.level === "warning" || item.level === "info")),
    };
  } catch {
    return null;
  }
}
