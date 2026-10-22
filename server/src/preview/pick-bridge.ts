/**
 * Выбор элемента в предпросмотре на публичном адресе.
 *
 * В панели кадр по пути `/api/projects/<id>/preview/open/` живёт на том же origin, и панель
 * читает его документ напрямую (см. `use-element-picker.ts`). Публичный адрес — чужой origin:
 * документ приложения панели недоступен, поэтому подсветку и клик выполняет маленький скрипт
 * внутри самого приложения. Он ничего не делает, пока панель не попросит, и отвечает только тому
 * окну, которое попросило.
 *
 * Скрипт отдаётся этим же слушателем (`PICK_BRIDGE_PATH`), а не инлайном: политика
 * содержимого приложения может запрещать инлайн-скрипты, а отдельный файл — обычный ресурс.
 */

/** Путь моста на публичном адресе предпросмотра. */
export const PICK_BRIDGE_PATH = "/__nest/pick.js";
/** Команда панели → приложение. */
export const PICK_COMMAND = "nest-pick-command";
/** Ответ приложения → панель: выбранный элемент или отмена. */
export const PICK_RESULT = "nest-picked";

/**
 * Скрипт внутри приложения. Намеренно без модулей и новых синтаксисов: он попадает в чужой
 * документ, собранный каким угодно сборщиком.
 *
 * Правила, которые здесь важны:
 * - слушать команды только от `window.parent` и отвечать только на origin, с которого пришла
 *   команда: чужое окно не может ни включить выбор, ни прочитать ответ;
 * - держать сообщение коротким (`label`, `selector`, `text`, `html`, `styles`) — это ровно то,
 *   что панель передаёт агенту;
 * - не полагаться на стили приложения: подсветка — свой класс и своё правило.
 */
