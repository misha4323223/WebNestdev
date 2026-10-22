import path from "node:path";
import { readFileInside, writeFileInside } from "../sandbox/path-guard.js";
import { colorToHex, readPalette, scanProjectFiles, type ScannedFile } from "./palette.js";
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
 * - меняются только значения цветовых свойств (`background*`, `color`, `border*`, `outline*`,
 *   `fill`, `stroke`), только в CSS и блоках `<style>` — не в JS/TSX и не в атрибутах: там
 *   замена строки может сломать код, а не покрасить страницу;
 * - каждый переписанный файл получает подключение `theme.css` (CSS — `@import`, HTML — `<link>`),
 *   поэтому переменные определены и на отдельной странице, которая грузит этот файл без главного;
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

type Literal = { file: string; start: number; length: number; hex: string; family: Family };

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
  if (name === "border" || name.startsWith("border-") || name === "outline" || name.startsWith("outline-") || name === "box-shadow" || name === "text-shadow") return "border";
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

function literalsOf(files: ScannedFile[]) {
  const literals: Literal[] = [];
  for (const file of files) {
    const masked = mask(file.text);
    for (const [start, end] of styleRanges(file)) {
      if (end <= start) continue;
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
          literals.push({ file: file.file, start: valueStart + (color.index ?? 0), length: color[0].length, hex, family });
        }
      }
    }
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
  return /\.(html?|htm)$/i.test(file) ? linkTheme(content, relative) : importTheme(content, relative);
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
  const surfaceCandidate = second(backgrounds, bg);
  const surface = surfaceCandidate && saturation(surfaceCandidate) <= 0.25 ? surfaceCandidate : mix(bg, text, 0.06);
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

  const byFile = new Map<string, Array<{ start: number; length: number; variable: string }>>();
  for (const literal of literals) {
    const variable = allowed[literal.family].find(([, hex]) => hex === literal.hex)?.[0];
    if (!variable) continue;
    const list = byFile.get(literal.file) ?? [];
    list.push({ start: literal.start, length: literal.length, variable });
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
      content = content.slice(0, replacement.start) + "var(" + replacement.variable + ")" + content.slice(replacement.start + replacement.length);
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
      reason: "В стилях проекта не нашлось цветов, которые можно перевести на переменные: цвета заданы классами или inline-стилями. Перевести их на тему сможет агент.",
    };
  }

  await writeFileInside(root, path.join(root, THEME_FILE), plan.themeCss);
  for (const file of plan.files) await writeFileInside(root, path.join(root, file.file), file.content);
  return { created: true };
}
