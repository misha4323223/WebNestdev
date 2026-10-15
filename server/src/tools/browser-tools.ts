import { getPreview } from "../preview/preview-store.js";
import { previewStatus } from "../preview-manager.js";
import { registerTool } from "../tool-registry.js";
import { withBrowserSlot } from "./browser-limiter.js";

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


import { chromium,type Page } from "playwright";

const MAX_CONSOLE_ITEMS = 100;
const MAX_NETWORK_ITEMS = 100;
const MAX_RUNTIME_MS = 20_000;
/**
 * Сколько символов видимого текста возвращается модели. Раньше обе проверки не возвращали ничего,
 * что описывает *содержимое* страницы: модель получала список ошибок и скриншот в base64, который
 * прочитать не может. Отсюда и запуски, потраченные на «белый экран»: агент видел, что проверка не
 * прошла, но не знал, что именно отрисовано, и перебирал файлы наугад.
 */
const MAX_EVIDENCE_TEXT = 1200;
/** Сколько времени страница получает на отрисовку после загрузки — SPA монтируется не в load. */
const SETTLE_MS = 900;
/**
 * `networkidle` ждётся не дольше этого. Приложение, которое опрашивает свой API, не становится
 * «тихим» никогда, и прежний `goto(..., {waitUntil:"networkidle"})` на нём висел до таймаута —
 * проверка падала по времени, а не по делу.
 */
const NETWORK_IDLE_MS = 4_000;

/** Что на самом деле видно на странице: то единственное, по чему можно судить о белом экране. */
export type PageEvidence = {
  title: string;
  /** Видимый текст страницы одной строкой (начало, до MAX_EVIDENCE_TEXT символов). */
  text: string;
  textChars: number;
  /** Элементы с ненулевым размером: у пустой страницы их нет. */
  visibleElements: number;
  /** Ничего не отрисовано. Картинка, canvas или видео считаются содержимым: это про пустоту. */
  blank: boolean;
};

/**
 * Снимок того, что браузер отрисовал. `clientWidth/clientHeight` вместо innerHTML: пустой
 * `<div id="root">` и страница с текстом различаются именно размером видимого содержимого.
 */
async function readPageEvidence(page: Page): Promise<PageEvidence> {
  const raw = await page.evaluate(() => {
    const body = document.body;
    const text = (body?.innerText ?? "").replace(/\s+/g, " ").trim();
    let visibleElements = 0;
    for (const element of Array.from(body?.querySelectorAll("*") ?? [])) {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
      if (element.clientWidth > 2 && element.clientHeight > 2) visibleElements++;
    }
    return { title: document.title, text, textChars: text.length, visibleElements };
  });
  return {
    title: raw.title,
    text: raw.text.slice(0, MAX_EVIDENCE_TEXT),
    textChars: raw.textChars,
    visibleElements: raw.visibleElements,
    blank: raw.textChars === 0 && raw.visibleElements === 0,
  };
}

/** Загрузка плюс короткое ожидание отрисовки: SPA рисует себя уже после `load`. */
async function loadAndSettle(page: Page, url: string) {
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: MAX_RUNTIME_MS });
  await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_MS }).catch(() => undefined);
  await page.waitForTimeout(SETTLE_MS);
  return response;
}

/** Сообщение консоли: `url` нужен, чтобы отличить фон от настоящей ошибки приложения. */
export type ConsoleMessage = { text: string; url?: string };

export type RuntimeFailureInput = {
  pageErrors: string[];
  consoleErrors: ConsoleMessage[];
  failedRequests: Array<{ url: string; error: string }>;
  httpErrors: Array<{ url: string; status: number }>;
  /** Статус самого документа: 404 на маршруте — это не «фон», а несуществующая страница. */
  documentStatus: number | null;
  blank: boolean;
};

/**
 * Что считать поломкой, а что — фоном.
 *
 * Фон — это 4xx от собственных запросов приложения и отменённые запросы; страница без авторизации
 * обязана отвечать 401, а переход отменяет ещё летящие запросы, и требование «ноль таких ответов»
 * делало проверку непроходимой навсегда: агент бесконечно «чинил» работающее приложение.
 * Тот же 401 приходит второй раз — как ошибка консоли «Failed to load resource: … status of 401»,
 * поэтому сообщения этого вида с ответом 4xx относятся к фону, а не к ошибкам приложения.
 *
 * Поломка — то, что видит пользователь: пустой экран, ошибки страницы и консоли, недошедшие
 * запросы, 5xx и несуществующий маршрут. Это и делает проверку строже прежней, потому что
 * пустой экран раньше проходил её: `expectVisible body` виден и на белой странице.
 */
