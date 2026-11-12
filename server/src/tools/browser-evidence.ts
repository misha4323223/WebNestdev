import type { Page } from "playwright";

export const MAX_RUNTIME_MS = 20_000;
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
export async function readPageEvidence(page: Page): Promise<PageEvidence> {
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
export async function loadAndSettle(
  page: Page,
  url: string,
  options: { timeoutMs?: number; networkIdleMs?: number; settleMs?: number } = {},
) {
  // Один дедлайн на goto + networkidle + settle: иначе загрузка с опросом API могла занять
  // 20 секунд, а потом ещё столько же ждать «тишины» уже после истечения timeoutMs шага.
  const deadline = Date.now() + Math.max(1, options.timeoutMs ?? MAX_RUNTIME_MS);
  const remaining = () => Math.max(1, deadline - Date.now());
  const response = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: remaining(),
  });
  await page.waitForLoadState("networkidle", {
    timeout: Math.min(Math.max(1, options.networkIdleMs ?? NETWORK_IDLE_MS), remaining()),
  }).catch(() => undefined);
  await page.waitForTimeout(Math.min(Math.max(0, options.settleMs ?? SETTLE_MS), remaining()));
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
export function briefList(values: string[], limit = 3) {
  return values.slice(0, limit).join("; ") + (values.length > limit ? " …" : "");
}
