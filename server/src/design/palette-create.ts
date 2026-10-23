import path from "node:path";
import { readFileInside, writeFileInside } from "../sandbox/path-guard.js";
import { colorToHex, readPalette, scanProjectFiles, type ScannedFile } from "./palette.js";
import { tailwindColor } from "./tailwind-colors.js";
import { THEME_FIELDS, THEME_FILE } from "./theme.js";

/**
 * Создание палитры из цветов, вписанных в стили напрямую.
 *
 * Панель «Тема» правит переменные, а у проекта, собранного агентом до контракта, цвета стоят
 * литералами: палитре нечего показывать, и «нажимаю — ничего не происходит». Поэтому панель
 * сама собирает палитру из того, чем страница уже покрашена: считает частоту цветов по
 * свойствам (фон, текст, границы), пишет `theme.css` и заменяет ровно те литералы, которые
 * совпали со значениями токенов, на `var(--color-…)`.
 *
 * Что здесь важно:
 * - меняются только цвета в цветовых свойствах (`background*`, `color`, `border*`, `outline*`,
 *   `fill`, `stroke`), в inline-стилях (`style="…"` и `style={{ … }}`) и в утилитах Tailwind
 *   (`bg-slate-900`, `text-[#fff]`). Меняется сам цвет, а не строка целиком: остальной класс,
 *   объявление и код вокруг остаются как были;
 * - Tailwind-классы переписываются только в проекте, где Tailwind действительно подключён:
 *   иначе `bg-white` может быть своим классом из рукописного CSS;
 * - каждый переписанный файл получает подключение `theme.css` (CSS — `@import`, HTML — `<link>`,
 *   JSX/TSX — `import`), поэтому переменные определены и на отдельной странице, которая грузит
 *   этот файл без главного;
 * - комментарии и `url(...)` не трогаются: hex внутри data-URI — это не цвет проекта;
 * - значения пишутся через path-guard: они попадают в файлы, которые исполняет браузер.
 */

type Family = "background" | "text" | "border" | "other";

export type PalettePlan = {
  /** Шесть цветовых токенов контракта — ровно те, что показывает панель. */
  tokens: Record<string, string>;
  themeCss: string;
  /** Перезаписанные файлы проекта (содержимое целиком). */
  files: Array<{ file: string; content: string }>;
};

export type CreatePaletteResult = { created: boolean; reason?: string };

/** Объявление свойства внутри блока стилей; значение — всё до `;` или `}`. */
const DECLARATION = /([-\w]+)\s*:\s*([^;{}]+)/g;
/** Цветовой литерал: hex, rgb()/rgba() и hsl()/hsla() (непрозрачные разворачиваются в hex). */
const COLOR = /#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?)\([^)]*\)/g;
/** Блок `<style>` в разметке: только его содержимое и переписывается. */
const STYLE_BLOCK = /<style[^>]*>([\s\S]*?)<\/style>/gi;
/** Файлы разметки, где цвета живут в классах и inline-стилях. */
const MARKUP_FILE = /\.(html?|htm|jsx|tsx)$/i;
/** `style="…"` в разметке и в JSX: тот же список объявлений, что и в CSS. */
const STYLE_ATTRIBUTE = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** `style={{ … }}`: в JSX стили заданы объектом, ключи — CSS-свойства в camelCase. */
const STYLE_OBJECT = /\bstyle\s*=\s*\{\{([\s\S]*?)\}\}/g;
/** Пара `ключ: "значение"` внутри объекта стилей. */
const OBJECT_ENTRY = /([A-Za-z_$][\w$]*)\s*:\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g;
/** `class="…"`, `className="…"` и шаблон в фигурных скобках. */
const CLASS_ATTRIBUTE = /\bclass(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g;
/** Утилита Tailwind, которая красит: `bg-slate-900`, `text-[#fff]`, `border-white`. */
const COLOR_UTILITY = /^(bg|text|border(?:-[trblxyse])?|ring(?:-\d+)?|outline(?:-\d+)?|divide(?:-[xy])?|fill|stroke|decoration|placeholder)-(.+)$/;

type Literal = {
  file: string;
  start: number;
  length: number;
  hex: string;
  family: Family;
  /** `class` — вместо имени цвета пишется `[var(--…)]`: в Tailwind цвет задан утилитой. */
  wrap?: "class";
};

/**
 * Тот же текст, но комментарии и `url(...)` заменены пробелами. Длина сохраняется, поэтому
 * найденные позиции годятся для правки оригинала.
 */
function mask(text: string) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, match => " ".repeat(match.length))
    .replace(/url\([^)]*\)/gi, match => " ".repeat(match.length));
}

