/**
 * Hidden graders for tasks whose fixture has no test suite of its own.
 *
 * They are written into the project only after the agent has finished, run once, and removed with
 * the project. That timing matters: the model cannot read the grader while it works, so a passing
 * task means the requested result is in the files, not that the checker was reverse-engineered.
 *
 * A check is a Node script that runs with the project as its working directory and exits non-zero
 * with a readable reason. It uses only Node built-ins — the fixtures install nothing.
 */
export type EvalCheck = { script: string };

export const CHECK_FILE = ".eval-check.mjs";

const PRELUDE = `import { readFile, stat } from "node:fs/promises";
const fail = message => { console.error("CHECK FAIL: " + message); process.exit(1); };
const read = async file => {
  try { return await readFile(file, "utf8"); }
  catch { fail("нет файла " + file); }
};
`;

const SEO = `${PRELUDE}
for (const page of ["index.html", "services.html"]) {
  const html = await read(page);
  if (!/<html[^>]*\\blang="[a-z-]+"/i.test(html)) fail(page + ": у <html> нет lang");
  const title = /<title>([\\s\\S]*?)<\\/title>/i.exec(html);
  if (!title || title[1].trim().length < 10) fail(page + ": нет содержательного title");
  if (!/<meta[^>]+name="description"[^>]+content="[^"]{20,}"/i.test(html)) fail(page + ": нет meta description");
  if (!/<meta[^>]+property="og:title"[^>]+content="[^"]+"/i.test(html)) fail(page + ": нет og:title");
  if (!/<meta[^>]+property="og:description"[^>]+content="[^"]{10,}"/i.test(html)) fail(page + ": нет og:description");
  // Домен в фикстуре не задан (siteUrl пустой), поэтому абсолютный canonical требовать нельзя:
  // относительный href="/" — валидная разметка и резолвится от адреса страницы.
  if (!/<link[^>]+rel="canonical"[^>]+href="(?:https?:\\/\\/[^"]+|\\/[^"]*)"/i.test(html)) fail(page + ": нет canonical");
}
console.log("CHECK OK: SEO-метаданные на обеих страницах");
`;

const CONTACT = `${PRELUDE}
const html = await read("index.html");
const css = await read("styles.css");
// Форма может быть в разметке или собираться скриптом: проверяем оба источника.
const script = await readFile("app.js", "utf8").catch(() => "");
const page = html + "\\n" + script;
if (!/(id|class)=["'][^"']*contact/i.test(html) && !/контакт/i.test(html)) fail("нет секции контактов");
if (!/<form[\\s>]/i.test(page)) fail("в контактах нет формы");
// Задача просит форму, а не конкретный набор полей: принимаем любое поле ввода и кнопку отправки.
if (!/<(input|textarea)\\b/i.test(page)) fail("в форме нет ни одного поля ввода");
if (!/<(button|input)[^>]*(submit|Отправить)/i.test(page)) fail("у формы нет кнопки отправки");
if (!/(vk\\.com|t\\.me|telegram|wa\\.me|whatsapp)/i.test(page)) fail("нет ссылок на соцсети");
if (!/@media\\s*\\(/i.test(css)) fail("нет адаптивных стилей (@media)");
console.log("CHECK OK: секция контактов с формой и соцсетями");
`;

const NAV = `${PRELUDE}
const html = await read("index.html");
const css = await read("styles.css");
const js = await read("app.js");
const toggle = /<button[^>]*(aria-expanded|aria-controls|aria-label="[^"]*[Мм]еню)/i.test(html)
  || /<button[^>]*class="[^"]*(burger|toggle|menu)/i.test(html)
  || /<details[\\s>]/i.test(html);
if (!toggle) fail("нет кнопки/переключателя мобильного меню с доступным именем");
if (!/(classList\\.(toggle|add|remove)|<details)/i.test(js) && !/<details[\\s>]/i.test(html)) {
  fail("меню не открывается и не закрывается");
}
if (!/@media\\s*\\([^)]*max-width/i.test(css)) fail("нет медиазапроса для узких экранов");
if (!/\\.nav[^{]*\\{[^}]*(flex-direction|position|display)/i.test(css)) fail("стили навигации не меняются на телефоне");
console.log("CHECK OK: мобильная навигация");
`;

const PRICING = `${PRELUDE}
const html = await read("index.html");
const css = await read("styles.css");
const cards = html.match(/class=["'][^"']*(card|plan|tier|tariff)[^"']*["']/gi) ?? [];
if (cards.length < 3) fail("ожидаются три карточки тарифов, найдено " + cards.length);
if (!/(featured|popular|highlight|recommended|accent)/i.test(html)) fail("средний тариф не выделен");
if (!/(display:\\s*grid|display:\\s*flex)/i.test(css)) fail("тарифы не свёрстаны сеткой");
if (!/@media\\s*\\(/i.test(css)) fail("нет адаптивной сетки");
console.log("CHECK OK: блок тарифов");
`;

const CTA = `${PRELUDE}
const html = await read("index.html");
const js = await read("app.js");
const ids = new Set([...html.matchAll(/id=["']([^"']+)["']/g)].map(match => match[1]));
const referenced = [...js.matchAll(/getElementById\\("([^"]+)"\\)/g)].map(match => match[1]);
if (!referenced.length) fail("скрипт не находит кнопку по id");
for (const id of referenced) {
  if (!ids.has(id)) fail('getElementById("' + id + '") ищет элемент, которого нет в разметке');
}
if (!/addEventListener\\("click"/i.test(js)) fail("на кнопку не назначен обработчик клика");
console.log("CHECK OK: кнопка заявки связана с существующим элементом");
`;

const ASSETS = `${PRELUDE}
const html = await read("index.html");
const images = [...html.matchAll(/<img\\b[^>]*>/gi)].map(match => match[0]);
if (images.length < 3) fail("ожидаются три изображения в секции работ, найдено " + images.length);
for (const tag of images) {
  const src = /src=["']([^"']+)["']/i.exec(tag);
  const alt = /alt=["']([^"']*)["']/i.exec(tag);
  if (!src) fail("у изображения нет src: " + tag);
  if (!alt || !alt[1].trim()) fail("у изображения " + src[1] + " пустой alt");
  const file = src[1].replace(/^\\//, "").split("?")[0];
  if (/^data:/i.test(file)) fail("изображение встроено как data-URL вместо файла или ссылки");
  // Абсолютный адрес — нормальный способ починить картинку: платформа отдаёт загруженные файлы
  // со своего хранилища. Проверяем, что локальный путь не остался битым.
  if (!/^https?:/i.test(file)) {
    try { await stat(file); } catch { fail("файл изображения не найден: " + file); }
  }
}
console.log("CHECK OK: изображения и alt на месте");
`;

export const EVAL_CHECKS: Record<string, EvalCheck> = {
  "landing-seo-meta": { script: SEO },
  "landing-contact-section": { script: CONTACT },
  "landing-mobile-nav": { script: NAV },
  "landing-pricing": { script: PRICING },
  "landing-broken-cta": { script: CTA },
  "landing-image-assets": { script: ASSETS },
};
