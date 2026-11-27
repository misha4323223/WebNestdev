import { parseRedirects, REDIRECTS_FILE } from "../hosting/seo/redirects.js";
import { pageFacts, type PageFacts } from "./page-facts.js";

/**
 * `seo.check` — проверка SEO до публикации, а не оценка сайта.
 *
 * Панель публикации проверяет живой релиз: каталог релиза, манифест маршрутов, ответ 404 и
 * реальный origin. Агенту до публикации доступно другое: отрендеренные Preview страницы и
 * файлы проекта. Поэтому здесь те же правила (title, description, H1, canonical, lang, alt,
 * внутренние ссылки, robots/sitemap, `_redirects`), но по источнику, который агент может
 * реально исправить, и без сети за пределами Preview.
 *
 * Логика отделена от инструмента и получает `fetchPage`/`readFile` извне: проверка тестируется
 * без песочницы и без Preview, а инструмент отвечает только за доступ к ним.
 */
export type SeoCheckLevel = "critical" | "warning" | "info";

export type SeoCheckIssue = {
  id: string;
  level: SeoCheckLevel;
  title: string;
  detail: string;
  /** Что именно сделать — следующая правка, а не пересказ проблемы. */
  fix: string;
  route?: string;
};

export type SeoCheckPage = {
  route: string;
  status: number;
  title: string;
  h1: number;
  language: string;
  canonical: string;
  noindex: boolean;
};

export type SeoCheckReport = {
  ok: boolean;
  checkedAt: string;
  /** Публичный origin, относительно которого проверяется canonical; null, если он неизвестен. */
  origin: string | null;
  pages: SeoCheckPage[];
  issues: SeoCheckIssue[];
  counts: { critical: number; warning: number; info: number };
  nextAction: string;
};

export type SeoCheckInput = {
  routes?: readonly string[];
  siteUrl?: string;
  /** Отрендеренная страница. Без функции проверяются только файлы проекта. */
  fetchPage?: (route: string) => Promise<{ status: number; html: string }>;
  /** Чтение файла проекта по относительному пути; null — файла нет. */
  readFile: (relativePath: string) => Promise<string | null>;
  /** Где искать статические файлы: public/, dist/ и корень проекта. */
  fileDirs?: readonly string[];
};

/** Сколько маршрутов и ссылок проверяется: хватает для реального сайта и дёшево для шага агента. */
const MAX_ROUTES = 10;
const MAX_LINK_CHECKS = 8;
const DEFAULT_FILE_DIRS = ["public", "dist", "build", "out", ""] as const;

function issue(
  level: SeoCheckLevel,
  id: string,
  title: string,
  detail: string,
  fix: string,
  route?: string,
): SeoCheckIssue {
  return { id, level, title, detail, fix, ...(route ? { route } : {}) };
}

function normalizeRoute(value: string) {
  const clean = value.split("?")[0]?.split("#")[0] ?? "/";
  if (!clean) return "/";
  return clean.startsWith("/") ? clean : "/" + clean;
}

function normalizeOrigin(value: string | undefined) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

async function firstFile(
  readFile: SeoCheckInput["readFile"],
  dirs: readonly string[],
  name: string,
): Promise<string | null> {
  for (const dir of dirs) {
    const text = await readFile(dir ? dir + "/" + name : name).catch(() => null);
    if (text !== null) return text;
  }
  return null;
}

