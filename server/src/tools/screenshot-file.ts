import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";

/**
 * Снимки проверок лежат внутри проекта, но в служебной папке: `.webnestdev/` исключён из истории
 * (`.git/info/exclude`), поэтому PNG не попадает ни в коммит, ни в панель изменений, а агент и
 * человек открывают его обычным путём в дереве проекта.
 */
export const SCREENSHOT_DIR = ".webnestdev/screenshots";

export type SavedScreenshot = { path: string; url: string; bytes: number };

export type LayoutFinding = {
  kind: "overflow" | "beyondViewport" | "brokenImage" | "smallTapTarget" | "clippedText";
  selector: string;
  detail: string;
};

/**
 * Что видно про вёрстку без зрения: сама картинка нужна человеку, а эти числа — модели, которая
 * картинку прочитать не может. Уехавший вбок грид, обрезанный заголовок и битая картинка видны
 * здесь как факты, поэтому «криво» перестаёт быть тем, о чём узнают только от пользователя.
 */
export type LayoutAudit = {
  viewport: { width: number; height: number };
  page: { scrollWidth: number; scrollHeight: number; horizontalOverflow: number };
  counts: { visible: number; findings: number };
  findings: LayoutFinding[];
};

const MAX_FINDINGS = 12;

export async function readLayout(page: Page): Promise<LayoutAudit> {
  // Никаких локальных функций внутри evaluate: сборка через tsx подмешивает к ним хелпер
  // `__name`, а он в контексте страницы не существует и роняет проверку целиком.
  return page.evaluate(maxFindings => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const findings: Array<{ kind: string; selector: string; detail: string }> = [];

    let visibleCount = 0;
    const elements = Array.from(document.body?.querySelectorAll("*") ?? []);
    for (const element of elements) {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 2 || rect.height <= 2) continue;
      visibleCount++;
      if (findings.length >= maxFindings) continue;

      const tag = element.tagName.toLowerCase();
      const raw = typeof element.className === "string" ? element.className : "";
      const classes = raw.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(name => "." + name).join("");
      const selector = tag + (element.id ? "#" + element.id : "") + classes;

      // 8 px — уже не пиксельная погрешность округления, а реально вылезший элемент.
      if (rect.right > width + 8) {
        findings.push({ kind: "beyondViewport", selector, detail: "правый край " + Math.round(rect.right) + " px при экране " + width + " px" });
      } else if (rect.left < -8) {
        findings.push({ kind: "beyondViewport", selector, detail: "левый край " + Math.round(rect.left) + " px" });
      }
      if (findings.length >= maxFindings) continue;

      if (tag === "img") {
        const image = element as HTMLImageElement;
        const source = image.currentSrc || image.src;
        if (source && image.complete && image.naturalWidth === 0) {
          findings.push({ kind: "brokenImage", selector, detail: "не загрузилась: " + source.slice(0, 160) });
        }
      }
      if (findings.length >= maxFindings) continue;

      const text = (element.textContent ?? "").trim();
      if (text && element.scrollWidth > element.clientWidth + 2 && style.overflowX === "hidden") {
        findings.push({ kind: "clippedText", selector, detail: "текст обрезан по ширине: " + text.slice(0, 60) });
      }
      if (findings.length >= maxFindings) continue;

      if (width <= 480 && /^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(element.tagName)) {
        if (rect.height < 36 || rect.width < 36) {
          findings.push({ kind: "smallTapTarget", selector, detail: "цель " + Math.round(rect.width) + "×" + Math.round(rect.height) + " px — меньше 36 px, по ней трудно попасть пальцем" });
        }
      }
    }

    const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0);
    const horizontalOverflow = Math.max(0, scrollWidth - width);
    if (horizontalOverflow > 8 && findings.length < maxFindings) {
      findings.unshift({ kind: "overflow", selector: "html", detail: "страница шире экрана на " + horizontalOverflow + " px — появляется горизонтальная прокрутка" });
    }
    return {
      viewport: { width, height },
      page: { scrollWidth, scrollHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0), horizontalOverflow },
      counts: { visible: visibleCount, findings: findings.length },
      findings: findings.slice(0, maxFindings) as LayoutAudit["findings"],
    };
  }, MAX_FINDINGS);
}

/** Адрес, по которому снимок открывает человек: панель и агент видят одну и ту же картинку. */
export function screenshotUrl(projectId: string, relative: string) {
  return "/api/projects/" + encodeURIComponent(projectId) + "/screenshot?path=" + encodeURIComponent(relative);
}

/**
 * Сохраняет PNG в служебную папку проекта. `fullPage` нужен для проверки длинных лендингов:
 * дефект часто живёт на втором экране, которого нет в кадре первого.
 */
export async function saveScreenshot(
  page: Page,
  input: { root: string; projectId: string; label: string; fullPage?: boolean },
): Promise<SavedScreenshot> {
  const buffer = await page.screenshot({ type: "png", fullPage: input.fullPage ?? false });
  const folder = path.join(input.root, SCREENSHOT_DIR);
  await mkdir(folder, { recursive: true });
  const name = input.label.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40) + "-" + Date.now().toString(36) + ".png";
  const absolute = path.join(folder, name);
  await writeFile(absolute, buffer);
  const relative = SCREENSHOT_DIR + "/" + name;
  return { path: relative, url: screenshotUrl(input.projectId, relative), bytes: buffer.length };
}

/** Короткая строка для `diagnostic`: что именно поломалось в вёрстке. */
export function layoutSummary(audit: LayoutAudit) {
  if (!audit.findings.length) {
    return "Вёрстка без замечаний: горизонтальной прокрутки нет, элементов за краем экрана, битых картинок и обрезанного текста не найдено.";
  }
  return "Замечания по вёрстке (" + audit.findings.length + "): " + audit.findings.slice(0, 4).map(item => item.selector + " — " + item.detail).join("; ") + (audit.findings.length > 4 ? " …" : "") + ".";
}
