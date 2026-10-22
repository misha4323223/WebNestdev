import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { readFileInside } from "../sandbox/path-guard.js";
import { THEME_FILES } from "./theme.js";

/**
 * Где лежит тема проекта. Пути проверяются по контракту (`theme.css` в корне, затем
 * `src/theme.css`), чтение идёт через path-guard: файл вне проекта или ссылка наружу — не тема.
 *
 * Панель «Тема» и инструмент агента ищут файл одинаково; иначе они правили бы разные файлы и
 * палитра в предпросмотре расходилась бы с тем, что видит модель.
 */
export type FoundTheme = { file: string; css: string };

/** Больше этого файл темы не бывает: чужой огромный CSS не читается в панель. */
export const MAX_THEME_BYTES = 200_000;

/** Где ищется использование переменных темы: стили и разметка проекта. */
const USAGE_EXTENSIONS = new Set([".css", ".html", ".htm", ".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte"]);
/** Зависимости, сборки и служебные папки: там чужой код, и токенов темы в нём нет. */
const USAGE_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".output", ".cache", "coverage"]);
const USAGE_MAX_FILES = 400;
/** Сколько файла читается на предмет `var(--color-…)`: стиль проекта — это килобайты, а не мегабайты. */
const USAGE_MAX_FILE_BYTES = 200_000;
const TOKEN_USAGE = /var\(\s*--(?:color|font|radius)/;

/**
 * Использует ли страница проекта переменные темы.
 *
 * Панель «Тема» меняет значения `--color-…`/`--font-…`/`--radius`, и если разметка и стили их не
 * читают, сохранение ничего не перекрасит. Без этой проверки панель молчит, а человек видит
 * «нажимаю — ничего не происходит» и не знает, что дело в подключении темы, а не в панели.
 */
export async function usesThemeTokens(root: string): Promise<boolean> {
  const stack = [root];
  let files = 0;
  while (stack.length && files < USAGE_MAX_FILES) {
    const dir = stack.pop() as string;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files >= USAGE_MAX_FILES) break;
      if (entry.name.startsWith(".") || USAGE_SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !USAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const info = await stat(full).catch(() => null);
      if (!info || info.size > USAGE_MAX_FILE_BYTES) continue;
      files++;
      const text = await readFile(full, "utf8").catch(() => "");
      if (TOKEN_USAGE.test(text)) return true;
    }
  }
  return false;
}

export async function findThemeFile(root: string, maxBytes = MAX_THEME_BYTES): Promise<FoundTheme | null> {
  for (const relative of THEME_FILES) {
    const candidate = path.join(root, relative);
    try {
      const info = await stat(candidate);
      if (!info.isFile() || info.size > maxBytes) continue;
      return { file: relative, css: await readFileInside(root, candidate) };
    } catch {
      // Файла нет или он не читается как обычный файл — проверяется следующий кандидат.
    }
  }
  return null;
}