function familyOf(property: string): Family | null {
  const name = property.toLowerCase();
  if (name === "background" || name === "background-color" || name === "background-image") return "background";
  if (name === "color") return "text";
  // Тени не в счёт: цвет тени — это оттенок глубины, а не палитра проекта. В Tailwind-проекте
  // `boxShadow: "0 1px 2px #020617"` иначе забирал себе токен границ.
  if (name === "border" || name.startsWith("border-") || name === "outline" || name.startsWith("outline-")) return "border";
  if (name === "fill" || name === "stroke") return "other";
  return null;
}

/** Границы блоков, где вообще имеет смысл искать объявления: весь CSS или `<style>` разметки. */
function styleRanges(file: ScannedFile): Array<[number, number]> {
  if (file.css) return [[0, file.text.length]];
  if (!/\.(html?|htm)$/i.test(file.file)) return [];
  const ranges: Array<[number, number]> = [];
  for (const match of file.text.matchAll(STYLE_BLOCK)) {
    const at = match.index ?? 0;
    const start = at + match[0].indexOf(">") + 1;
    ranges.push([start, at + match[0].lastIndexOf("</style>")]);
  }
  return ranges;
}

/**
 * Цвета в объявлениях диапазона: CSS-файл, блок `<style>` или значение атрибута `style`.
 * Маска приходит снаружи — её смещения совпадают со смещениями в самом файле.
 */
function declarationsIn(file: string, masked: string, start: number, end: number) {
  const found: Literal[] = [];
  if (end <= start) return found;
  for (const declaration of masked.slice(start, end).matchAll(DECLARATION)) {
    const property = declaration[1];
    if (property.startsWith("--")) continue;
    const family = familyOf(property);
    if (!family) continue;
    const value = declaration[2];
    const valueStart = start + (declaration.index ?? 0) + declaration[0].length - value.length;
    for (const color of value.matchAll(COLOR)) {
      const hex = colorToHex(color[0]);
      if (!hex) continue;
      found.push({ file, start: valueStart + (color.index ?? 0), length: color[0].length, hex, family });
    }
  }
  return found;
}

/** Смещение содержимого атрибута в файле: поиск идёт после `=`, а не с имени атрибута. */
function contentStart(match: RegExpExecArray, content: string) {
  return (match.index ?? 0) + match[0].indexOf(content, match[0].indexOf("="));
}

/**
 * Inline-стили разметки: `style="color:#fff"` в HTML и `style={{ color: "#fff" }}` в JSX.
 * Здесь цвет часто единственное место, где он вообще записан: классы берут его из утилит.
 */
function inlineStylesIn(file: string, masked: string) {
  const found: Literal[] = [];
  for (const attribute of masked.matchAll(STYLE_ATTRIBUTE)) {
    const content = attribute[1] ?? attribute[2] ?? "";
    if (!content) continue;
    const start = contentStart(attribute, content);
    found.push(...declarationsIn(file, masked, start, start + content.length));
  }
  for (const attribute of masked.matchAll(STYLE_OBJECT)) {
    const body = attribute[1] ?? "";
    if (!body) continue;
    const start = contentStart(attribute, body);
    for (const entry of body.matchAll(OBJECT_ENTRY)) {
      // `backgroundColor` — это CSS-свойство `background-color`: семейство берётся по нему же.
      const family = familyOf(entry[1].replace(/[A-Z]/g, char => "-" + char.toLowerCase()));
      if (!family) continue;
      const value = entry[2] ?? entry[3] ?? entry[4] ?? "";
      // Перед значением стоит кавычка: её позиция и есть `конец вхождения − длина значения − 1`.
      const valueStart = start + (entry.index ?? 0) + entry[0].length - value.length - 1;
      for (const color of value.matchAll(COLOR)) {
        const hex = colorToHex(color[0]);
        if (!hex) continue;
        found.push({ file, start: valueStart + (color.index ?? 0), length: color[0].length, hex, family });
      }
    }
  }
  return found;
}

