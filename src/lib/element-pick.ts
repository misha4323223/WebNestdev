/**
 * Элемент, выбранный мышью в кадре предпросмотра.
 *
 * Из кадра нельзя отдать агенту сам DOM: он живёт в другом документе и перезагружается при
 * каждой правке. Поэтому выбор превращается в короткое описание — селектор, разметка и текущие
 * стили. Этого достаточно, чтобы агент нашёл тот же элемент в исходниках и не перепутал его с
 * соседним: селектор собран от ближайшего предка, а не «первый div на странице».
 */
export type PickedElement = {
  /** Имя тега с классом — по нему человек узнаёт элемент в карточке. */
  label: string;
  /** Путь от ближайшего предка: `section.hero > h1.hero-title`. */
  selector: string;
  /** Первые слова текста элемента: по ним видно, что выбрано. */
  text: string;
  /** Начало outerHTML — агент видит реальные атрибуты, а не догадку. */
  html: string;
  /** Краткая сводка вычисленных стилей: цвет, фон, шрифт, радиус, размер. */
  styles: string;
};

/** Глубже пяти предков селектор всё равно не нужен: он выбирает один элемент, а не страницу. */
const MAX_SELECTOR_DEPTH = 5;
const MAX_TEXT = 70;
const MAX_HTML = 240;

/** `CSS.escape` есть во всех современных браузерах, но селектор не должен падать без него. */
function escapeIdent(value: string) {
  const api = (globalThis as { CSS?: { escape?: (text: string) => string } }).CSS;
  if (api && typeof api.escape === "function") return api.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

/** Класс служебной подсветки: в селектор он попадать не должен. */
const INTERNAL_CLASS = "__nest-pick";

export function elementSelector(element: Element, depth = MAX_SELECTOR_DEPTH) {
  const parts: string[] = [];
  let node: Element | null = element;
  while (node && parts.length < depth) {
    const tag = node.tagName.toLowerCase();
    if (tag === "html" || tag === "body") break;
    let part = tag;
    // id — самый точный якорь; если его нет, хватает первого «смыслового» класса.
    if (node.id) part += "#" + escapeIdent(node.id);
    else {
      const className = Array.from(node.classList).find(name => name && !name.startsWith(INTERNAL_CLASS));
      if (className) part += "." + escapeIdent(className);
    }
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(" > ") || element.tagName.toLowerCase();
}

function collapse(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

/** Вычисленные стили важнее классов: агент видит, как элемент выглядит на самом деле. */
function styleSummary(element: Element) {
  const box = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const parts: string[] = [];
  if (style.color) parts.push("цвет " + style.color);
  if (style.backgroundColor && style.backgroundColor !== "rgba(0, 0, 0, 0)") parts.push("фон " + style.backgroundColor);
  const family = style.fontFamily.split(",")[0]?.replace(/["']/g, "").trim();
  if (family) parts.push("шрифт " + style.fontSize + " " + family);
  if (style.borderRadius && style.borderRadius !== "0px") parts.push("радиус " + style.borderRadius);
  if (box.width && box.height) parts.push("размер " + Math.round(box.width) + "×" + Math.round(box.height));
  return parts.join(", ");
}

export function describeElement(element: Element): PickedElement {
  const tag = element.tagName.toLowerCase();
  const className = Array.from(element.classList).find(name => name && !name.startsWith(INTERNAL_CLASS));
  const text = collapse(element.textContent ?? "").slice(0, MAX_TEXT);
  const html = collapse(element.outerHTML).slice(0, MAX_HTML);
  return {
    label: tag + (className ? "." + className : "") + (text ? " «" + text + "»" : ""),
    selector: elementSelector(element),
    text,
    html,
    styles: styleSummary(element),
  };
}

/**
 * Текст для поля ввода агента. Он заканчивается на «Что сделать:», чтобы человек дописал
 * просьбу своими словами, а не отправлял описание элемента как задачу.
 */
export function elementPickPrompt(picked: PickedElement) {
  const lines = [
    "Элемент из предпросмотра: " + picked.label,
    "Селектор: " + picked.selector,
    "HTML: " + picked.html,
  ];
  if (picked.styles) lines.push("Сейчас: " + picked.styles);
  lines.push("", "Что сделать: ");
  return lines.join("\n");
}
