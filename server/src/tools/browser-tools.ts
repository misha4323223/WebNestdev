import { getPreview } from "../preview/preview-store.js";
import { previewStatus } from "../preview-manager.js";
import { previewProxyBase } from "../preview/preview-rewrite.js";
import { createSession, deleteSession } from "../auth/auth-store.js";
import { SESSION_COOKIE } from "../auth/auth.js";
import { registerTool } from "../tool-registry.js";
import { getSandbox } from "../sandbox/sandbox-service.js";
import { withBrowserSlot } from "./browser-limiter.js";
import { layoutSummary, readLayout, saveScreenshot, type LayoutAudit, type SavedScreenshot } from "./screenshot-file.js";
import { BROWSER_VIEWPORTS, readBrowserViewport } from "./browser-viewport.js";
import { runBrowserScenario as runScenario } from "./browser-scenario/engine.js";
import { browserScenarioDescription, browserScenarioParameters, browserRuntimeParameters } from "./browser-scenario/schema.js";
import {
  MAX_RUNTIME_MS,
  briefList,
  classifyRuntimeFailures,
  loadAndSettle,
  readPageEvidence,
  type ConsoleMessage,
  type PageEvidence,
  type PageStyleFacts,
  type RuntimeFailureInput,
} from "./browser-evidence.js";

export { classifyRuntimeFailures } from "./browser-evidence.js";

const MAX_BODY = 200_000;
const MAX_DIAGNOSTIC_ITEMS = 100;
const DEFAULT_PATH = "/";

function getPath(input: unknown) {
  const requestedPath =
    typeof input === "object" &&
    input !== null &&
    typeof (input as { path?: unknown }).path === "string"
      ? (input as { path: string }).path
      : DEFAULT_PATH;
  return requestedPath.startsWith("/") ? requestedPath : "/" + requestedPath;
}

