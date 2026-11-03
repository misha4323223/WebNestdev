/**
 * Каталоги, которые не являются исходниками проекта.
 *
 * Список живёт в одном месте, потому что раньше он был скопирован в трёх: дерево PROJECT CONTEXT,
 * автоподбор файлов и `fs.grep`. Копии разъехались — `.webnestdev` не исключался нигде, кроме
 * git, и PNG-снимки попадали в контекст как бинарный шум. Один список не даёт этому повториться.
 *
 * `dist` и `build` исключаются по умолчанию, но явный `path: "dist"` в `fs.grep` всё равно
 * обходится: инструмент должен уметь искать в сборке, когда это действительно нужно.
 */
export const IGNORED_PROJECT_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  ".cache",
  ".turbo",
  ".nuxt",
  ".output",
  "coverage",
  ".vite",
  ".python",
  "vendor",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".vscode",
  // Служебная папка платформы: снимки проверок, логи и прочие артефакты, а не исходники.
  ".webnestdev",
]);

export function isIgnoredProjectDir(name: string) {
  return IGNORED_PROJECT_DIRS.has(name);
}