export function classifyRuntimeFailures(input: RuntimeFailureInput) {
  const aborted = input.failedRequests.filter(item => /ERR_ABORTED|NS_BINDING_ABORTED/i.test(item.error));
  const broken = input.failedRequests.filter(item => !/ERR_ABORTED|NS_BINDING_ABORTED/i.test(item.error));
  const serverErrors = input.httpErrors.filter(item => item.status >= 500);
  const backgroundHttp = input.httpErrors.filter(item => item.status < 500);
  // Браузер пишет загрузку с 4xx в консоль как ошибку; это тот же фон, а не ошибка приложения.
  const resourceFailures = input.consoleErrors.filter(isFailedResource);
  const consoleErrors = input.consoleErrors.filter(item => !isFailedResource(item));

  const failures: string[] = [];
  if (input.documentStatus !== null && input.documentStatus >= 400) failures.push("страница ответила HTTP " + input.documentStatus);
  if (input.blank) failures.push("страница пустая: ни текста, ни видимых элементов — приложение ничего не отрисовало");
  if (input.pageErrors.length) failures.push("ошибки страницы (" + input.pageErrors.length + "): " + input.pageErrors[0]);
  if (consoleErrors.length) failures.push("ошибки консоли (" + consoleErrors.length + "): " + consoleErrors[0].text);
  if (broken.length) failures.push("запросы не дошли (" + broken.length + "): " + broken[0].error + " " + broken[0].url);
  if (serverErrors.length) failures.push("ответы сервера 5xx (" + serverErrors.length + "): " + serverErrors.slice(0, 3).map(item => item.status + " " + item.url).join(", "));

  const background = [
    ...backgroundHttp.map(item => "HTTP " + item.status + " " + item.url),
    ...resourceFailures.map(item => item.text + (item.url ? " — " + item.url : "")),
    ...aborted.map(item => "отменён запрос " + item.url),
  ];
  return { ok: failures.length === 0, failures, background };
}

/** «Failed to load resource: the server responded with a status of 401» — это загрузка с 4xx. */
function isFailedResource(item: ConsoleMessage) {
  const match = /status of (\d{3})/.exec(item.text);
  if (!match) return false;
  const status = Number(match[1]);
  return status >= 400 && status < 500;
}

/** Короткий хвост ответа для сообщения о поломке: модели нужен адрес, а не весь список. */
function briefList(values: string[], limit = 3) {
  return values.slice(0, limit).join("; ") + (values.length > limit ? " …" : "");
}

