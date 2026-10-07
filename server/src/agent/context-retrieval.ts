import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { getSandbox } from "../sandbox-manager.js";

const MAX_FILES = 12;
const MAX_RELATED_FILES = 8;
const MAX_FILE_CHARS = 12000;
const MAX_TOTAL_CHARS = 70000;
const IGNORED = new Set([".git", "node_modules", "dist", "build", ".next", ".cache", ".turbo"]);

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
    if (IGNORED.has(entry.name)) continue;
    const child = path.join(current, entry.name);
    const childRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) await collectFiles(root, child, childRelative, result);
    else {
      try {
        const info = await stat(child);
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
      const content = await readFile(path.join(sandbox.root, item.file), "utf8");
      const remaining = MAX_TOTAL_CHARS - total;
      if (remaining <= 0) break;
      const snippet = content.length > Math.min(MAX_FILE_CHARS, remaining)
        ? content.slice(0, Math.min(MAX_FILE_CHARS, remaining)) + "\n...[truncated]"
        : content;
      sections.push("FILE: " + item.file + "\n" + snippet);
      total += snippet.length;
    } catch {}
  }

  return sections.length ? sections.join("\n\n") : "No relevant source files were automatically selected.";
}
