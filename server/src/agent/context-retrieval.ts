import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { getSandbox } from "../sandbox-manager.js";
import { readFileInside } from "../sandbox/path-guard.js";
import { isSecretProjectPath } from "../secrets/secret-paths.js";
import { isIgnoredProjectDir } from "../project-ignore.js";

// Контекст — это аванс, а не склад. Восемь файлов и короткий фрагмент каждого дают модели
// направление, а полный текст она читает через fs.read/fs.outline уже по необходимости.
const MAX_FILES = 8;
const MAX_FILE_CHARS = 5000;
const MAX_TOTAL_CHARS = 28000;
const MAX_EXCERPT_LINES = 80;

function tokens(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9_./-]+/g, " ")
      .split(/\s+/)
      .filter(token => token.length >= 3)
      .slice(0, 2000),
  );
}

function score(file: string, taskTokens: Set<string>): number {
  const fileTokens = tokens(file);
  let value = 0;
  for (const token of taskTokens) {
    if (fileTokens.has(token)) value += 8;
    if (file.toLowerCase().includes(token)) value += 3;
  }
  if (/\.(tsx?|jsx?|vue|svelte)$/.test(file)) value += 1;
  if (/(package\.json|tsconfig|vite\.config|next\.config|README|AGENTS\.md|WEBNEST\.md)$/i.test(file)) value += 2;
  return value;
}

async function collectFiles(root: string, current: string, relative: string, result: string[]) {
  if (result.length >= 1500) return;
  let entries;
  try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (isIgnoredProjectDir(entry.name)) continue;
    // Секретный env-файл не попадает в контекст даже по имени: модель не должна просить его
    // содержимое и не должна получать его случайно вместе с исходниками.
    if (isSecretProjectPath(entry.name)) continue;
    const child = path.join(current, entry.name);
    const childRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
    // Символическая ссылка может вести в другой проект или в /etc: в контекст она не попадает.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await collectFiles(root, child, childRelative, result);
    else if (entry.isFile()) {
      try {
        const info = await lstat(child);
        if (info.size <= 200_000) result.push(childRelative);
      } catch {}
    }
  }
}

export async function retrieveRelevantFiles(
  projectId: string,
  userId: string,
  task: string,
): Promise<string> {
  const sandbox = await getSandbox(projectId, userId);
  const files: string[] = [];
  await collectFiles(sandbox.root, sandbox.root, "", files);

  const taskTokens = tokens(task);
  const ranked = files
    .map(file => ({ file, score: score(file, taskTokens) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_FILES);

  let total = 0;
  const sections: string[] = [];
  for (const item of ranked) {
    if (item.score <= 0 && sections.length >= 4) break;
    try {
      const content = await readFileInside(sandbox.root, path.join(sandbox.root, item.file));
      const remaining = MAX_TOTAL_CHARS - total;
      if (remaining <= 0) break;
      const lines = content.split(/\r?\n/);
      const head = lines.slice(0, MAX_EXCERPT_LINES).join("\n");
      const excerpt = content.length <= MAX_FILE_CHARS && lines.length <= MAX_EXCERPT_LINES
        ? content
        : head.slice(0, Math.min(MAX_FILE_CHARS, remaining));
      const note = excerpt.length < content.length
        ? "\n…[показаны первые " + Math.min(lines.length, MAX_EXCERPT_LINES) + " строк из " + lines.length +
          "; остальное — через fs.read или fs.outline]…"
        : "";
      const snippet = excerpt + note;
      sections.push("FILE: " + item.file + " (" + lines.length + " строк)\n" + snippet);
      total += snippet.length;
    } catch {}
  }

  return sections.length ? sections.join("\n\n") : "No relevant source files were automatically selected.";
}
