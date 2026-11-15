import type { RepoFile, RepoFindMatch, RepoIndex, RepoMapResult } from "./types.js";

/**
 * Search over the index, not over file contents. The score combines the task's words with the
 * structure the index knows: path, exported names, imports and the reverse import graph. A task
 * that names one file still gets its callers, which is exactly the cross-module case the old
 * lexical top-8 missed.
 */
const GENERIC = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "как", "что", "для", "это",
  "или", "при", "над", "под", "все", "его", "она", "они", "код", "файл", "файлы", "проект",
  "сделай", "добавь", "поправь", "измени", "нужно", "надо", "чтобы", "который", "которая",
]);

export function queryTokens(text: string): string[] {
  const words = text
    .replace(/([a-zа-я0-9])([A-ZА-Я])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-zа-я0-9_./-]+/g, " ")
    .split(/\s+/)
    .map(word => word.replace(/^[./-]+|[./-]+$/g, ""))
    .filter(word => word.length >= 3 && !GENERIC.has(word));
  return [...new Set(words)].slice(0, 40);
}

function filename(pathValue: string) {
  const parts = pathValue.split("/");
  return parts[parts.length - 1] ?? pathValue;
}

function scoreFile(file: RepoFile, tokens: string[], entryPoints: Set<string>) {
  const pathValue = file.path.toLowerCase();
  const base = filename(pathValue);
  let score = 0;
  const reasons: string[] = [];
  for (const token of tokens) {
    if (base === token || base.replace(/\.[^.]+$/, "") === token) {
      score += 12;
      reasons.push("имя файла");
    } else if (base.includes(token)) {
      score += 7;
      reasons.push("имя файла");
    } else if (pathValue.includes(token)) {
      score += 5;
      reasons.push("путь");
    }
    if (file.symbols.some(symbol => symbol.toLowerCase() === token)) {
      score += 12;
      reasons.push("символ " + token);
    } else if (file.symbols.some(symbol => symbol.toLowerCase().includes(token))) {
      score += 5;
      reasons.push("символ");
    }
    if (file.imports.some(item => item.specifier.toLowerCase().includes(token))) {
      score += 3;
      reasons.push("импорт");
    }
  }
  if (score > 0 && entryPoints.has(file.path)) score += 2;
  if (score > 0 && /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|README[^/]*|AGENTS\.md)$/i.test(file.path)) score += 1;
  return { score, reason: [...new Set(reasons)].slice(0, 3).join(", ") };
}

function reverseGraph(index: RepoIndex): Map<string, string[]> {
  const reverse = new Map<string, string[]>();
  for (const file of index.files) {
    for (const item of file.imports) {
      if (!item.target) continue;
      const list = reverse.get(item.target) ?? [];
      list.push(file.path);
      reverse.set(item.target, list);
    }
  }
  return reverse;
}

