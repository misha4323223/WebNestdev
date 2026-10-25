import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { readFileInside } from "../sandbox/path-guard.js";
import { THEME_FIELDS, THEME_FILES } from "./theme.js";

/**
 * Палитра проекта — то, что панель «Тема» показывает и правит.
 *
 * Контракт из `theme.ts` (шесть цветов, две шрифтовые пары, скругление) — это то, к чему агент
 * приводит новый проект. У проекта, собранного раньше, переменные называются по-своему
 * (`--bg`, `--ink`, `--brand`), и панель, которая знает только контракт, показывала вместо них
 * свои значения по умолчанию: человек видел «совсем другие цвета», а правка «основного текста»
 * писала `--color-text`, которого страница не читает. Поэтому палитра читается из самого
 * проекта: любое объявление `--имя: <цвет|стек|радиус>;`, где бы оно ни лежало.
 *
 * Для каждой переменной известно, где она объявлена (панель пишет туда же) и читает ли её
 * страница через `var(--имя)`. Без второго признака «нажимаю — ничего не происходит» выглядит
 * поломкой панели, хотя дело в том, что стиль берёт цвет напрямую.
 */

export type PaletteKind = "color" | "font" | "radius" | "length" | "weight" | "number";

export type PaletteToken = {
  variable: string;
  /** Подпись для человека: у контрактных переменных русская, у остальных — само имя. */
  label: string;
  kind: PaletteKind;
  /** Значение в том виде, в каком его правит панель: `#rrggbb`, стек шрифта или `12px`. */
  value: string;
  /** Файл проекта, где переменная объявлена, — туда же уходит правка. */
  file: string;
  /** Читает ли страница переменную через `var(--имя)`. */
  used: boolean;
};

export type Palette = {
  tokens: PaletteToken[];
  /** Файл темы по контракту, если он есть: он показывается в подписи панели. */
  themeFile: string | null;
};

