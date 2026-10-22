/**
 * Дизайн-токены проекта: единственное место, где живёт палитра, шрифтовая пара и скругление.
 *
 * Панель «Тема» в предпросмотре правит этот файл напрямую, без модели: пользователь меняет
 * цвет и сразу видит результат. Поэтому контракт жёсткий — фиксированный набор переменных,
 * фиксированные допустимые значения и аккуратная замена в существующем CSS. Всё остальное
 * (какие элементы каким токеном красить) остаётся за агентом, который читает тот же файл.
 *
 * Файл-контракт: `theme.css` в корне проекта или `src/theme.css` у проекта со сборщиком.
 * Переменные объявлены в `:root`, остальные правила файла не трогаются: патч меняет только
 * значение конкретного объявления.
 */

export const THEME_FILE = "theme.css";

/** Порядок проверки: сначала корень (статические сайты), затем `src/` (Vite/React). */
export const THEME_FILES = [THEME_FILE, "src/theme.css"] as const;

export type ThemeField =
  | { variable: string; label: string; kind: "color"; value: string }
  | { variable: string; label: string; kind: "font"; value: string; options: Array<{ value: string; label: string }> }
  | { variable: string; label: string; kind: "radius"; value: string };

/**
 * Шрифтовые пары — это стеки, а не ссылки на CDN: сгенерированный сайт не должен зависеть от
 * чужого хоста, который в России может не открыться. Если пользователю нужен именно
 * брендовый шрифт, агент подключает его пакетом и заменяет значение стека.
 */
export const FONT_OPTIONS = [
  { value: "ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", Roboto, Arial, sans-serif", label: "Системный гротеск" },
  { value: "\"Manrope\", \"Inter\", ui-sans-serif, system-ui, sans-serif", label: "Геометрический (Manrope)" },
  { value: "Georgia, \"Times New Roman\", \"PT Serif\", serif", label: "Редакционный (с засечками)" },
  { value: "ui-monospace, SFMono-Regular, Menlo, \"Courier New\", monospace", label: "Моноширинный" },
] as const;

export const THEME_FIELDS: ThemeField[] = [
  { variable: "--color-bg", label: "Фон", kind: "color", value: "#0b0d10" },
  { variable: "--color-surface", label: "Поверхности", kind: "color", value: "#14181d" },
  { variable: "--color-text", label: "Основной текст", kind: "color", value: "#eef0f3" },
  { variable: "--color-muted", label: "Второстепенный текст", kind: "color", value: "#8b939e" },
  { variable: "--color-accent", label: "Акцент", kind: "color", value: "#6fbf8b" },
  { variable: "--color-border", label: "Границы", kind: "color", value: "#242a31" },
  { variable: "--font-heading", label: "Шрифт заголовков", kind: "font", value: FONT_OPTIONS[0].value, options: FONT_OPTIONS.map(option => ({ value: option.value, label: option.label })) },
  { variable: "--font-body", label: "Шрифт текста", kind: "font", value: FONT_OPTIONS[0].value, options: FONT_OPTIONS.map(option => ({ value: option.value, label: option.label })) },
  { variable: "--radius", label: "Скругление", kind: "radius", value: "12px" },
];

const FIELD_BY_NAME = new Map(THEME_FIELDS.map(field => [field.variable, field]));

const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const RADIUS = /^(?:0|[1-9][0-9]{0,1})px$/;
const MAX_RADIUS = 40;

/**
 * Значение токена, которое можно записать в CSS. Строгая проверка — не формальность: значение
 * приходит из браузера, а пишется в файл проекта, который потом исполняет браузер пользователя.
 */
export function normalizeToken(variable: string, value: unknown): string {
  const field = FIELD_BY_NAME.get(variable);
  if (!field) throw new Error("Неизвестный токен темы: " + variable);
  const text = typeof value === "string" ? value.trim() : "";
  if (field.kind === "color") {
    if (!COLOR.test(text)) throw new Error("Цвет " + variable + " должен быть в формате #rrggbb");
    return text.toLowerCase();
  }
  if (field.kind === "font") {
    if (!field.options.some(option => option.value === text)) throw new Error("Шрифт " + variable + " не из списка доступных");
    return text;
  }
  if (!RADIUS.test(text) || Number.parseInt(text, 10) > MAX_RADIUS) {
    throw new Error("Скругление " + variable + " задаётся в пикселях, от 0 до " + MAX_RADIUS);
  }
  return text;
}

/** Значения токенов, которые уже объявлены в файле: неизвестные переменные пропускаются. */
export function parseTheme(css: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const match of css.matchAll(/--([\w-]+)\s*:\s*([^;{}]+);/g)) {
    const variable = "--" + match[1];
    const value = match[2].trim();
    if (!FIELD_BY_NAME.has(variable)) continue;
    try {
      tokens[variable] = normalizeToken(variable, value);
    } catch {
      // Значение вне контракта (например, `var(--brand)` в чужом файле) не считается токеном темы:
      // показывать его в палитре как цвет нельзя, а перезаписывать без спроса — тем более.
    }
  }
  return tokens;
}

