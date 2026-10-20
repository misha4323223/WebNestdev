import { readdir,readFile,stat } from "node:fs/promises";
import path from "node:path";
import { previewAppAnswers } from "../preview/app-http.js";
import { unreachablePreviewDiagnosis } from "../preview/preview-address.js";
import { getPreview } from "../preview/preview-store.js";
import { previewStatus } from "../preview-manager.js";
import { analyzeForms } from "../qa/form-signal.js";
import { getSandbox } from "../sandbox/sandbox-service.js";
import { registerTool } from "../tool-registry.js";

const MAX_BODY = 20_000;
/** Сколько ссылок страницы проверяется: хватает для реальной страницы и дёшево для вызова инструмента. */
const MAX_ASSET_CHECKS = 12;
const ASSET_TIMEOUT_MS = 4000;
/** Расширения, которые обязаны отдаваться: стили, скрипты, картинки, шрифты. */
const ASSET_EXTENSIONS = /\.(css|m?js|cjs|png|jpe?g|svg|webp|avif|ico|gif|woff2?|ttf|json|map|txt|webmanifest)$/i;

/**
 * Ссылки самой страницы, разрешённые относительно запрошенного маршрута. Внешние адреса пропускаются:
 * за чужой CDN платформа не отвечает, а обычные ссылки-навигация без расширения — это переходы,
 * а не файлы, и SPA-фолбэк отдаёт для них index.html.
 */