/** Варианты Tailwind (`dark:hover:`) — не цвет: утилита начинается после последнего `:`. */
function stripVariants(token: string) {
  let depth = 0;
  let cut = -1;
  for (let index = 0; index < token.length; index++) {
    const char = token[index];
    if (char === "[" || char === "(") depth++;
    else if (char === "]" || char === ")") depth--;
    else if (char === ":" && depth === 0) cut = index;
  }
  return cut === -1 ? { utility: token, offset: 0 } : { utility: token.slice(cut + 1), offset: cut + 1 };
}

/**
 * Цвет и модификатор прозрачности (`/80`) в хвосте утилиты. С прозрачностью класс не трогается:
 * `bg-[var(--color-surface)]/80` Tailwind понимает не так, как `bg-slate-900/80`, и заголовок
 * потерял бы фон. Цвет с прозрачностью остаётся литералом, пока его не приведёт агент.
 */
function splitAlpha(rest: string) {
  let depth = 0;
  for (let index = rest.length - 1; index >= 0; index--) {
    const char = rest[index];
    if (char === "]" || char === ")") depth++;
    else if (char === "[" || char === "(") depth--;
    else if (char === "/" && depth === 0) return { color: rest.slice(0, index), alpha: rest.slice(index) };
  }
  return { color: rest, alpha: "" };
}

/** Семейство по префиксу утилиты: фон не должен подменять цвет текста. */
function utilityFamily(prefix: string): Family | null {
  if (prefix === "bg") return "background";
  if (prefix === "text" || prefix === "decoration" || prefix === "placeholder") return "text";
  if (/^(border|ring|outline|divide)/.test(prefix)) return "border";
  if (prefix === "fill" || prefix === "stroke") return "other";
  return null;
}

/** Цвета в классах Tailwind: `bg-slate-900`, `text-[#0b0d10]/80`, `border-white`. */
function classColorsIn(file: string, masked: string) {
  const found: Literal[] = [];
  for (const attribute of masked.matchAll(CLASS_ATTRIBUTE)) {
    const content = attribute[1] ?? attribute[2] ?? attribute[3] ?? "";
    if (!content) continue;
    const start = contentStart(attribute, content);
    for (const token of content.matchAll(/\S+/g)) {
      const { utility, offset } = stripVariants(token[0]);
      const match = COLOR_UTILITY.exec(utility);
      if (!match) continue;
      const family = utilityFamily(match[1]);
      if (!family) continue;
      const { color, alpha } = splitAlpha(match[2]);
      if (alpha) continue;
      const colorStart = start + (token.index ?? 0) + offset + match[1].length + 1;
      if (color.startsWith("[") && color.endsWith("]")) {
        // Произвольное значение: `bg-[#0b0d10]` — цвет записан прямо в квадратных скобках.
        const inner = color.slice(1, -1);
        const hex = colorToHex(inner);
        if (!hex) continue;
        found.push({ file, start: colorStart + 1, length: inner.length, hex, family });
        continue;
      }
      const hex = tailwindColor(color);
      if (!hex) continue;
      found.push({ file, start: colorStart, length: color.length, hex, family, wrap: "class" });
    }
  }
  return found;
}

/**
 * Подключён ли в проекте Tailwind. Проверка нужна перед переписыванием классов: класс `bg-white`
 * у проекта без Tailwind может быть своим правилом в CSS, и `bg-[var(--color-bg)]` его не заменит.
 */