async function fetchPreview(projectId: string, path: string) {
  const status = await previewStatus(projectId);
  if (!status.running) {
    throw new Error(
      String((status as { error?: string }).error ?? "Preview is not running")
    );
  }

  const current = getPreview(projectId);
  if (!current) throw new Error("Состояние предпросмотра недоступно — предпросмотр не запущен");
  const url = `http://${current.host}:${current.port}${path}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: controller.signal,
    });
    const body = (await response.text()).slice(0, MAX_BODY);
    return { response, body, path };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to open Preview at ${path}: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function extractMatches(body: string, pattern: RegExp) {
  return [...body.matchAll(pattern)]
    .slice(0, MAX_DIAGNOSTIC_ITEMS)
    .map((match) => match[1] ?? match[0]);
}

function inspectHtml(body: string) {
  const scripts = extractMatches(body, /<script\b[^>]*?(?:src=["']([^"']+)["'][^>]*|)(?:\/>|>)/gi);
  const stylesheets = extractMatches(
    body,
    /<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi
  );
  const links = extractMatches(body, /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi);
  const images = extractMatches(body, /<img\b[^>]*src=["']([^"']+)["'][^>]*>/gi);
  const title = body.match(/<title\b[^>]*>([\s\\S]*?)<\/title>/i)?.[1]?.trim() ?? null;
  const errorSignals = [
    "Uncaught ",
    "Unhandled Runtime Error",
    "ChunkLoadError",
    "Failed to fetch",
    "Cannot read properties of",
    "is not defined",
  ].filter((signal) => body.includes(signal));

  return {
    title,
    scripts,
    stylesheets,
    links,
    images,
    errorSignals,
    counts: {
      scripts: scripts.length,
      stylesheets: stylesheets.length,
      links: links.length,
      images: images.length,
    },
  };
}

registerTool({
  name: "browser.open",
  description:
    "Open the project's running Preview page over HTTP and return status, headers, content type, bounded body, and basic HTML diagnostics. Use this to inspect what the generated website actually serves.",
  execute: async (input, context) => {
    const path = getPath(input);
    const { response, body } = await fetchPreview(context.projectId, path);
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: path,
      contentType: response.headers.get("content-type"),
      headers: Object.fromEntries(response.headers.entries()),
      diagnostics:
        response.headers.get("content-type")?.toLowerCase().includes("text/html")
          ? inspectHtml(body)
          : null,
      truncated: body.length >= MAX_BODY,
      body,
    };
  },
});


import { chromium,type Browser,type Page } from "playwright";

const MAX_CONSOLE_ITEMS = 100;
const MAX_NETWORK_ITEMS = 100;
/** Что дала одна загрузка страницы: адрес контейнера и прокси панели возвращают одно и то же по форме. */
type DoorEvidence = {
  url: string;
  status: number | null;
  statusText: string | null;
  rendered: PageEvidence;
  htmlBytes: number;
  console: Array<ConsoleMessage & { type: string }>;
  failedRequests: Array<{ url: string; method: string; error: string }>;
  httpErrors: Array<{ url: string; method: string; status: number }>;
  pageErrors: string[];
  failures: string[];
  background: string[];
  /** Вёрстка и PNG: проверка отрисовки не должна оставаться словами «страница не пустая». */
  layout?: LayoutAudit;
  screenshot?: SavedScreenshot;
};

/**
 * Одна дверь к приложению: адрес контейнера и адрес прокси платформы — два разных пути к одному
 * проекту. Кука нужна только второй двери: прокси пускает лишь владельца проекта.
 */
export type DoorView = {
  viewport?: { width: number; height: number };
  hasTouch?: boolean;
  isMobile?: boolean;
};

async function loadDoor(
  browser: Browser,
  url: string,
  cookie?: { name: string; value: string },
  capture?: { root: string; projectId: string; label: string },
  view: DoorView = {},
): Promise<DoorEvidence> {
  const context = await browser.newContext({
    viewport: view.viewport ?? { width: 1440, height: 900 },
    ...(view.hasTouch ? { hasTouch: true } : {}),
    ...(view.isMobile ? { isMobile: true } : {}),
  });
  // Кука ставится на весь источник: приложение внутри кадра ходит и в свой /api.
  if (cookie) await context.addCookies([{ name: cookie.name, value: cookie.value, url: new URL(url).origin }]);
  const page = await context.newPage();
  const consoleMessages: Array<ConsoleMessage & { type: string }> = [];
  const failedRequests: Array<{ url: string; method: string; error: string }> = [];
  const httpErrors: Array<{ url: string; method: string; status: number }> = [];
  const pageErrors: string[] = [];
  try {
    page.on("console", message => {
      if (consoleMessages.length < MAX_CONSOLE_ITEMS) {
        consoleMessages.push({ type: message.type(), text: message.text().slice(0, 2000), url: message.location()?.url ?? "" });
      }
    });
    page.on("pageerror", error => {
      if (pageErrors.length < MAX_CONSOLE_ITEMS) pageErrors.push(error.message.slice(0, 2000));
    });
    page.on("response", response => {
      if (response.status() >= 400 && httpErrors.length < MAX_NETWORK_ITEMS) {
        httpErrors.push({ url: response.url().slice(0, 4000), method: response.request().method(), status: response.status() });
      }
    });
    page.on("requestfailed", request => {
      if (failedRequests.length < MAX_NETWORK_ITEMS) {
        failedRequests.push({
          url: request.url().slice(0, 4000),
          method: request.method(),
          error: request.failure()?.errorText ?? "request failed",
        });
      }
    });

    const runtimeDeadline = setTimeout(() => void page.close().catch(() => undefined), MAX_RUNTIME_MS);
    const response = await loadAndSettle(page, url);
    const rendered = await readPageEvidence(page);
    const html = await page.content();
    clearTimeout(runtimeDeadline);

    // Снимок и сводка вёрстки — по желанию: без владельца проекта сохранять PNG некуда, и
    // проверка не должна падать из-за того, что картинку не удалось записать.
    let layout: LayoutAudit | undefined;
    let screenshot: SavedScreenshot | undefined;
    if (capture) {
      try {
        layout = await readLayout(page);
        screenshot = await saveScreenshot(page, { ...capture, fullPage: false });
      } catch {
        layout = undefined;
        screenshot = undefined;
      }
    }

    const consoleErrors = consoleMessages.filter(item => item.type === "error").map(item => ({ text: item.text, url: item.url ?? "" }));
    const judged = classifyRuntimeFailures({
      pageErrors,
      consoleErrors,
      failedRequests,
      httpErrors,
      documentStatus: response?.status() ?? null,
      blank: rendered.blank,
      styles: rendered.styles,
    });
    return {
      url,
      status: response?.status() ?? null,
      statusText: response?.statusText() ?? null,
      rendered,
      htmlBytes: Buffer.byteLength(html, "utf8"),
      console: consoleMessages,
      failedRequests,
      httpErrors,
      pageErrors,
      failures: judged.failures,
      background: judged.background,
      layout,
      screenshot,
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** Результат второй двери: она может быть недоступна, и это не поломка проекта. */
type ProxyDoorResult = {
  checked: boolean;
  url: string;
  reason?: string;
  ok?: boolean;
  status?: number | null;
  rendered?: PageEvidence;
  failures?: string[];
  background?: string[];
};

/**
 * Проверка той дверью, которой пользуется панель. Прямая проверка контейнера видит приложение, а не
 * предпросмотр: переписанные пути, отданные заголовки и отказ в кадре живут только в прокси, и
 * именно так получается «всё запустилось, а у пользователя белая страница». Кука передаётся снаружи,
 * чтобы этот проход можно было проверить тестом без входа в аккаунт.
 */
export async function inspectPreviewThroughPanelProxy(input: {
  projectId: string;
  path: string;
  selfBase: string;
  cookie: { name: string; value: string };
  view?: DoorView;
}): Promise<ProxyDoorResult> {
  const url = input.selfBase.replace(/\/+$/, "") + previewProxyBase(input.projectId) + input.path.replace(/^\/+/, "");
  try {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.WEBNESTDEV_BROWSER_EXECUTABLE || undefined });
    try {
      const door = await loadDoor(browser, url, input.cookie, undefined, input.view);
      // Сам вход не открылся: прокси ответил отказом (нет сессии, проект не найден). Это не поломка
      // страницы — проверка честно говорит, что через панель посмотреть не удалось.
      if (door.status === null || door.status === 401 || door.status === 403 || door.status === 404) {
        return { checked: false, url, reason: "прокси панели ответил HTTP " + (door.status ?? "без ответа") };
      }
      return { checked: true, url, ok: door.failures.length === 0, status: door.status, rendered: door.rendered, failures: door.failures, background: door.background };
    } finally {
      await browser.close();
    }
  } catch (error) {
    // Адрес платформы может быть недостижим изнутри проверки: это ограничение среды, а не поломка
    // проекта, поэтому причина называется, а не превращается в провал.
    return { checked: false, url, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Дверь панели с сессией владельца проекта. Chromium запускается внутри того же контейнера, поэтому
 * «что видит пользователь» — это 127.0.0.1 и тот же маршрут прокси, который отдаёт iframe панели.
 * `WEBNESTDEV_SELF_URL` переопределяет адрес платформы (отдельная сеть, тесты).
 */
async function inspectProxyDoor(input: { projectId: string; path: string; userId?: string; view?: DoorView }): Promise<ProxyDoorResult> {
  const selfBase = process.env.WEBNESTDEV_SELF_URL?.trim() || "http://127.0.0.1:" + (process.env.PORT?.trim() || "8787");
  if (!input.userId) return { checked: false, url: selfBase + previewProxyBase(input.projectId), reason: "неизвестен владелец проекта" };
  let sessionId = "";
  try {
    const session = await createSession(input.userId);
    sessionId = session.id;
    return await inspectPreviewThroughPanelProxy({ projectId: input.projectId, path: input.path, selfBase, cookie: { name: SESSION_COOKIE, value: session.id }, view: input.view });
  } catch (error) {
    return { checked: false, url: selfBase + previewProxyBase(input.projectId), reason: error instanceof Error ? error.message : String(error) };
  } finally {
    // Кука нужна только на время проверки: сессия не должна её пережить.
    if (sessionId) await deleteSession(sessionId).catch(() => undefined);
  }
}

async function inspectRuntimePage(projectId: string, path: string, userId?: string, input?: unknown) {
  const viewportName = readBrowserViewport((input as { viewport?: unknown } | null)?.viewport);
  const view: DoorView = {
    viewport: BROWSER_VIEWPORTS[viewportName],
    ...(viewportName === "mobile" ? { hasTouch: true, isMobile: true } : {}),
  };
  const status = await previewStatus(projectId);
  if (!status.running) {
    throw new Error(String((status as { error?: string }).error ?? "Preview is not running"));
  }
  const current = getPreview(projectId);
  if (!current) throw new Error("Состояние предпросмотра недоступно — предпросмотр не запущен");

  // Куда положить PNG: служебная папка проекта. Владельца нет — проверка идёт без снимка.
  const sandbox = userId ? await getSandbox(projectId, userId).catch(() => null) : null;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.WEBNESTDEV_BROWSER_EXECUTABLE || undefined });
  let door: DoorEvidence;
  try {
    door = await loadDoor(
      browser,
      `http://${current.host}:${current.port}${path}`,
      undefined,
      sandbox ? { root: sandbox.root, projectId, label: "runtime" } : undefined,
      view,
    );
  } finally {
    await browser.close();
  }
  const panel = await inspectProxyDoor({ projectId, path, userId, view });
  const failures = [...door.failures, ...(panel.failures ?? []).map(item => "через прокси панели: " + item)];
  const rendered = door.rendered;
  const ok = failures.length === 0;
  const sameBothWays = panel.checked && door.failures.length === 0 && (panel.failures?.length ?? 0) > 0;
  return {
    ok,
    status: door.status,
    statusText: door.statusText,
    viewport: viewportName,
    url: door.url,
    title: rendered.title,
    /** Что видно на странице — по этому и судят о белом экране, а не по скриншоту в base64. */
    rendered,
    console: door.console,
    failedRequests: door.failedRequests,
    httpErrors: door.httpErrors,
    pageErrors: door.pageErrors,
    background: door.background,
    /** PNG проверки: путь внутри проекта и адрес, по которому его открывает человек. */
    screenshot: door.screenshot ?? null,
    /** Вёрстка числами: что вылезло за экран, что обрезано, какие картинки не загрузились. */
    layout: door.layout ?? null,
    htmlBytes: door.htmlBytes,
    /** Та же страница, но дверью панели: только она показывает, что видит пользователь в iframe. */
    panelDoor: panel.checked
      ? { checked: true, url: panel.url, status: panel.status ?? null, ok: panel.ok === true, rendered: panel.rendered, failures: panel.failures ?? [], background: panel.background ?? [] }
      : { checked: false, url: panel.url, reason: panel.reason ?? "" },
    failures,
    diagnostic: (ok
      ? "Рендеринг прошёл: страница отрисовала содержимое, ошибок страницы, консоли и сети нет."
      : "Проверка рендеринга не прошла: " + briefList(failures) +
        (door.background.length ? " Фоновые ответы (" + briefList(door.background) + ") — не поломка: страница без авторизации отвечает 401, и чинить их не нужно." : "")) +
      (door.layout ? " " + layoutSummary(door.layout) : "") +
      (rendered.styles.noStyles ? " На странице нет ни одного правила CSS: если проект и должен быть без стилей, это нормально, иначе стили не подключены и экран выглядит белым." : "") +
      (sameBothWays ? " Прямо из контейнера приложение отвечает нормально — значит пользователь видит пустой или неоформленный экран из-за прокси панели, а не из-за самого приложения." : "") +
      (panel.checked ? "" : " Через прокси панели проверить не удалось: " + (panel.reason ?? "неизвестная причина") + "."),
    nextAction: ok
      ? "Runtime verification passed."
      : rendered.styles.unstyled
        ? "Стили не применились, поэтому страница выглядит белой. Проверьте подключение CSS: импорт стилей в точке входа, путь к собранному css-файлу и ответ сервера на него (для файла .css ожидается текстовый тип, а не HTML) — без действующих правил страница останется неоформленной."
        : rendered.blank
          ? "Страница пустая: приложение ничего не отрисовало. Проверьте точку входа (монтирование в #root или #app), стартовый маршрут и состояние загрузки до ответа авторизации: экран не должен оставаться пустым, пока запросы сессии не ответили."
          : "Исправьте то, что перечислено в failures, и запустите browser.runtime снова.",
  };
}