export async function checkSeo(input: SeoCheckInput): Promise<SeoCheckReport> {
  const issues: SeoCheckIssue[] = [];
  const origin = normalizeOrigin(input.siteUrl);
  const routes = [...new Set((input.routes?.length ? input.routes : ["/"]).map(normalizeRoute))].slice(0, MAX_ROUTES);
  const pages: SeoCheckPage[] = [];
  const facts: PageFacts[] = [];

  if (!input.fetchPage) {
    issues.push(issue(
      "info",
      "preview-off",
      "HTML не проверялся",
      "Preview не запущен, поэтому разметка страниц не проверена: проверены только файлы проекта.",
      "Запустите Preview и вызовите seo.check снова, чтобы проверить title, canonical, H1 и ссылки отрендеренных страниц.",
    ));
  }

  for (const route of routes) {
    if (!input.fetchPage) break;
    let response: { status: number; html: string };
    try {
      response = await input.fetchPage(route);
    } catch (error) {
      issues.push(issue(
        "critical",
        "page-unreachable",
        "Маршрут не открывается",
        route + ": " + (error instanceof Error ? error.message : String(error)),
        "Проверьте, что Preview отдаёт этот маршрут (project.verify), исправьте ошибку и запустите seo.check снова.",
        route,
      ));
      continue;
    }
    if (response.status >= 400) {
      issues.push(issue(
        "critical",
        "page-status",
        "Маршрут отвечает ошибкой",
        route + " → HTTP " + response.status,
        "Сделайте так, чтобы публичный маршрут отдавал 200, и запустите seo.check снова.",
        route,
      ));
      continue;
    }
    if (!/<html\b/i.test(response.html)) {
      issues.push(issue(
        "warning",
        "page-not-html",
        "Маршрут не отдаёт HTML",
        route + " → не документ HTML",
        "Публичная страница должна отдавать HTML с title и H1, а не JSON или пустой ответ.",
        route,
      ));
      continue;
    }

    const page = pageFacts(response.html, route);
    facts.push(page);
    pages.push({
      route,
      status: response.status,
      title: page.title,
      h1: page.h1,
      language: page.lang,
      canonical: page.canonical,
      noindex: page.noindex,
    });

    if (!page.title) {
      issues.push(issue("critical", "title-missing", "Нет title", route + " без заголовка в выдаче.", "Добавьте один <title> в head этой страницы (seo.templates даёт готовый head).", route));
    } else if (page.title.length > 65) {
      issues.push(issue("info", "title-long", "Длинный title", route + ": " + page.title.length + " символов, больше 65 обрежется в выдаче.", "Сократите title до 50–65 символов, оставив главный смысл страницы.", route));
    } else if (page.title.length < 15) {
      issues.push(issue("info", "title-short", "Короткий title", route + ": " + page.title.length + " символов.", "Опишите страницу конкретнее: короткий title плохо отличает её в выдаче.", route));
    }

    if (!page.description) {
      issues.push(issue("warning", "description-missing", "Нет meta description", route + " без описания: поисковик покажет случайный фрагмент.", "Добавьте <meta name=\"description\"> на 50–160 символов.", route));
    } else if (page.description.length > 160) {
      issues.push(issue("info", "description-long", "Длинное description", route + ": " + page.description.length + " символов.", "Сократите description до 160 символов, чтобы он не обрезался.", route));
    }

    if (page.h1 === 0) {
      issues.push(issue("critical", "h1-missing", "Нет H1", route + " без основного заголовка.", "Добавьте один видимый <h1> с темой страницы.", route));
    } else if (page.h1 > 1) {
      issues.push(issue("warning", "h1-multiple", "Несколько H1", route + ": " + page.h1 + " заголовка H1.", "Оставьте один H1, остальные понизьте до h2.", route));
    }

    if (page.noindex) {
      issues.push(issue("critical", "noindex", "Публичная страница закрыта от индексации", route + ": в meta robots стоит noindex.", "Уберите noindex с публичной страницы; он нужен только приватным маршрутам.", route));
    }

    if (!page.canonical) {
      issues.push(issue("warning", "canonical-missing", "Нет canonical", route + " без canonical.", "Добавьте <link rel=\"canonical\"> с абсолютным адресом страницы.", route));
    } else if (origin) {
      try {
        const parsed = new URL(page.canonical, origin);
        if (parsed.origin !== origin) {
          issues.push(issue("warning", "canonical-origin", "Canonical ведёт на другой origin", route + " → " + parsed.origin, "Поставьте canonical на публичный адрес сайта (" + origin + "), а не на чужой домен или localhost.", route));
        } else if (parsed.pathname !== route) {
          issues.push(issue("warning", "canonical-path", "Canonical указывает на другой путь", route + " → " + parsed.pathname, "Сделайте canonical равным пути самой страницы; иначе поисковик склеит её с другой.", route));
        }
      } catch {
        issues.push(issue("warning", "canonical-invalid", "Canonical не разбирается как URL", route + " → " + page.canonical, "Укажите абсолютный URL страницы в canonical.", route));
      }
    } else if (page.canonical.startsWith("/")) {
      issues.push(issue("info", "canonical-relative", "Canonical относительный", route + " → " + page.canonical, "Передайте siteUrl в seo.check и сделайте canonical абсолютным: относительный адрес поисковики понимают хуже.", route));
    }

    if (page.imagesWithoutAlt > 0) {
      issues.push(issue("warning", "img-alt-missing", "У изображений нет alt", route + ": без alt " + page.imagesWithoutAlt, "Добавьте alt каждому смысловому изображению; декоративным — alt=\"\".", route));
    }

    if (route === "/" && !page.lang) {
      issues.push(issue("warning", "lang-missing", "Нет lang у html", "У главной страницы не указан язык.", "Добавьте lang=\"ru\" (или язык сайта) в тег <html>.", route));
    }
  }

  const homepage = facts.find(page => page.path === "/") ?? facts[0];
  if (homepage && !homepage.ogTitle && !homepage.ogDescription) {
    issues.push(issue("info", "og-missing", "Нет Open Graph", "Главная без og:title и og:description: ссылка в соцсети покажет случайный текст.", "Добавьте og:title, og:description и og:image (seo.templates возвращает готовый набор).", homepage.path));
  }

  const byTitle = new Map<string, string[]>();
  for (const page of facts) {
    if (!page.title) continue;
    byTitle.set(page.title, [...(byTitle.get(page.title) ?? []), page.path]);
  }
  for (const [title, paths] of byTitle) {
    if (paths.length < 2) continue;
    issues.push(issue("warning", "title-duplicate", "Одинаковый title на разных страницах", paths.join(", ") + " → «" + title + "»", "Сделайте title каждой страницы уникальным."));
  }

  const known = new Set<string>();
  for (const page of pages) {
    known.add(page.route);
    known.add(page.route.endsWith("/") ? page.route.slice(0, -1) || "/" : page.route + "/");
  }
  const targets = new Set<string>();
  for (const page of facts) {
    for (const link of page.links) {
      const target = normalizeRoute(link);
      if (known.has(target) || target === "/") continue;
      targets.add(target);
      if (targets.size >= MAX_LINK_CHECKS) break;
    }
  }
  const broken: string[] = [];
  if (input.fetchPage) {
    for (const target of targets) {
      try {
        const response = await input.fetchPage(target);
        if (response.status >= 400) broken.push(target + " → HTTP " + response.status);
      } catch {
        // Сеть до Preview уже проверяется на самих маршрутах: здесь молчание честнее выдумки.
      }
    }
  }
  if (broken.length) {
    issues.push(issue(
      "critical",
      "broken-link",
      "Внутренние ссылки ведут на отсутствующие страницы",
      broken.join(", "),
      "Создайте эти страницы или исправьте ссылки; для старых адресов используйте _redirects.",
    ));
  }

  const dirs = input.fileDirs ?? DEFAULT_FILE_DIRS;
  const has404 = await firstFile(input.readFile, dirs, "404.html");
  if (!has404) {
    issues.push(issue("warning", "404-missing", "Нет 404.html", "В проекте не найден 404.html: неизвестный адрес покажет стандартный ответ хостинга.", "Добавьте public/404.html (seo.templates возвращает готовую страницу)."));
  }

  const redirects = await firstFile(input.readFile, dirs, REDIRECTS_FILE);
  if (redirects !== null) {
    const parsed = parseRedirects(redirects);
    if (parsed.errors.length) {
      issues.push(issue(
        "warning",
        "redirects-invalid",
        "Ошибки в _redirects",
        parsed.errors.slice(0, 4).map(error => "строка " + error.line + ": " + error.message).join("; "),
        "Исправьте строки по формату `/старый /новый 301`: только внутренние пути, 301/302 и один * в конце.",
      ));
    }
  }

  const robots = await firstFile(input.readFile, dirs, "robots.txt");
  if (robots === null) {
    issues.push(issue("info", "robots-generated", "robots.txt не в проекте", "Платформа строит robots.txt из опубликованного релиза — свой файл нужен только для нестандартных правил.", "Ничего не добавляйте, если не нужны особые правила."));
  } else if (/^\s*disallow:\s*\/\s*$/im.test(robots)) {
    issues.push(issue("critical", "robots-blocks-all", "robots.txt закрывает весь сайт", "В файле есть `Disallow: /`.", "Уберите `Disallow: /` или замените его на конкретные приватные разделы."));
  }

  const sitemap = await firstFile(input.readFile, dirs, "sitemap.xml");
  if (sitemap === null) {
    issues.push(issue("info", "sitemap-generated", "sitemap.xml не в проекте", "Платформа строит sitemap.xml из реальных страниц релиза.", "Ничего не добавляйте, если набор страниц стандартный."));
  } else {
    const locs = [...sitemap.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map(match => match[1] ?? "");
    if (!locs.length) {
      issues.push(issue("warning", "sitemap-empty", "Sitemap пустой", "В файле нет ни одного <loc>.", "Удалите свой sitemap.xml и оставьте генерацию платформе или перечислите реальные страницы."));
    } else if (origin && locs.some(loc => {
      try { return new URL(loc).origin !== origin; } catch { return true; }
    })) {
      issues.push(issue("warning", "sitemap-origin", "Sitemap содержит чужой origin", locs.find(loc => { try { return new URL(loc).origin !== origin; } catch { return true; } }) ?? "", "Перечислите адреса на публичном домене сайта (" + origin + ")."));
    }
  }

  const counts = { critical: 0, warning: 0, info: 0 };
  for (const item of issues) counts[item.level] += 1;
  const ok = counts.critical === 0;

  return {
    ok,
    checkedAt: new Date().toISOString(),
    origin,
    pages,
    issues,
    counts,
    nextAction: counts.critical
      ? "Исправьте критические пункты по порядку и запустите seo.check снова; не называйте SEO готовым, пока критических пунктов нет."
      : counts.warning
        ? "Критических пунктов нет. Исправьте предупреждения или честно перечислите, какие остались и почему."
        : "Проверка пройдена для этих маршрутов. Финальный аудит опубликованного релиза запускает панель публикации: его цифры не выдумывайте.",
  };
}