/** Где ищутся объявления палитры: стили, разметка и компоненты. */
const SCAN_EXTENSIONS = new Set([".css", ".html", ".htm", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte"]);
/** Зависимости, сборки и служебные папки: там чужой CSS, и палитры проекта в нём нет. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".output", ".cache", "coverage", ".vite"]);
/**
 * Сколько файлов вообще читается. Импортированный репозиторий с сервером и десятком папок
 * легко переваливает за сотни файлов, и палитра в его стилях просто не попадала в окно сканера:
 * панель честно говорила «переменных нет» про проект, где они есть.
 */
const MAX_FILES = 800;
const MAX_FILE_BYTES = 200_000;

/**
 * Объявление переменной внутри CSS или блока `<style>` в разметке. Разделитель перед именем не
 * требуется: два объявления подряд делят одну и ту же `;`, и жадный префикс съел бы второе.
 */
const DECLARATION = /--([\w-]+)\s*:\s*([^;{}]+?)\s*(?:;|(?=\}))/g;

const FIELD_BY_NAME = new Map(THEME_FIELDS.map(field => [field.variable, field]));

/** Цвет, который панель не умеет показать в своём поле, не считается токеном палитры. */
const MAX_RADIUS = 40;

type Decl = { variable: string; kind: PaletteKind; value: string; file: string };

/**
 * Значение-ссылка (`var(--ink)`) — не цвет, а псевдоним. Такие объявления пропускаются: панель
 * правит сами значения, а запись литерала поверх псевдонима разорвала бы связь между токенами.
 */
function isAlias(raw: string) {
  return /^var\(/i.test(raw.trim());
}

/**
 * Имена цветов, которые встречаются в стилях вместо записи в hex. Список короткий и намеренно
 * неполный: панель умеет править только те значения, которые потом запишет обратно в hex, а
 * `transparent` и остальные «не цветовые» значения палитрой не считаются.
 */
const NAMED_COLORS: Record<string, string> = {
  white: "#ffffff",
  black: "#000000",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  red: "#ff0000",
  maroon: "#800000",
  orange: "#ffa500",
  gold: "#ffd700",
  yellow: "#ffff00",
  olive: "#808000",
  lime: "#00ff00",
  green: "#008000",
  teal: "#008080",
  aqua: "#00ffff",
  cyan: "#00ffff",
  blue: "#0000ff",
  navy: "#000080",
  purple: "#800080",
  violet: "#ee82ee",
  indigo: "#4b0082",
  magenta: "#ff00ff",
  fuchsia: "#ff00ff",
  pink: "#ffc0cb",
  brown: "#a52a2a",
  beige: "#f5f5dc",
  ivory: "#fffff0",
  khaki: "#f0e68c",
  coral: "#ff7f50",
  crimson: "#dc143c",
  salmon: "#fa8072",
  turquoise: "#40e0d0",
  tan: "#d2b48c",
  lavender: "#e6e6fa",
};

/** `#abc`, `#aabbcc`, `#aabbccdd` (только непрозрачный), `rgb()`, `hsl()` или имя → `#rrggbb`. */
export function colorToHex(value: string): string | null {
  const text = value.trim().toLowerCase();
  const named = NAMED_COLORS[text];
  if (named) return named;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
  if (hex) {
    const digits = hex[1];
    if (digits.length === 3) return "#" + digits.split("").map(char => char + char).join("");
    if (digits.length === 8) return digits.endsWith("ff") ? "#" + digits.slice(0, 6) : null;
    return "#" + digits;
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(text);
  if (rgb) return rgbToHex(rgb[1]);
  const hsl = /^hsla?\(([^)]+)\)$/.exec(text);
  if (hsl) return hslToHex(hsl[1]);
  return null;
}

/** Каналы `rgb()`: числа 0–255 или проценты; четвёртый канал — прозрачность, только полная. */
function rgbToHex(body: string): string | null {
  const parts = body.split(/[,\s/]+/).map(part => part.trim()).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  if (parts[3] !== undefined && !/^(1|1\.0|100%)$/.test(parts[3])) return null;
  const channels = parts.slice(0, 3).map(channel => {
    const percent = /^([\d.]+)%$/.exec(channel);
    if (percent) return Math.round(Number(percent[1]) * 2.55);
    if (!/^[\d.]+$/.test(channel)) return null;
    return Math.round(Number(channel));
  });
  if (channels.some(channel => channel === null || channel < 0 || channel > 255)) return null;
  return "#" + channels.map(channel => (channel as number).toString(16).padStart(2, "0")).join("");
}

/** Каналы `hsl()`: тон в градусах, насыщенность и светлота в процентах. */
function hslToHex(body: string): string | null {
  const parts = body.split(/[,\s/]+/).map(part => part.trim()).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  if (parts[3] !== undefined && !/^(1|1\.0|100%)$/.test(parts[3])) return null;
  const hue = /^(-?[\d.]+)(?:deg)?$/.exec(parts[0]);
  const saturation = /^([\d.]+)%$/.exec(parts[1]);
  const lightness = /^([\d.]+)%$/.exec(parts[2]);
  if (!hue || !saturation || !lightness) return null;
  const h = ((Number(hue[1]) % 360) + 360) % 360 / 360;
  const s = Math.min(1, Math.max(0, Number(saturation[1]) / 100));
  const l = Math.min(1, Math.max(0, Number(lightness[1]) / 100));
  const channel = (p: number, q: number, t: number) => {
    const value = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const rgb = [channel(p, q, h + 1 / 3), channel(p, q, h), channel(p, q, h - 1 / 3)];
  return "#" + rgb.map(value => Math.round(value * 255).toString(16).padStart(2, "0")).join("");
}

/** Стек шрифтов: без ссылок на CSS-функции и без символов, которыми ломается объявление. */
function isFontStack(raw: string) {
  const text = raw.trim();
  return text.length > 0 && text.length <= 200 && !/[;{}<>]/.test(text) && !/url\(|@import|expression/i.test(text);
}

/**
 * Значения размеров и типографики. Панель правит только те переменные, в имени которых
 * действительно сказано, что это размер: иначе `--z-index: 10` или `--duration: 200ms`
 * превратились бы в ползунок и человек менял бы не то, что видит.
 */
const LENGTH_VALUE = /^-?(?:\d+|\d*\.\d+)(?:px|rem|em|%|vw|vh|vmin|vmax|ch)$/i;
const LENGTH_NAME = /(space|spacing|gap|pad|margin|inset|width|height|size|font|heading|text|container|section|radius|round|corner|border|letter|icon|blur)/i;
const WEIGHT_NAME = /(font-weight|weight)/i;
const WEIGHT_VALUE = /^(?:100|200|300|400|500|600|700|800|900|normal|bold|bolder|lighter)$/i;
const NUMBER_NAME = /(leading|line-height|scale|ratio)/i;
const NUMBER_VALUE = /^-?(?:\d+|\d*\.\d+)$/;

function kindOf(variable: string, raw: string): { kind: PaletteKind; value: string } | null {
  if (isAlias(raw)) return null;
  const text = raw.trim();
  const name = variable.toLowerCase();
  // `--font-size` и `--font-weight` — не шрифтовой стек, а размер и насыщенность. Раньше
  // проверка `^--font` забирала их себе и панель показывала «шрифт 16px» вместо ползунка.
  if (/^--fonts?(?:-|$)/i.test(variable) && !/(size|weight|height|line|spacing|scale)/i.test(variable)) {
    if (LENGTH_VALUE.test(text)) return { kind: "length", value: text.toLowerCase() };
    return isFontStack(text) ? { kind: "font", value: text } : null;
  }
  const radius = /^(\d{1,3})px$/.exec(text);
  if (radius && Number(radius[1]) <= MAX_RADIUS) {
    // Скруглением считается либо контрактное имя, либо имя, которое об этом прямо говорит:
    // иначе любой `--gap: 12px` занял бы ползунок.
    if (/^--radius/i.test(variable) || /radius|round|corner/i.test(variable)) return { kind: "radius", value: text };
  }
  const hex = colorToHex(text);
  if (hex) return { kind: "color", value: hex };

  if (WEIGHT_NAME.test(name) && WEIGHT_VALUE.test(text)) return { kind: "weight", value: text.toLowerCase() };
  if (NUMBER_NAME.test(name) && NUMBER_VALUE.test(text)) return { kind: "number", value: text };
  // Ноль без единицы — обычное значение отступа; ползунок показывает его как 0 px.
  if (LENGTH_NAME.test(name) && (LENGTH_VALUE.test(text) || text === "0")) return { kind: "length", value: text.toLowerCase() };
  return null;
}

export type ScannedFile = { file: string; text: string; css: boolean };

/** Блок `<style>` в разметке и в серверных шаблонах: только его содержимое — это CSS. */
const STYLE_BLOCK = /<style[^>]*>([\s\S]*?)<\/style>/gi;
/** Скрипты, внутри которых может лежать HTML-строка (серверный рендер). */
const SCRIPT_FILE = /\.(js|mjs|cjs|ts|mts|cts|jsx|tsx)$/i;

/**
 * Где в файле вообще могут быть объявления переменных. CSS — весь файл, разметка и шаблоны —
 * весь файл (там объявления бывают и в `style="…"`), а скрипт — только блоки `<style>`.
 * Без последнего правила палитра серверного проекта, который отдаёт HTML строкой, была пустой:
 * объявления лежали в `<style>` внутри `.js`, а сканер смотрел только CSS и разметку.
 */
function declarationRanges(file: ScannedFile): Array<[number, number]> {
  if (file.css || /\.(html?|htm|vue|svelte)$/i.test(file.file)) return [[0, file.text.length]];
  if (!SCRIPT_FILE.test(file.file)) return [];
  const ranges: Array<[number, number]> = [];
  for (const match of file.text.matchAll(STYLE_BLOCK)) {
    const at = match.index ?? 0;
    ranges.push([at + match[0].indexOf(">") + 1, at + match[0].lastIndexOf("</style>")]);
  }
  return ranges;
}

/**
 * Файлы проекта, где может жить палитра. Обход в ширину: при потолке файлов первыми читаются
 * стили верхнего уровня (`src/`, `styles/`), а не глубокая папка сервера, иначе у монорепозитория
 * палитра снова окажется «пустой».
 */
export async function scanProjectFiles(root: string): Promise<ScannedFile[]> {
  const files: ScannedFile[] = [];
  const queue = [root];
  for (let index = 0; index < queue.length && files.length < MAX_FILES; index++) {
    const dir = queue[index];
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      if (!entry.isFile() || !SCAN_EXTENSIONS.has(extension)) continue;
      const info = await stat(full).catch(() => null);
      if (!info || info.size > MAX_FILE_BYTES) continue;
      const text = await readFile(full, "utf8").catch(() => "");
      if (text) files.push({ file: path.relative(root, full).replaceAll("\\", "/"), text, css: extension === ".css" });
    }
  }
  return files;
}

/**
 * Все переменные, которые страница действительно читает: одним проходом по тексту файлов, а не
 * отдельным поиском на каждый токен — палитра бывает из десятков переменных.
 */
function referencedVariables(files: ScannedFile[]) {
  const referenced = new Set<string>();
  for (const entry of files) {
    for (const match of entry.text.matchAll(/var\(\s*(--[\w-]+)/g)) referenced.add(match[1]);
  }
  return referenced;
}

/**
 * Палитра проекта: сначала объявления подключённого файла темы (он и есть контракт), затем
 * остальные стили и разметка. Одна переменная может быть объявлена в нескольких местах
 * (медиазапрос, вариант темы): панель правит то объявление, которое реально попадает в страницу.
 */
export async function readPalette(root: string): Promise<Palette> {
  const files = await scanProjectFiles(root);
  const themeFile = findContractTheme(files);
  // Файл темы мог появиться без подключения (например, его создала панель у проекта, где цвета
  // вписаны в styles.css). Неподключённый файл в каскаде не участвует, поэтому его значения не
  // должны подменять настоящие: панель иначе правила бы то, чего страница не видит.
  const themeImported = themeFile
    ? files.some(entry => entry.file !== themeFile && /theme\.css/i.test(entry.text))
    : false;
  const ordered = themeFile
    ? [files.find(entry => entry.file === themeFile) as ScannedFile, ...files.filter(entry => entry.file !== themeFile)]
    : files;

  const referenced = referencedVariables(files);
  const byVariable = new Map<string, Decl[]>();
  const order: string[] = [];
  for (const entry of ordered) {
    // Неподключённый файл темы не участвует в каскаде — его значения не палитра проекта, и
    // показывать их рядом с настоящими значит снова давать «совсем другие цвета».
    if (entry.file === themeFile && !themeImported) continue;
    for (const [start, end] of declarationRanges(entry)) {
      for (const match of entry.text.slice(start, end).matchAll(DECLARATION)) {
        const variable = "--" + match[1];
        if (match[1].startsWith("tw-")) continue;
        const parsed = kindOf(variable, match[2]);
        if (!parsed) continue;
        const existing = byVariable.get(variable);
        const decl: Decl = { variable, kind: parsed.kind, value: parsed.value, file: entry.file };
        if (!existing) {
          byVariable.set(variable, [decl]);
          order.push(variable);
        } else {
          existing.push(decl);
        }
      }
    }
  }

  const tokens: PaletteToken[] = [];
  for (const variable of order) {
    const declarations = byVariable.get(variable) as Decl[];
    const used = referenced.has(variable);
    const fromTheme = declarations.find(decl => decl.file === themeFile);
    const fromProject = declarations.find(decl => decl.file !== themeFile);
    // Значение берётся из того файла, который реально попадает в страницу: из подключённого
    // файла темы, иначе — из стилей проекта.
    const chosen = (themeImported && fromTheme) || (themeImported ? declarations[0] : fromProject ?? declarations[0]);
    tokens.push({
      variable,
      label: FIELD_BY_NAME.get(variable)?.label ?? variable,
      kind: chosen.kind,
      value: chosen.value,
      file: chosen.file,
      used,
    });
  }

  // Контрактные токены — первыми: у нового проекта это вся палитра, и порядок в панели должен
  // совпадать с порядком, в котором о них говорит агент.
  const contractOrder = new Map(THEME_FIELDS.map((field, index) => [field.variable, index]));
  tokens.sort((left, right) => {
    const a = contractOrder.get(left.variable);
    const b = contractOrder.get(right.variable);
    if (a !== undefined && b !== undefined) return a - b;
    if (a !== undefined) return -1;
    if (b !== undefined) return 1;
    return order.indexOf(left.variable) - order.indexOf(right.variable);
  });

  return { tokens, themeFile };
}

/** Файл темы по контракту: панель называет его в подписи, чтобы было видно, где живёт палитра. */
function findContractTheme(files: ScannedFile[]): string | null {
  for (const relative of THEME_FILES) {
    if (files.some(entry => entry.file === relative)) return relative;
  }
  return null;
}

const COLOR_VALUE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Значение, которое можно записать в файл проекта. Значение приходит из браузера, а попадает в
 * CSS, который исполняет страница, поэтому проверка идёт по виду токена, а не по доверию.
 */
export function normalizePaletteValue(kind: PaletteKind, value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (kind === "color") {
    if (!COLOR_VALUE.test(text)) throw new Error("Цвет задаётся в формате #rrggbb");
    return text.toLowerCase();
  }
  if (kind === "font") {
    if (!isFontStack(text)) throw new Error("Шрифт должен быть стеком шрифтов без ссылок и служебных символов");
    return text;
  }
  if (kind === "length") {
    if ((!LENGTH_VALUE.test(text) && text !== "0") || text.length > 20) {
      throw new Error("Размер задаётся числом с единицей: px, rem, em, %, vw, vh, vmin, vmax или ch");
    }
    const numeric = Number.parseFloat(text);
    if (!Number.isFinite(numeric) || Math.abs(numeric) > 4000) throw new Error("Размер выходит за допустимые пределы");
    return text.toLowerCase();
  }
  if (kind === "weight") {
    if (!WEIGHT_VALUE.test(text)) throw new Error("Насыщенность задаётся числом от 100 до 900 или normal/bold");
    return text.toLowerCase();
  }
  if (kind === "number") {
    if (!NUMBER_VALUE.test(text) || text.length > 12) throw new Error("Значение задаётся числом без единиц");
    const numeric = Number.parseFloat(text);
    if (!Number.isFinite(numeric) || Math.abs(numeric) > 100) throw new Error("Значение выходит за допустимые пределы");
    return text;
  }
  const radius = /^(\d{1,2})px$/.exec(text);
  if (!radius || Number(radius[1]) > MAX_RADIUS) throw new Error("Скругление задаётся в пикселях, от 0 до " + MAX_RADIUS);
  return text;
}

/**
 * Замена объявления: правится только значение, форматирование и остальные правила файла
 * остаются как были. Если объявления нет — ошибка, а не запись нового: панель показывает лишь
 * то, что в проекте уже объявлено, поэтому «не нашлось» означает изменившийся файл.
 */
export function patchPaletteValue(css: string, variable: string, kind: PaletteKind, value: unknown): string {
  const normalized = normalizePaletteValue(kind, value);
  // Последнее объявление блока часто написано без `;` — терминатор, если он был, сохраняется.
  const pattern = new RegExp("(^|[;{\\s])(" + variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:\\s*)([^;{}]*)(;?)", "m");
  if (!pattern.test(css)) throw new Error("В файле проекта больше нет переменной " + variable);
  return css.replace(pattern, (_match, before: string, head: string, _old: string, end: string) => before + head + normalized + end);
}

/** Текст файла проекта для правки палитры (пути проверяются path-guard). */
export async function readPaletteFile(root: string, file: string) {
  return readFileInside(root, path.join(root, file));
}