registerTool({
  name: "browser.scenario",
  description: browserScenarioDescription,
  parameters: browserScenarioParameters,
  // Chromium is launched inside the server container without a memory limit, so only a
  // configured number of checks may run at once; withBrowserSlot holds that place.
  execute: async (input, context) => withBrowserSlot(() => runScenario(context.projectId, input, context.userId)),
});

registerTool({
  name: "browser.runtime",
  description:
    "Open the Preview in a real headless Chromium browser, execute client-side JavaScript, and report what the page actually rendered: visible text, its size, blank screen, and whether styles applied (declared vs loaded stylesheets, CSS rules in effect, body background/color, `unstyled`). A PNG of the checked page is saved inside the project and returned as `screenshot` (path + url — open it with browser.screenshot or the file panel), and `layout` lists layout defects by CSS selector: page wider than the viewport, elements beyond the screen edge, broken images, clipped text. Console errors, failed network requests, HTTP 5xx and the document status come with it. Both doors are checked and returned: `url`/`rendered` is the container address the app itself answers on, `panelDoor` is the same page loaded through the platform's own preview proxy — the door the panel's iframe uses, so a page that only breaks for the user is reported too. Background 4xx from the app's own API calls and aborted requests are listed separately as `background` and are not failures; a 4xx for a .css or .js file is a failure, because without it the page is white. Use this after browser.open or project.verify when runtime behavior matters.",
  parameters: browserRuntimeParameters,
  execute: async (input, context) => withBrowserSlot(() => inspectRuntimePage(context.projectId, getPath(input), context.userId, input)),
});

registerTool({
  name: "browser.inspect",
  description:
    "Inspect a Preview HTML page without returning the full body. Reports title, loaded resource references, counts, and common error strings found in the server-rendered HTML. This does not claim to execute JavaScript.",
  execute: async (input, context) => {
    const path = getPath(input);
    const { response, body } = await fetchPreview(context.projectId, path);
    const contentType = response.headers.get("content-type");
    const isHtml = contentType?.toLowerCase().includes("text/html") ?? false;

    return {
      ok: response.ok && isHtml,
      status: response.status,
      statusText: response.statusText,
      url: path,
      contentType,
      htmlDiagnostics: isHtml ? inspectHtml(body) : null,
      note: "Diagnostics are derived from the HTTP response HTML; browser.inspect does not execute client-side JavaScript or capture a screenshot.",
    };
  },
});
