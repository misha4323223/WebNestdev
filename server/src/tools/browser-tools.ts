import { getPreview } from "../preview/preview-store.js";
import { previewStatus } from "../preview-manager.js";
import { previewProxyBase } from "../preview/preview-rewrite.js";
import { createSession, deleteSession } from "../auth/auth-store.js";
import { SESSION_COOKIE } from "../auth/auth.js";
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


import { chromium,type Browser,type Page } from "playwright";

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

/**
 * Применились ли стили. Без этого «белая страница» остаётся загадкой: DOM полон элементов, текст на
 * месте, а пользователь видит неоформленный экран — и модель ходит по файлам наугад, потому что в
 * отчёте проверки не было ни одного признака внешнего вида.
 */
export type PageStyleFacts = {
  /** Объявленные в разметке таблицы стилей (`<link rel="stylesheet">`). */
  declaredStylesheets: number;
  /**
   * Сколько ссылок браузер не отверг (`sheet` не null). Это ещё не признак применения: Chrome
   * оставляет пустую таблицу и для ответа 404, поэтому о применении судят по правилам, а это число —
   * только улика рядом с ними.
   */
  loadedStylesheets: number;
  /** `<style>`, вставленные скриптом: так Vite отдаёт CSS, импортированный из JS. */
  inlineStyles: number;
  /** Действующих правил CSS: ноль при объявленных стилях означает «стили не применились». */
  cssRules: number;
  /** Фон и цвет текста так, как их видит браузер: белое поле с чёрным текстом — вид белой страницы. */
  bodyBackground: string;
  bodyColor: string;
  /** Объявленные стили не действуют: страница неоформленная, то есть выглядит белой. */
  unstyled: boolean;
  /**
   * Ни одного правила CSS на странице. Это не поломка сама по себе (проект может быть без стилей),
   * но вместе с белым экраном это первое, что нужно проверить: подключён ли CSS вообще.
   */
  noStyles: boolean;
};

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
  /** Вид страницы: объявленные и действующие стили. */
  styles: PageStyleFacts;
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
    const links = Array.from(document.querySelectorAll('link[rel~="stylesheet"][href]')) as HTMLLinkElement[];
    let cssRules = 0;
    let sheetsWithRules = 0;
    let unreadableSheets = 0;
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        const rules = sheet.cssRules.length;
        cssRules += rules;
        if (rules > 0) sheetsWithRules++;
      } catch {
        // Таблица из другого источника: правила прочитать нельзя, значит о применении судить не по ней.
        unreadableSheets++;
      }
    }
    const declaredStylesheets = links.length;
    const loadedStylesheets = links.filter(link => link.sheet !== null).length;
    const inlineStyles = document.querySelectorAll("style").length;
    // Всё, что вообще объявляет стили: ссылка в разметке или таблица, добавленная скриптом.
    const declared = declaredStylesheets + inlineStyles;
    const bodyStyle = body ? getComputedStyle(body) : null;
    return {
      title: document.title,
      text,
      textChars: text.length,
      visibleElements,
      styles: {
        declaredStylesheets,
        loadedStylesheets,
        inlineStyles,
        cssRules,
        bodyBackground: bodyStyle?.backgroundColor ?? "",
        bodyColor: bodyStyle?.color ?? "",
        // Стили объявлены (ссылкой или скриптом), а ни одного действующего правила нет: страница
        // неоформленная. Одной ссылки для вывода мало — Chrome оставляет пустую таблицу даже там,
        // где ответил 404, — поэтому решают именно правила. Если прочитать их не удалось ни у одной
        // таблицы (чужие источники), о применении стилей не судим.
        // Случай «стилей нет вовсе» сюда не входит: так выглядит и проект, которому стили не нужны,
        // поэтому он называется отдельно (noStyles) и не превращается в провал проверки.
        unstyled: declared > 0 && sheetsWithRules === 0 && unreadableSheets === 0,
        noStyles: declared === 0,
      },
    };
  });
  return {
    title: raw.title,
    text: raw.text.slice(0, MAX_EVIDENCE_TEXT),
    textChars: raw.textChars,
    visibleElements: raw.visibleElements,
    blank: raw.textChars === 0 && raw.visibleElements === 0,
    styles: raw.styles,
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
  /** Вид страницы; без него проверка судит только о наличии текста и не видит неоформленный экран. */
  styles?: PageStyleFacts;
};

/**
 * Расширения стилей и скриптов: их отсутствие оставляет белый экран (нет вида или логики), а не фон.
 * `favicon.ico` и картинки сюда не входят: браузер спрашивает их сам, и их 404 ничего не ломает.
 */