function tailwindProject(files: ScannedFile[]) {
  return files.some(file =>
    /(^|\/)tailwind\.config\.(?:c|m)?[jt]s$/.test(file.file) ||
    /@tailwind\s|@import\s+["']tailwindcss|tailwindcss\//.test(file.text),
  );
}

function literalsOf(files: ScannedFile[]) {
  const literals: Literal[] = [];
  const withTailwind = tailwindProject(files);
  for (const file of files) {
    const masked = mask(file.text);
    for (const [start, end] of styleRanges(file)) literals.push(...declarationsIn(file.file, masked, start, end));
    if (!MARKUP_FILE.test(file.file)) continue;
    literals.push(...inlineStylesIn(file.file, masked));
    if (withTailwind) literals.push(...classColorsIn(file.file, masked));
  }
  return literals;
}

type Rgb = [number, number, number];

function channels(hex: string): Rgb {
  return [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16)) as Rgb;
}

function toHex(color: Rgb) {
  return "#" + color.map(channel => Math.round(channel).toString(16).padStart(2, "0")).join("");
}

/** Смешение двух цветов: 0 — первый, 1 — второй. */
function mix(from: string, to: string, amount: number) {
  const a = channels(from);
  const b = channels(to);
  return toHex([0, 1, 2].map(index => a[index] + (b[index] - a[index]) * amount) as Rgb);
}

