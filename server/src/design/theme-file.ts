import { stat } from "node:fs/promises";
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