const CODE_ASSET_EXTENSIONS = /\.(css|js|mjs|cjs|jsx|tsx|ts)$/i;

function isCodeAsset(url: string) {
  return CODE_ASSET_EXTENSIONS.test(url.split(/[?#]/)[0]);
}

/**
 * Что считать поломкой, а что — фоном.
 *
 * Фон — это 4xx от собственных запросов приложения и отменённые запросы; страница без авторизации
 * обязана отвечать 401, а переход отменяет ещё летящие запросы, и требование «ноль таких ответов»
 * делало проверку непроходимой навсегда: агент бесконечно «чинил» работающее приложение.
 * Тот же 401 приходит второй раз — как ошибка консоли «Failed to load resource: … status of 401»,
 * поэтому сообщения этого вида с ответом 4xx относятся к фону, а не к ошибкам приложения.
 *
 * Поломка — то, что видит пользователь: пустой экран, неоформленная страница (стили объявлены, но
 * ни одно правило не действует), ошибки страницы и консоли, недошедшие запросы, 5xx, несуществующий
 * маршрут и путь к стилю или скрипту, который не отдался. Это и делает проверку строже прежней:
 * `expectVisible body` виден и на белой странице, а DOM с текстом был и когда стили не применились.
 */
export function classifyRuntimeFailures(input: RuntimeFailureInput) {
  const aborted = input.failedRequests.filter(item => /ERR_ABORTED|NS_BINDING_ABORTED/i.test(item.error));
  const broken = input.failedRequests.filter(item => !/ERR_ABORTED|NS_BINDING_ABORTED/i.test(item.error));
  const serverErrors = input.httpErrors.filter(item => item.status >= 500);
  const backgroundHttp = input.httpErrors.filter(item => item.status < 500);
  // Стиль или скрипт, который не отдался, — это белая и нерабочая страница, а не фон: браузер без
  // него не применяет ни вида, ни логики. Всё остальное 4xx от своего же API — фон.
  const missingAssets = backgroundHttp.filter(item => isCodeAsset(item.url));
  const backgroundOnly = backgroundHttp.filter(item => !isCodeAsset(item.url));
  // Браузер пишет загрузку с 4xx в консоль как ошибку; это тот же фон, а не ошибка приложения.
  const resourceFailures = input.consoleErrors.filter(isFailedResource);
  const assetRefusals = resourceFailures.filter(item => isCodeAsset(item.url ?? ""));
  const consoleErrors = input.consoleErrors.filter(item => !isFailedResource(item));

  const failures: string[] = [];
  if (input.documentStatus !== null && input.documentStatus >= 400) failures.push("страница ответила HTTP " + input.documentStatus);
  if (input.blank) failures.push("страница пустая: ни текста, ни видимых элементов — приложение ничего не отрисовало");
  if (input.pageErrors.length) failures.push("ошибки страницы (" + input.pageErrors.length + "): " + input.pageErrors[0]);
  if (consoleErrors.length) failures.push("ошибки консоли (" + consoleErrors.length + "): " + consoleErrors[0].text);
  if (broken.length) failures.push("запросы не дошли (" + broken.length + "): " + broken[0].error + " " + broken[0].url);
  if (serverErrors.length) failures.push("ответы сервера 5xx (" + serverErrors.length + "): " + serverErrors.slice(0, 3).map(item => item.status + " " + item.url).join(", "));
  if (missingAssets.length) failures.push("файлы стилей или скриптов не отдались (" + missingAssets.length + "): " + missingAssets.slice(0, 3).map(item => item.status + " " + item.url).join(", ") + " — без них страница остаётся белой");
  if (assetRefusals.length) failures.push("браузер отказался применить стиль или скрипт: " + assetRefusals[0].text + (assetRefusals[0].url ? " — " + assetRefusals[0].url : ""));
  // Неоформленная страница с текстом раньше проходила проверку: текст есть, значит «не пусто».
  if (input.styles?.unstyled) {
    const facts = input.styles;
    failures.push(
      "стили не применились: объявлено таблиц " + facts.declaredStylesheets + ", из них загрузилось " + facts.loadedStylesheets +
      ", встроенных <style> " + facts.inlineStyles + ", действующих правил CSS " + facts.cssRules +
      ", фон " + facts.bodyBackground + ", цвет текста " + facts.bodyColor +
      " — страница неоформленная и выглядит белой, хотя элементы на ней есть",
    );
  }

  const background = [
    ...backgroundOnly.map(item => "HTTP " + item.status + " " + item.url),
    ...resourceFailures.filter(item => !assetRefusals.includes(item)).map(item => item.text + (item.url ? " — " + item.url : "")),
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
};

/**
 * Одна дверь к приложению: адрес контейнера и адрес прокси платформы — два разных пути к одному
 * проекту. Кука нужна только второй двери: прокси пускает лишь владельца проекта.
 */
async function loadDoor(browser: Browser, url: string, cookie?: { name: string; value: string }): Promise<DoorEvidence> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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
export async function inspectPreviewThroughPanelProxy(input: { projectId: string; path: string; selfBase: string; cookie: { name: string; value: string } }): Promise<ProxyDoorResult> {
  const url = input.selfBase.replace(/\/+$/, "") + previewProxyBase(input.projectId) + input.path.replace(/^\/+/, "");
  try {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.WEBNESTDEV_BROWSER_EXECUTABLE || undefined });
    try {
      const door = await loadDoor(browser, url, input.cookie);
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
async function inspectProxyDoor(input: { projectId: string; path: string; userId?: string }): Promise<ProxyDoorResult> {
  const selfBase = process.env.WEBNESTDEV_SELF_URL?.trim() || "http://127.0.0.1:" + (process.env.PORT?.trim() || "8787");
  if (!input.userId) return { checked: false, url: selfBase + previewProxyBase(input.projectId), reason: "неизвестен владелец проекта" };
  let sessionId = "";
  try {
    const session = await createSession(input.userId);
    sessionId = session.id;
    return await inspectPreviewThroughPanelProxy({ projectId: input.projectId, path: input.path, selfBase, cookie: { name: SESSION_COOKIE, value: session.id } });
  } catch (error) {
    return { checked: false, url: selfBase + previewProxyBase(input.projectId), reason: error instanceof Error ? error.message : String(error) };
  } finally {
    // Кука нужна только на время проверки: сессия не должна её пережить.
    if (sessionId) await deleteSession(sessionId).catch(() => undefined);
  }
}

async function inspectRuntimePage(projectId: string, path: string, userId?: string) {
  const status = await previewStatus(projectId);
  if (!status.running) {
    throw new Error(String((status as { error?: string }).error ?? "Preview is not running"));
  }
  const current = getPreview(projectId);
  if (!current) throw new Error("Состояние предпросмотра недоступно — предпросмотр не запущен");

  const browser = await chromium.launch({ headless: true, executablePath: process.env.WEBNESTDEV_BROWSER_EXECUTABLE || undefined });
  let door: DoorEvidence;
  try {
    door = await loadDoor(browser, `http://${current.host}:${current.port}${path}`);
  } finally {
    await browser.close();
  }
  const panel = await inspectProxyDoor({ projectId, path, userId });
  const failures = [...door.failures, ...(panel.failures ?? []).map(item => "через прокси панели: " + item)];
  const rendered = door.rendered;
  const ok = failures.length === 0;
  const sameBothWays = panel.checked && door.failures.length === 0 && (panel.failures?.length ?? 0) > 0;
  return {
    ok,
    status: door.status,
    statusText: door.statusText,
    url: door.url,
    title: rendered.title,
    /** Что видно на странице — по этому и судят о белом экране, а не по скриншоту в base64. */
    rendered,
    console: door.console,
    failedRequests: door.failedRequests,
    httpErrors: door.httpErrors,
    pageErrors: door.pageErrors,
    background: door.background,
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
    const judged = classifyRuntimeFailures({ pageErrors, consoleErrors, failedRequests, httpErrors, documentStatus, blank: rendered.blank, styles: rendered.styles });
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
    "Open the Preview in a real headless Chromium browser, execute client-side JavaScript, and report what the page actually rendered: visible text, its size, blank screen, and whether styles applied (declared vs loaded stylesheets, CSS rules in effect, body background/color, `unstyled`). Console errors, failed network requests, HTTP 5xx and the document status come with it. Both doors are checked and returned: `url`/`rendered` is the container address the app itself answers on, `panelDoor` is the same page loaded through the platform's own preview proxy — the door the panel's iframe uses, so a page that only breaks for the user is reported too. Background 4xx from the app's own API calls and aborted requests are listed separately as `background` and are not failures; a 4xx for a .css or .js file is a failure, because without it the page is white. Use this after browser.open or project.verify when runtime behavior matters.",
  parameters: { type: "object", additionalProperties: false, properties: { path: { type: "string", description: "Маршрут предпросмотра, например / или /about; по умолчанию /" } } },
  execute: async (input, context) => withBrowserSlot(() => inspectRuntimePage(context.projectId, getPath(input), context.userId)),
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