async function inspectRuntimePage(projectId: string, path: string) {
  const status = await previewStatus(projectId);
  if (!status.running) {
    throw new Error(String((status as { error?: string }).error ?? "Preview is not running"));
  }
  const current = getPreview(projectId);
  if (!current) throw new Error("Состояние предпросмотра недоступно — предпросмотр не запущен");

  const url = `http://${current.host}:${current.port}${path}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.WEBNESTDEV_BROWSER_EXECUTABLE || undefined });
  const consoleMessages: Array<ConsoleMessage & { type: string }> = [];
  const failedRequests: Array<{ url: string; method: string; error: string }> = [];
  const httpErrors: Array<{ url: string; method: string; status: number }> = [];
  const pageErrors: string[] = [];

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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

    const consoleErrors = consoleMessages.filter(item => item.type === "error").map(item => ({ text: item.text, url: item.url ?? "" }));
    const judged = classifyRuntimeFailures({
      pageErrors,
      consoleErrors,
      failedRequests,
      httpErrors,
      documentStatus: response?.status() ?? null,
      blank: rendered.blank,
    });
    return {
      ok: judged.ok,
      status: response?.status() ?? null,
      statusText: response?.statusText() ?? null,
      url,
      title: rendered.title,
      /** Что видно на странице — по этому и судят о белом экране, а не по скриншоту в base64. */
      rendered,
      console: consoleMessages,
      failedRequests,
      httpErrors,
      pageErrors,
      background: judged.background,
      htmlBytes: Buffer.byteLength(html, "utf8"),
      failures: judged.failures,
      diagnostic: judged.ok
        ? "Рендеринг прошел: страница отрисовала содержимое, ошибок страницы, консоли и сети нет."
        : "Проверка рендеринга не прошла: " + briefList(judged.failures) +
          (judged.background.length ? " Фоновые ответы (" + briefList(judged.background) + ") — не поломка: страница без авторизации отвечает 401, и чинить их не нужно." : ""),
      nextAction: judged.ok
        ? "Runtime verification passed."
        : rendered.blank
          ? "Страница пустая: приложение ничего не отрисовало. Проверьте точку входа (монтирование в #root или #app), стартовый маршрут и состояние загрузки до ответа авторизации: экран не должен оставаться пустым, пока запросы сессии не ответили."
          : "Исправьте то, что перечислено в failures, и запустите browser.runtime снова.",
    };
  } finally {
    await browser.close();
  }
}

import type { QaScenarioStep as BrowserScenarioStep } from "../qa/scenario-planner.js";

const MAX_SCENARIO_STEPS = 20;

async function runBrowserScenario(projectId: string, input: unknown) {
  const value = (input && typeof input === "object" ? input : {}) as {
    path?: unknown;
    steps?: unknown;
  };
  const initialPath = typeof value.path === "string" ? getPath({ path: value.path }) : "/";
  const steps = Array.isArray(value.steps) ? value.steps.slice(0, MAX_SCENARIO_STEPS) as BrowserScenarioStep[] : [];
  if (!steps.length) return { ok: false, error: "Нужен хотя бы один шаг сценария." };

  const status = await previewStatus(projectId);
  if (!status.running) throw new Error(String((status as { error?: string }).error ?? "Preview is not running"));
  const current = getPreview(projectId);
  if (!current) throw new Error("Состояние предпросмотра недоступно — предпросмотр не запущен");

  const browser = await chromium.launch({ headless: true, executablePath: process.env.WEBNESTDEV_BROWSER_EXECUTABLE || undefined });
  const consoleErrors: ConsoleMessage[] = [];
  const pageErrors: string[] = [];
  const failedRequests: Array<{ url: string; error: string }> = [];
  const httpErrors: Array<{ url: string; status: number }> = [];
  const results: Array<{ step: number; action: string; ok: boolean; detail?: string }> = [];

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("console", message => { if (message.type() === "error" && consoleErrors.length < 50) consoleErrors.push({ text: message.text().slice(0, 2000), url: message.location()?.url ?? "" }); });
    page.on("pageerror", error => { if (pageErrors.length < 50) pageErrors.push(error.message.slice(0, 2000)); });
    page.on("response", response => { if (response.status() >= 400 && httpErrors.length < 50) httpErrors.push({ url: response.url().slice(0, 2000), status: response.status() }); });
    page.on("requestfailed", request => { if (failedRequests.length < 50) failedRequests.push({ url: request.url().slice(0, 2000), error: request.failure()?.errorText ?? "request failed" }); });

    const startResponse = await loadAndSettle(page, `http://${current.host}:${current.port}${initialPath}`);
    let documentStatus: number | null = startResponse?.status() ?? null;

    for (let index = 0; index < steps.length; index++) {
      const step = steps[index];
      try {
        switch (step.action) {
          case "goto": {
            const response = await loadAndSettle(page, `http://${current.host}:${current.port}${getPath({ path: step.path })}`);
            documentStatus = response?.status() ?? null;
            break;
          }
          case "click": {
            const target = page.locator(step.selector).first();
            await target.waitFor({ state: "visible", timeout: 5000 });
            if (!(await target.isEnabled())) {
              throw new Error(`Element is visible but disabled: ${step.selector}`);
            }
            await target.click({ timeout: 5000 });
            await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
            break;
          }
          case "fill":
            await page.locator(step.selector).first().fill(step.value, { timeout: 5000 });
            break;
          case "press":
            await page.locator(step.selector).first().press(step.key, { timeout: 5000 });
            await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
            break;
          case "expectText":
            await page.getByText(step.text, { exact: false }).first().waitFor({ state: "visible", timeout: 5000 });
            break;
          case "expectUrl": {
            const matched = new RegExp(step.pattern).test(page.url());
            if (!matched) throw new Error(`URL did not match /${step.pattern}/: ${page.url()}`);
            break;
          }
          case "expectVisible":
            await page.locator(step.selector).first().waitFor({ state: "visible", timeout: 5000 });
            break;
          case "expectNotVisible":
            await page.locator(step.selector).first().waitFor({ state: "hidden", timeout: 5000 });
            break;
          default:
            throw new Error(`Unsupported scenario action: ${(step as { action?: string }).action ?? "unknown"}`);
        }
        results.push({ step: index + 1, action: step.action, ok: true });
      } catch (error) {
        results.push({ step: index + 1, action: step.action, ok: false, detail: error instanceof Error ? error.message : String(error) });
        break;
      }
    }

    const rendered = await readPageEvidence(page);
    const stepsPassed = results.length === steps.length && results.every(item => item.ok);
    const judged = classifyRuntimeFailures({ pageErrors, consoleErrors, failedRequests, httpErrors, documentStatus, blank: rendered.blank });
    const ok = stepsPassed && judged.ok;
    const failedStep = results.find(item => !item.ok);
    return {
      ok,
      initialPath,
      steps: results,
      finalUrl: page.url(),
      documentStatus,
      /** Что отрисовано на последнем экране сценария — единственное доказательство белого экрана. */
      rendered,
      consoleErrors,
      pageErrors,
      failedRequests,
      httpErrors,
      background: judged.background,
      failures: judged.failures,
      diagnostic: ok
        ? "Сценарий прошёл: шаги выполнились, страница отрисовала содержимое, ошибок страницы, консоли и сети нет."
        : (!stepsPassed ? "Сценарий остановлен на шаге " + failedStep?.step + " (" + failedStep?.action + "): " + (failedStep?.detail ?? "шаг не выполнился") + ". " : "") +
          (judged.failures.length ? "Поломки: " + briefList(judged.failures) + ". " : "") +
          (judged.background.length ? "Фон, который чинить не нужно: " + briefList(judged.background) + "." : ""),
      nextAction: ok
        ? "Browser QA passed."
        : rendered.blank
          ? "Страница пустая: приложение ничего не отрисовало (0 видимых элементов и 0 символов текста). Проверьте точку входа (монтирование в #root или #app), стартовый маршрут и состояние загрузки до ответа авторизации — экран не должен оставаться пустым, пока запросы сессии не ответили."
          : !stepsPassed
            ? "Исправьте то, на чём остановился шаг (selector/text выше), и запустите сценарий снова. Фоновые 4xx и отменённые запросы чинить не нужно."
            : "Исправьте перечисленное в failures, затем запустите сценарий снова.",
    };
  } finally {
    await browser.close();
  }
}