export function referencedAssets(html: string, route: string) {
  const directory = route.endsWith("/") ? route : route.replace(/[^/]*$/, "") || "/";
  const seen = new Set<string>();
  for (const match of html.matchAll(/\s(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const raw = match[1].trim();
    if (!raw || raw.startsWith("//") || /^[a-z]+:/i.test(raw) || raw.startsWith("#")) continue;
    const value = raw.split("#")[0].split("?")[0];
    if (!ASSET_EXTENSIONS.test(value)) continue;
    seen.add(value.startsWith("/") ? value : directory + value.replace(/^\.\//, ""));
    if (seen.size >= MAX_ASSET_CHECKS) break;
  }
  return [...seen];
}

/**
 * Проверка, что каждый файл, на который ссылается страница, действительно отдаётся. Проверка одного
 * HTML говорит «страница работает» и при 404 у style.css: пользователь видит в консоли браузера
 * отказ применить стили и пустой экран, а агент считает задачу выполненной.
 */
async function checkReferencedAssets(host: string, port: number, route: string, html: string) {
  const results: { ref: string; status: number; ok: boolean }[] = [];
  for (const ref of referencedAssets(html, route)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ASSET_TIMEOUT_MS);
    try {
      const response = await fetch(`http://${host}:${port}${ref}`, { redirect: "manual", signal: controller.signal });
      results.push({ ref, status: response.status, ok: response.status < 400 });
    } catch {
      results.push({ ref, status: 0, ok: false });
    } finally {
      clearTimeout(timer);
    }
  }
  return results;
}

/** Файлы, в которых может жить форма: разметка и скрипты рядом с ней. */
const FORM_SCAN_EXTENSIONS = /\.(html?|js|mjs|cjs|jsx|tsx|vue|svelte)$/i;
const FORM_SCAN_MAX_FILES = 80;
const FORM_SCAN_MAX_BYTES = 200_000;
const FORM_SCAN_SKIP = new Set(["node_modules", ".git", ".webnestdev", "dist", "build", "coverage", ".next", ".cache", "uploads"]);

/**
 * Просмотр исходников проекта нужен только для сигнала о форме: сам ответ страницы о том, куда
 * уходит заявка, ничего не говорит. Чтение ограничено по глубине и числу файлов: проверка не должна
 * стоить как обход всего репозитория.
 */
async function collectFormSources(root: string) {
  const sources: Array<{ path: string; text: string }> = [];
  async function walk(relative: string, depth: number) {
    if (sources.length >= FORM_SCAN_MAX_FILES || depth > 3) return;
    let entries;
    try {
      entries = await readdir(path.join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (sources.length >= FORM_SCAN_MAX_FILES) return;
      if (entry.name.startsWith(".")) continue;
      const next = relative ? relative + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (!FORM_SCAN_SKIP.has(entry.name)) await walk(next, depth + 1);
        continue;
      }
      if (!FORM_SCAN_EXTENSIONS.test(entry.name)) continue;
      try {
        const info = await stat(path.join(root, next));
        if (info.size > FORM_SCAN_MAX_BYTES) continue;
        sources.push({ path: next, text: await readFile(path.join(root, next), "utf8") });
      } catch {
        // Файл исчез между readdir и чтением — не повод валить проверку.
      }
    }
  }
  await walk("", 0);
  return sources;
}

registerTool({
  name: "project.verify",
  description:
    "Verify the current project after changes. Checks a requested Preview route (input: {path?:string}), successful HTML, a non-empty document, and common server-rendered error signals. Returns structured pass/fail diagnostics. Use this after implementing or fixing a web task; if verification fails, inspect the failed checks, fix the project, and verify again.",
  parameters: { type: "object", additionalProperties: false, properties: { path: { type: "string", description: "Маршрут предпросмотра, например / или /about; по умолчанию /" } } },
  execute: async (input, context) => {
    const requestedPath =
      typeof input === "object" &&
      input !== null &&
      typeof (input as { path?: unknown }).path === "string"
        ? (input as { path: string }).path
        : "/";
    const path = requestedPath.startsWith("/") ? requestedPath : "/" + requestedPath;
    const status = await previewStatus(context.projectId);
    if (!status.running) {
      return {
        ok: false,
        stage: "preview",
        reason: "Предпросмотр не запущен",
        status,
        nextAction:
          "Call preview.start, inspect any startup error, fix the project, then run project.verify again.",
      };
    }

    const current = getPreview(context.projectId);
    if (!current) {
      return {
        ok: false,
        stage: "preview",
        reason: "Состояние предпросмотра недоступно",
        nextAction: "Restart the Preview and run project.verify again.",
      };
    }

    if (!current.port) {
      return {
        ok: false,
        stage: "preview",
        reason: "Предпросмотр запущен, но его порт недоступен",
        nextAction: "Restart the Preview and run project.verify again.",
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const response = await fetch(`http://${current.host}:${current.port}${path}`, {
        redirect: "manual",
        signal: controller.signal,
      });
      const body = (await response.text()).slice(0, MAX_BODY);
      const contentType = response.headers.get("content-type");
      const isHtml = contentType?.toLowerCase().includes("text/html") ?? false;
      const trimmedBody = body.trim();
      const hasDocument = /<html\b/i.test(body) && /<body\b/i.test(body);
      const hasRuntimeErrorSignal = [
        "Internal Server Error",
        "Application Error",
        "Unhandled Runtime Error",
        "Cannot read properties of",
        "ReferenceError:",
        "TypeError:",
      ].some((signal) => body.includes(signal));

      // Файлы страницы проверяются только когда ответ — HTML: для JSON или картинки ссылок нет.
      const assets = isHtml ? await checkReferencedAssets(current.host, current.port, path, body) : [];
      const brokenAssets = assets.filter((asset) => !asset.ok);
      const checks = {
        httpOk: response.ok,
        htmlContentType: isHtml,
        nonEmptyBody: trimmedBody.length > 0,
        htmlDocument: hasDocument,
        noRuntimeErrorSignal: !hasRuntimeErrorSignal,
        assetsResolve: brokenAssets.length === 0,
      };
      const ok = Object.values(checks).every(Boolean);

      // Форма, которая никуда не отправляет данные, проходит все проверки выше: страница цела,
      // ассеты на месте, консоль молчит. Отдельный просмотр исходников называет её имитацией —
      // иначе о том, что заявки не приходят, узнаёт только владелец сайта.
      const sandbox = context.userId ? await getSandbox(context.projectId, context.userId).catch(() => null) : null;
      const forms = sandbox ? analyzeForms(await collectFormSources(sandbox.root).catch(() => [])) : null;

      return {
        ok,
        stage: "http",
        path,
        status: response.status,
        statusText: response.statusText,
        contentType,
        checks,
        assets: { checked: assets.length, failed: brokenAssets },
        /** Форма и её приёмник: `simulated: true` — заявки никуда не приходят. */
        forms,
        warnings: forms?.simulated ? [forms.note] : [],
        body,
        truncated: body.length >= MAX_BODY,
        nextAction: (ok
          ? "Verification passed. Preview returned a non-empty HTML document for the requested route, its referenced assets resolve, and no common server-rendered error signals were found."
          : brokenAssets.length
            ? "Verification failed: the page references files Preview does not serve (" + brokenAssets.map((asset) => asset.ref + " → " + asset.status).join(", ") + "). Create or rename those files, or fix the links in the HTML, then run project.verify again."
            : "Verification failed for the requested route. Inspect the failed checks, HTTP response, or error signals, fix the project, then verify again.") +
          (forms?.simulated
            ? " Отдельно: " + forms.note + " Скажите об этом пользователю в ответе и не называйте форму рабочей, пока не подключён приёмник."
            : ""),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // «fetch failed» без причины агент не может исправить: он трижды повторяет проверку и
      // запуск падает на лимите попыток. Поэтому тот же запрос делается внутри контейнера, и
      // разница между «приложение живо, но недоступно снаружи» и «приложение не поднялось»
      // попадает в результат проверки как действие, а не как текст ошибки.
      const appAnswersInside = current.mode === "container" ? await previewAppAnswers(current).catch(() => false) : false;
      const diagnosis = unreachablePreviewDiagnosis({ message, port: current.port, appAnswersInside });
      return {
        ok: false,
        stage: "http",
        path,
        reason: diagnosis.reason,
        hint: diagnosis.hint,
        preview: { host: current.host, port: current.port, mode: current.mode, appAnswersInside },
        nextAction: appAnswersInside
          ? "Restart Preview (preview.stop, then preview.start) so the platform forwards the app's port, then run project.verify again."
          : "Read the Preview logs (preview.logs), fix the dev command or the project, restart Preview, then run project.verify again.",
      };
    } finally {
      clearTimeout(timeout);
    }
  },
});