function topDirectories(index: RepoIndex) {
  const counts = new Map<string, number>();
  for (const file of index.files) {
    const first = file.path.includes("/") ? file.path.split("/")[0] : "(root)";
    counts.set(first, (counts.get(first) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([pathValue, files]) => ({ path: pathValue, files }))
    .sort((a, b) => b.files - a.files || a.path.localeCompare(b.path))
    .slice(0, 20);
}

function anchorFiles(index: RepoIndex) {
  const byPath = new Map(index.files.map(file => [file.path, file]));
  const result = new Set<string>();
  for (const entry of index.entryPoints) if (byPath.has(entry)) result.add(entry);
  for (const name of ["package.json", "README.md", "AGENTS.md"]) if (byPath.has(name)) result.add(name);
  const ranked = [...index.files]
    .map(file => ({
      path: file.path,
      score: file.imports.filter(item => item.target).length * 2 + file.symbols.length,
    }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  for (const item of ranked) {
    if (result.size >= 12) break;
    if (item.score > 0) result.add(item.path);
  }
  return [...result];
}

export function repoMapSummary(index: RepoIndex): RepoMapResult {
  const languages: Record<string, number> = {};
  for (const file of index.files) languages[file.language] = (languages[file.language] ?? 0) + 1;
  return {
    generatedAt: index.generatedAt,
    fingerprint: index.fingerprint,
    stats: index.stats,
    limits: index.limits,
    languages,
    packages: index.packages,
    entryPoints: index.entryPoints,
    testFiles: index.tests.length,
    topDirectories: topDirectories(index),
    anchors: anchorFiles(index),
  };
}

export type SearchScope = { path: string; label: string };

/**
 * Resolve `fs.grep scope`: a workspace package name or a project-relative directory. The result
 * is checked against the indexed files, so a typo cannot silently search the whole repository.
 */
export function resolveSearchScope(index: RepoIndex, scope: string): SearchScope | undefined {
  const value = scope.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!value) return undefined;
  const pkg = index.packages.find(item => item.name === value);
  if (pkg) return { path: pkg.dir, label: pkg.name };
  if (value.startsWith("..") || value.includes("/../")) return undefined;
  if (index.files.some(file => file.path === value || file.path.startsWith(value + "/"))) {
    return { path: value, label: value };
  }
  return undefined;
}

export type FindOptions = { limit?: number; includeTests?: boolean };

/**
 * Rank files for a task and expand one hop through imports in both directions. The expansion is
 * bounded and only seeds from the strongest matches: a broad word like "api" should not turn into
 * the whole repository.
 */
export function findRelevantFiles(index: RepoIndex, query: string, options: FindOptions = {}): RepoFindMatch[] {
  const limit = Math.max(1, Math.min(30, Math.floor(options.limit ?? 10)));
  const includeTests = options.includeTests !== false;
  const tokens = queryTokens(query);
  const entryPoints = new Set(index.entryPoints);
  const reverse = reverseGraph(index);
  const scores = new Map<string, { score: number; reason: string }>();
  for (const file of index.files) {
    if (!includeTests && index.tests.includes(file.path)) continue;
    const scored = scoreFile(file, tokens, entryPoints);
    if (scored.score > 0) scores.set(file.path, scored);
  }

  // A vague request still deserves orientation rather than an empty answer.
  if (!scores.size) {
    for (const pathValue of anchorFiles(index)) {
      scores.set(pathValue, { score: 1, reason: "точка входа проекта" });
    }
  }

  const ranked = [...scores.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
  const best = ranked[0]?.[1].score ?? 0;
  // Only strong matches seed the graph expansion. Entry-point and config files used to seed it
  // for every query, which pulled a whole unrelated workspace branch into the result.
  const seeded = ranked.filter(([, scored]) => scored.score >= Math.max(4, best * 0.4)).slice(0, 8);
  const byPath = new Map(index.files.map(file => [file.path, file]));
  for (const [pathValue, scored] of seeded) {
    const file = byPath.get(pathValue);
    if (!file) continue;
    for (const caller of reverse.get(pathValue) ?? []) {
      const current = scores.get(caller);
      const value = scored.score * 0.4;
      if (!current || current.score < value) {
        scores.set(caller, { score: value, reason: "использует " + pathValue });
      }
    }
    for (const item of file.imports) {
      if (!item.target) continue;
      const current = scores.get(item.target);
      const value = scored.score * 0.3;
      if (!current || current.score < value) {
        scores.set(item.target, { score: value, reason: "импортируется из " + pathValue });
      }
    }
  }

  return [...scores.entries()]
    .filter(([pathValue]) => includeTests || !index.tests.includes(pathValue))
    .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([pathValue, scored]) => {
      const file = byPath.get(pathValue);
      return {
        path: pathValue,
        score: Math.round(scored.score * 10) / 10,
        reason: scored.reason,
        symbols: file?.symbols.slice(0, 8) ?? [],
        imports: (file?.imports ?? []).map(item => item.specifier).slice(0, 8),
        dependents: (reverse.get(pathValue) ?? []).slice(0, 8),
      };
    });
}