export const PICK_BRIDGE_SCRIPT = String.raw`(function () {
  if (window.__nestPickBridge) return;
  window.__nestPickBridge = true;
  var parentOrigin = "";
  var hover = null;
  var style = null;
  function addStyle() {
    if (style) return;
    style = document.createElement("style");
    style.setAttribute("data-nest-pick", "");
    style.textContent = ".__nest-pick-hover{outline:2px solid #8fdcb0 !important;outline-offset:2px !important}." +
      "__nest-picking,.__nest-picking *{cursor:crosshair !important}";
    if (document.head) document.head.appendChild(style);
  }
  function clearHover() {
    if (hover) hover.classList.remove("__nest-pick-hover");
    hover = null;
  }
  function pickable(target) {
    if (!target || target.nodeType !== 1) return null;
    if (target === document.documentElement || target === document.body) return null;
    return target;
  }
  function collapse(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }
  function escapeIdent(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }
  function selectorFor(element) {
    var parts = [];
    var node = element;
    while (node && parts.length < 5) {
      var tag = node.tagName.toLowerCase();
      if (tag === "html" || tag === "body") break;
      var part = tag;
      if (node.id) part += "#" + escapeIdent(node.id);
      else {
        var name = null;
        for (var i = 0; i < node.classList.length; i++) {
          var candidate = node.classList[i];
          if (candidate && candidate.indexOf("__nest-pick") !== 0) { name = candidate; break; }
        }
        if (name) part += "." + escapeIdent(name);
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ") || element.tagName.toLowerCase();
  }
  function stylesFor(element) {
    var box = element.getBoundingClientRect();
    var computed = getComputedStyle(element);
    var parts = [];
    if (computed.color) parts.push("цвет " + computed.color);
    if (computed.backgroundColor && computed.backgroundColor !== "rgba(0, 0, 0, 0)") parts.push("фон " + computed.backgroundColor);
    var family = String(computed.fontFamily || "").split(",")[0].replace(/["']/g, "").trim();
    if (family) parts.push("шрифт " + computed.fontSize + " " + family);
    if (computed.borderRadius && computed.borderRadius !== "0px") parts.push("радиус " + computed.borderRadius);
    if (box.width && box.height) parts.push("размер " + Math.round(box.width) + "×" + Math.round(box.height));
    return parts.join(", ");
  }
  function describe(element) {
    var tag = element.tagName.toLowerCase();
    var name = null;
    for (var i = 0; i < element.classList.length; i++) {
      var candidate = element.classList[i];
      if (candidate && candidate.indexOf("__nest-pick") !== 0) { name = candidate; break; }
    }
    var text = collapse(element.textContent).slice(0, 70);
    return {
      label: tag + (name ? "." + name : "") + (text ? " «" + text + "»" : ""),
      selector: selectorFor(element),
      text: text,
      html: collapse(element.outerHTML).slice(0, 240),
      styles: stylesFor(element)
    };
  }
  function reply(message) {
    if (!parentOrigin) return;
    try {
      if (window.parent && window.parent !== window) window.parent.postMessage(message, parentOrigin);
    } catch (error) { /* окно закрылось — отвечать некому */ }
  }
  function onMove(event) {
    var element = pickable(event.target);
    if (!element || element === hover) return;
    clearHover();
    hover = element;
    element.classList.add("__nest-pick-hover");
  }
  function onClick(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    var element = pickable(event.target);
    // Класс подсветки снимается до описания: он служебный и в разметке/селекторе не нужен.
    clearHover();
    var payload = element ? describe(element) : null;
    stop();
    reply({ type: "__NEST_RESULT__", pick: payload });
  }
  function onKey(event) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    stop();
    reply({ type: "__NEST_RESULT__", cancelled: true });
  }
  function stop() {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    document.documentElement.classList.remove("__nest-picking");
    clearHover();
  }
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.type !== "__NEST_COMMAND__") return;
    if (window.parent === window || event.source !== window.parent) return;
    if (data.action === "start") {
      parentOrigin = event.origin;
      addStyle();
      document.documentElement.classList.add("__nest-picking");
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("click", onClick, true);
      document.addEventListener("keydown", onKey, true);
      return;
    }
    stop();
  });
})();`
  .replaceAll("__NEST_RESULT__", PICK_RESULT)
  .replaceAll("__NEST_COMMAND__", PICK_COMMAND);

/** Тег, который вставляется в документ приложения: скрипт грузится этим же адресом предпросмотра. */
export const PICK_BRIDGE_TAG = '<script src="' + PICK_BRIDGE_PATH + '" data-nest-pick-bridge defer></script>';

/**
 * Нужна ли вставка. Только для HTML и только когда тело не сжато: сжатый ответ пришлось бы
 * распаковывать и перепаковывать, а это уже другой уровень вмешательства в ответ приложения.
 */
export function canInjectPickBridge(contentType: string | null | undefined, contentEncoding: string | null | undefined): boolean {
  if (!(contentType ?? "").toLowerCase().includes("text/html")) return false;
  const encoding = (contentEncoding ?? "").trim().toLowerCase();
  return encoding === "" || encoding === "identity";
}

/**
 * Вставка моста в готовый HTML. Повторный вызов ничего не добавляет: страница, уже содержащая
 * тег, остаётся как есть (иначе каждое объединение фрагментов добавляло бы по тегу).
 */
export function injectPickBridge(html: string): string {
  if (html.includes(PICK_BRIDGE_PATH)) return html;
  const lower = html.toLowerCase();
  const at = lower.lastIndexOf("</body>");
  return at === -1 ? html + PICK_BRIDGE_TAG : html.slice(0, at) + PICK_BRIDGE_TAG + html.slice(at);
}

/** Ответ на запрос самого скрипта: файл маленький, поэтому кэшируется ненадолго и без валидаторов. */
export function pickBridgeResponse(): { headers: Record<string, string>; body: Buffer } {
  const body = Buffer.from(PICK_BRIDGE_SCRIPT, "utf8");
  return {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store",
      "content-length": String(body.length),
    },
    body,
  };
}