function declaration(variable: string, value: string, indent: string) {
  return indent + variable + ":" + value + ";";
}

/**
 * Патч файла: меняет только значения переданных токенов.
 *
 * Сначала ищется существующее объявление `--name: value;` — тогда правится ровно оно, и
 * форматирование файла, комментарии и остальные правила остаются как были. Если объявления нет,
 * оно дописывается в конец первого блока `:root`; если блока нет — файл получает свой `:root`.
 */
export function patchTheme(css: string, values: Record<string, unknown>): string {
  const normalized: Record<string, string> = {};
  for (const [variable, value] of Object.entries(values)) normalized[variable] = normalizeToken(variable, value);

  let next = css;
  const missing: Array<[string, string]> = [];
  for (const [variable, value] of Object.entries(normalized)) {
    const pattern = new RegExp("(^|[;{\\s])(" + variable + "\\s*:\\s*)([^;{}]*)(;)", "m");
    if (pattern.test(next)) {
      next = next.replace(pattern, (_match, before: string, head: string, _old: string, end: string) => before + head + value + end);
    } else {
      missing.push([variable, value]);
    }
  }
  if (!missing.length) return next;

  const root = /:root\s*\{/.exec(next);
  if (root) {
    const at = root.index + root[0].length;
    const close = next.indexOf("}", at);
    if (close !== -1) {
      const block = next.slice(at, close);
      const indent = /(^|\n)([ \t]+)\S/.exec(block)?.[2] ?? "  ";
      // Блок уже заканчивается переводом строки — второй добавил бы пустую строку перед токеном.
      const lead = block.endsWith("\n") || !block.trim() ? "" : "\n";
      const addition = lead + missing.map(([variable, value]) => declaration(variable, value, indent) + "\n").join("");
      return next.slice(0, close) + addition + next.slice(close);
    }
  }
  const addition = "\n:root{\n" + missing.map(([variable, value]) => declaration(variable, value, "  ") + "\n").join("") + "}\n";
  return next.replace(/\s*$/, "\n") + addition;
}

/** Текст файла темы с нуля — им пользуется агент, когда в проекте темы ещё нет. */
export function themeFile(overrides: Record<string, unknown> = {}): string {
  const values: Record<string, string> = {};
  for (const field of THEME_FIELDS) values[field.variable] = field.value;
  for (const [variable, value] of Object.entries(overrides)) values[variable] = normalizeToken(variable, value);
  return [
    "/* Тема проекта: панель «Тема» в предпросмотре меняет эти значения. */",
    ":root{",
    ...THEME_FIELDS.map(field => "  " + field.variable + ":" + values[field.variable] + ";"),
    "}",
    "",
  ].join("\n");
}