registerTool({
  name: "browser.scenario",
  description: "Run a real Chromium user-flow scenario against Preview. Input: {path?:string,steps:[{action:'goto',path}|{action:'click',selector}|{action:'fill',selector,value}|{action:'press',selector,key}|{action:'expectText',text}|{action:'expectUrl',pattern}|{action:'expectVisible',selector}|{action:'expectNotVisible',selector}]}. Maximum 20 steps. Supports visibility assertions, stops on the first failed step, and reports what the page rendered (visible text, blank screen), console/page errors, HTTP 5xx and failed requests; 4xx from the app's own API and aborted requests come back as `background`, not as failures.",
  parameters: {
    type: "object",
    required: ["steps"],
    properties: {
      path: { type: "string", description: "Маршрут предпросмотра, с которого начинается сценарий; по умолчанию /" },
      steps: {
        type: "array",
        maxItems: 20,
        description: "Шаги сценария по порядку; выполнение останавливается на первом неудачном",
        items: {
          type: "object",
          required: ["action"],
          properties: {
            action: { type: "string", enum: ["goto", "click", "fill", "press", "expectText", "expectUrl", "expectVisible", "expectNotVisible"] },
            path: { type: "string", description: "Для action=goto" },
            selector: { type: "string", description: "CSS-селектор для click/fill/press/expectVisible/expectNotVisible" },
            value: { type: "string", description: "Значение для action=fill" },
            key: { type: "string", description: "Клавиша для action=press, например Enter" },
            text: { type: "string", description: "Ожидаемый текст для action=expectText" },
            pattern: { type: "string", description: "Регулярное выражение URL для action=expectUrl" },
          },
        },
      },
    },
  },
  // Chromium is launched inside the server container without a memory limit, so only a
  // configured number of checks may run at once; withBrowserSlot holds that place.
  execute: async (input, context) => withBrowserSlot(() => runBrowserScenario(context.projectId, input)),
});

registerTool({
  name: "browser.runtime",
  description:
    "Open the Preview in a real headless Chromium browser, execute client-side JavaScript, and report what the page actually rendered (visible text, its size, blank screen), plus console errors, failed network requests, HTTP 5xx and the document status. Background 4xx from the app's own API calls and aborted requests are listed separately as `background` and are not failures. Use this after browser.open or project.verify when runtime behavior matters.",
  parameters: { type: "object", additionalProperties: false, properties: { path: { type: "string", description: "Маршрут предпросмотра, например / или /about; по умолчанию /" } } },
  execute: async (input, context) => withBrowserSlot(() => inspectRuntimePage(context.projectId, getPath(input))),
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