function luminance(hex: string) {
  const [r, g, b] = channels(hex).map(channel => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function saturation(hex: string) {
  const [r, g, b] = channels(hex).map(channel => channel / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

/** Контрастный к фону цвет с тем же оттенком: тёмный фон получает светлый текст и наоборот. */
function contrastOf(color: string) {
  return luminance(color) > 0.55 ? mix(color, "#000000", 0.88) : mix(color, "#ffffff", 0.9);
}

/** Самый частый цвет семейства; при равенстве побеждает тот, что встретился раньше. */
function top(counts: Map<string, number>) {
  let best: string | undefined;
  let bestCount = 0;
  for (const [hex, count] of counts) {
    if (count > bestCount) {
      best = hex;
      bestCount = count;
    }
  }
  return best;
}

function second(counts: Map<string, number>, first: string | undefined) {
  let best: string | undefined;
  let bestCount = 0;
  for (const [hex, count] of counts) {
    if (hex === first) continue;
    if (count > bestCount) {
      best = hex;
      bestCount = count;
    }
  }
  return best;
}

function tally(literals: Literal[], family: Family) {
  const counts = new Map<string, number>();
  for (const literal of literals) {
    if (literal.family !== family) continue;
    counts.set(literal.hex, (counts.get(literal.hex) ?? 0) + 1);
  }
  return counts;
}

/** Путь к файлу темы относительно переписанного файла; всегда начинается с `.`. */
export function relativeThemePath(file: string) {
  const relative = path.posix.relative(path.posix.dirname(file), THEME_FILE);
  return relative.startsWith(".") ? relative : "./" + relative;
}

function importTheme(css: string, relative: string) {
  // Уже подключён (нашей панелью, агентом или автором проекта) — второй @import не нужен.
  if (/theme\.css/i.test(css)) return css;
  const line = '@import "' + relative + '";\n';
  const charset = /^@charset[^;]*;\s*/i.exec(css);
  if (charset) return css.slice(0, charset[0].length) + line + css.slice(charset[0].length);
  return line + css;
}

function linkTheme(html: string, relative: string) {
  if (/theme\.css/i.test(html)) return html;
  const tag = '<link rel="stylesheet" href="' + relative + '">';
  const head = /<\/head>/i.exec(html);
  if (head) return html.slice(0, head.index) + tag + "\n" + html.slice(head.index);
  const body = /<\/body>/i.exec(html);
  if (body) return html.slice(0, body.index) + tag + "\n" + html.slice(body.index);
  return tag + "\n" + html;
}

function connect(file: string, content: string) {
  const relative = relativeThemePath(file);
  if (/\.(html?|htm)$/i.test(file)) return linkTheme(content, relative);
  if (/\.(m?[jt]sx?)$/i.test(file)) return importModuleTheme(content, relative);
  return importTheme(content, relative);
}

/**
 * Подключение темы из JSX/TSX: `import "./theme.css"` в файле, где переписаны цвета. Один и тот
 * же модуль сборщик подключает один раз, поэтому импорт в соседнем компоненте ничего не дублирует.
 * Директива `"use client"` остаётся первой строкой — иначе она перестаёт работать.
 */
function importModuleTheme(code: string, relative: string) {
  if (/theme\.css/.test(code)) return code;
  const line = 'import "' + relative + '";';
  const directive = /^(\s*["'][^"'\n]+["'];?\s*\n)/.exec(code);
  if (directive) return directive[0] + line + "\n" + code.slice(directive[0].length);
  return line + "\n" + code;
}

/**
 * План перевода: какие токены взять из проекта и какие литералы заменить.
 *
 * Порядок цветов в теме — контрактный (`THEME_FIELDS`), потому что панель показывает их в этом
 * порядке. Производные цвета (поверхность, второстепенный текст, границы) смешиваются из фона и
 * текста: у монохромного проекта иначе не из чего собрать полную палитру.
 */
export function planPalette(files: ScannedFile[]): PalettePlan | null {
  const literals = literalsOf(files);
  if (!literals.length) return null;

  const backgrounds = tally(literals, "background");
  const texts = tally(literals, "text");
  const borders = tally(literals, "border");

  const backgroundTop = top(backgrounds);
  const textTop = top(texts);
  const bg = backgroundTop ?? (textTop ? contrastOf(textTop) : "#ffffff");
  const text = textTop && textTop !== bg ? textTop : contrastOf(bg);
  // Второй фон — это карточки и панели, почти всегда нейтральный. Яркий второй фон — скорее
  // кнопка, то есть акцент: если взять его поверхностью, акцент в палитре вообще не появится,
  // а кнопки начнут красть цвет у карточек.
  // Поверхностью второй фон является, если он почти нейтрален или просто близок к фону по
  // светлоте — как карточка `bg-slate-900` на тёмном `bg-slate-950`. Яркий и далёкий от фона
  // второй фон остаётся акцентом: у монохромного проекта иначе не из чего собрать палитру.
  const surfaceCandidate = second(backgrounds, bg);
  const near = surfaceCandidate ? Math.abs(luminance(surfaceCandidate) - luminance(bg)) : 1;
  const surface = surfaceCandidate && (saturation(surfaceCandidate) <= 0.25 || near <= 0.1)
    ? surfaceCandidate
    : mix(bg, text, 0.06);
  const border = top(borders) ?? mix(bg, text, 0.16);

  // Акцент выбирается раньше «второстепенного текста»: если у проекта один яркий цвет, он
  // должен стать акцентом, а не раствориться в приглушённом тексте.
  const all = new Map<string, number>();
  for (const literal of literals) all.set(literal.hex, (all.get(literal.hex) ?? 0) + 1);
  const accent = [...all.entries()]
    .filter(([hex]) => hex !== bg && saturation(hex) >= 0.3 && Math.abs(luminance(hex) - luminance(bg)) >= 0.1)
    .sort((left, right) => right[1] - left[1] || saturation(right[0]) - saturation(left[0]))
    .map(([hex]) => hex)[0] ?? text;

  // Второй цвет текста — это обычно подписи на акцентных кнопках, а не «второстепенный текст»:
  // на фоне он может почти не читаться. Берём его только если он контрастен к фону и не совпадает
  // с акцентом, иначе выводим приглушённый цвет смешением — палитра не должна делать белый
  // текст на белом и не должна красить ссылки «второстепенным» цветом.
  const mutedCandidate = second(texts, text);
  const muted = mutedCandidate && mutedCandidate !== accent && Math.abs(luminance(mutedCandidate) - luminance(bg)) >= 0.15
    ? mutedCandidate
    : mix(text, bg, 0.4);

  const tokens: Record<string, string> = {
    "--color-bg": bg,
    "--color-surface": surface,
    "--color-text": text,
    "--color-muted": muted,
    "--color-accent": accent,
    "--color-border": border,
  };

  // Для каждого семейства — свои допустимые токены: фон не должен подменять цвет текста,
  // иначе смена палитры перекрасит не то, что человек ждёт.
  const allowed: Record<Family, Array<[string, string]>> = {
    background: [["--color-bg", bg], ["--color-surface", surface], ["--color-accent", accent]],
    text: [["--color-text", text], ["--color-accent", accent], ["--color-muted", muted]],
    border: [["--color-border", border], ["--color-accent", accent], ["--color-text", text]],
    other: [["--color-accent", accent]],
  };

  const byFile = new Map<string, Array<{ start: number; length: number; variable: string; wrap?: "class" }>>();
  for (const literal of literals) {
    const variable = allowed[literal.family].find(([, hex]) => hex === literal.hex)?.[0];
    if (!variable) continue;
    const list = byFile.get(literal.file) ?? [];
    list.push({ start: literal.start, length: literal.length, variable, wrap: literal.wrap });
    byFile.set(literal.file, list);
  }
  if (!byFile.size) return null;

  // В тему попадают только токены, которые действительно встречаются в стилях: производный
  // цвет, которого никто не использует, — лишняя строка в панели, а не палитра проекта.
  const used = new Set<string>();
  for (const list of byFile.values()) for (const replacement of list) used.add(replacement.variable);
  const colorFields = THEME_FIELDS.filter(field => field.kind === "color" && used.has(field.variable));

  const sources = new Map(files.map(file => [file.file, file.text]));
  const rewritten: Array<{ file: string; content: string }> = [];
  for (const [file, replacements] of byFile) {
    const source = sources.get(file);
    if (!source) continue;
    // Замены идут с конца: смещение ранних литералов не съезжает.
    let content = source;
    for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
      const value = "var(" + replacement.variable + ")";
      content = content.slice(0, replacement.start) + (replacement.wrap === "class" ? "[" + value + "]" : value) + content.slice(replacement.start + replacement.length);
    }
    rewritten.push({ file, content: connect(file, content) });
  }
  if (!rewritten.length) return null;

  return {
    tokens: Object.fromEntries(colorFields.map(field => [field.variable, tokens[field.variable]])),
    themeCss: [
      "/* Палитра проекта: собрана панелью «Тема» из цветов страницы. */",
      ":root{",
      ...colorFields.map(field => "  " + field.variable + ":" + tokens[field.variable] + ";"),
      "}",
      "",
    ].join("\n"),
    files: rewritten,
  };
}

const creating = new Map<string, Promise<CreatePaletteResult>>();

/**
 * Создаёт палитру проекта. Идемпотентно: если переменные уже есть, ничего не пишется.
 *
 * Файл темы пишется первым: пока он на месте, `var(--color-…)` в переписанных стилях имеет
 * значение. Если цвета в стилях не нашлись (Tailwind-классы, inline-стили), панель получает
 * причину и показывает прежний путь через агента, а не пустой экран без объяснения.
 */
export async function createProjectPalette(root: string): Promise<CreatePaletteResult> {
  // Один проект — одна сборка палитры: два параллельных запроса (StrictMode, повторное
  // открытие панели) иначе читали бы половину уже переписанных стилей и собирали другую тему.
  const pending = creating.get(root);
  if (pending) return pending;
  const run = createPalette(root).finally(() => creating.delete(root));
  creating.set(root, run);
  return run;
}

async function createPalette(root: string): Promise<CreatePaletteResult> {
  const existing = await readPalette(root);
  if (existing.tokens.length) return { created: false, reason: "" };

  // Неподключённый файл темы панель не считает палитрой, но перезаписывать чужой файл нельзя:
  // перезапись разрешена только для файлов, которые панель создала сама (их выдаёт заголовок).
  if (existing.themeFile) {
    const current = await readFileInside(root, path.join(root, existing.themeFile)).catch(() => "");
    if (!/^\/\* (Палитра|Тема) проекта/.test(current.trimStart())) {
      return {
        created: false,
        reason: "В проекте есть " + existing.themeFile + ", но страница его не подключает. Панель не перезаписывает чужие файлы — подключите его или попросите агента перевести стили на тему.",
      };
    }
  }

  const plan = planPalette(await scanProjectFiles(root));
  if (!plan) {
    return {
      created: false,
      reason:
        "В стилях проекта не нашлось цветов, которые можно перевести на переменные: цветов нет ни в CSS, " +
        "ни в inline-стилях, ни в классах Tailwind. Перевести их на тему сможет агент.",
    };
  }

  await writeFileInside(root, path.join(root, THEME_FILE), plan.themeCss);
  for (const file of plan.files) await writeFileInside(root, path.join(root, file.file), file.content);
  return { created: true };
}
