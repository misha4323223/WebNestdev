import path from "node:path";
import { z } from "zod";
import { previewAccessFor } from "../preview/owner-access.js";
import { previewStatus } from "../preview-manager.js";
import { readFileInside } from "../sandbox/path-guard.js";
import { getSandbox } from "../sandbox/sandbox-service.js";
import { checkSeo } from "../seo/check.js";
import { registerTool } from "../tool-registry.js";

/**
 * `seo.check` — то, что агент может исправить сам до публикации.
 *
 * Панель публикации проверяет живой релиз, но её аудит запускается после публикации и только
 * пользователем: агенту он недоступен. Здесь та же техническая проверка, но по отрендеренным
 * страницам Preview и по файлам проекта — то есть по тому, что агент реально меняет. Инструмент
 * ничего не публикует, не пишет файлы и не ходит в сеть за пределы Preview.
 */

const MAX_HTML_CHARS = 200_000;
const PAGE_TIMEOUT_MS = 8_000;

const checkSchema = z.object({
  routes: z.array(z.string().max(500)).max(10).optional(),
  siteUrl: z.string().max(500).optional(),
});

registerTool({
  name: "seo.check",
  description:
    "Check the project's SEO before publication: title, meta description, H1, canonical, lang, " +
    "noindex, image alt, duplicate titles, internal links that 404, 404.html, _redirects syntax, " +
    "robots.txt and sitemap.xml. Input: {routes?:string[] (max 10), siteUrl?:string}. " +
    "Rendered pages are read through a running Preview; project files are read from public/, dist/, " +
    "build/, out/ and the project root. With no Preview it checks files only and says so. " +
    "Each issue carries a `fix`. Run it on every public route before telling the user the site is " +
    "SEO-ready, fix the critical issues, then run it again. It is not the audit of the published " +
    "site: after the user publishes, the publication panel audits the live release, so never " +
    "invent its numbers.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      routes: {
        type: "array",
        items: { type: "string" },
        maxItems: 10,
        description: "Публичные маршруты для проверки, например [\"/\", \"/about\"]; по умолчанию [\"/\"]",
      },
      siteUrl: {
        type: "string",
        description: "Публичный origin сайта для проверки canonical и sitemap, например https://example.ru",
      },
    },
  },
  execute: async (input, context) => {
    const value = checkSchema.parse(input ?? {});
    const routes = value.routes?.length ? value.routes : ["/"];

    // Preview проверяется тем же путём, что project.verify: страница отдаётся приложением
    // проекта, а не собирается из исходников заново.
    let fetchPage: ((route: string) => Promise<{ status: number; html: string }>) | undefined;
    let preview: "checked" | "not_running" | "unavailable" = "not_running";
    const status = await previewStatus(context.projectId).catch(() => null);
    if (status?.running) {
      try {
        const access = previewAccessFor(context.projectId, status);
        fetchPage = async route => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
          try {
            const response = await access.fetch(route, { redirect: "manual", signal: controller.signal });
            const html = (await response.text()).slice(0, MAX_HTML_CHARS);
            return { status: response.status, html };
          } finally {
            clearTimeout(timer);
          }
        };
        preview = "checked";
      } catch {
        preview = "unavailable";
      }
    }

    const sandbox = context.userId ? await getSandbox(context.projectId, context.userId).catch(() => null) : null;
    const readFile = sandbox
      ? async (relativePath: string) => {
        try {
          return await readFileInside(sandbox.root, path.join(sandbox.root, relativePath));
        } catch {
          return null;
        }
      }
      : async () => null;

    const report = await checkSeo({ routes, siteUrl: value.siteUrl, fetchPage, readFile });
    return {
      ...report,
      preview,
      note: "seo.check проверяет проект до публикации. Аудит живого релиза запускает панель публикации после публикации: его результат не выдумывайте.",
    };
  },
});
