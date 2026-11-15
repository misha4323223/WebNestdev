import type { RepoIndex } from "./repo-index/types.js";

/**
 * Affected tests: which existing test files can observe a change through the import graph.
 *
 * This is deliberately a static, conservative calculation. It never runs a test, never reads a
 * test body and never guesses that a test is safe to skip. A miss costs a regression; an extra
 * test only costs time, so the search follows callers upward and treats project-wide files
 * (`package.json`, test configs, lockfiles) as "run everything".
 */
export type AffectedTests = {
  tests: string[];
  changed: string[];
  /** Why these tests were selected; useful in the tool result and in a run journal. */
  reasons: string[];
  /** True when the project-wide configuration changed and narrowing would be unsafe. */
  fullRun: boolean;
  truncated: boolean;
};

export type AffectedTestOptions = {
  /** How many reverse import hops to follow; the default is deliberately small. */
  maxDepth?: number;
  /** Hard cap so one query cannot return every test in a monorepo. */
  limit?: number;
};

const PROJECT_WIDE = /(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|vitest\.config\.[^/]+|jest\.config\.[^/]+|playwright\.config\.[^/]+|tsconfig[^/]*\.json|pytest\.ini|pyproject\.toml|setup\.cfg)$/i;

function cleanPath(value: string) {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function testSibling(pathValue: string, tests: Set<string>) {
  const match = pathValue.match(/^(.*\/)?([^/]+?)(\.[^.]+)$/);
  if (!match) return [];
  const dir = match[1] ?? "";
  const base = match[2];
  const ext = match[3];
  const candidates = [
    dir + base + ".test" + ext,
    dir + base + ".spec" + ext,
    dir + "__tests__/" + base + ".test" + ext,
    dir + "__tests__/" + base + ".spec" + ext,
    dir + base + "_test.py",
    dir + "test_" + base + ".py",
  ];
  return candidates.filter(candidate => tests.has(candidate));
}

function reverseGraph(index: RepoIndex) {
  const reverse = new Map<string, string[]>();
  for (const file of index.files) {
    for (const item of file.imports) {
      if (!item.target) continue;
      const callers = reverse.get(item.target) ?? [];
      callers.push(file.path);
      reverse.set(item.target, callers);
    }
  }
  return reverse;
}

/**
 * Return the existing tests that should be run for the changed files. Unknown files are allowed:
 * a new module often has a test that already imports the path, and its own sibling test is still
 * a useful candidate.
 */
export function affectedTests(
  index: RepoIndex,
  changedFiles: readonly string[],
  options: AffectedTestOptions = {},
): AffectedTests {
  const maxDepth = Math.max(0, Math.min(12, Math.floor(options.maxDepth ?? 3)));
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)));
  const tests = new Set(index.tests.map(cleanPath));
  const changed = [...new Set(changedFiles.map(cleanPath).filter(Boolean))];
  const selected = new Set<string>();
  const reasons: string[] = [];
  let fullRun = false;

  if (changed.some(pathValue => PROJECT_WIDE.test(pathValue))) {
    fullRun = true;
    for (const test of tests) selected.add(test);
    reasons.push("изменена конфигурация проекта: сужать набор тестов небезопасно");
  } else {
    const reverse = reverseGraph(index);
    for (const pathValue of changed) {
      if (tests.has(pathValue)) {
        selected.add(pathValue);
        reasons.push("изменён сам тест: " + pathValue);
        continue;
      }
      const sibling = testSibling(pathValue, tests);
      if (sibling.length) {
        for (const test of sibling) selected.add(test);
        reasons.push("тест рядом с изменённым файлом: " + pathValue);
      }

      const seen = new Set([pathValue]);
      let frontier = [pathValue];
      for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
        const next: string[] = [];
        for (const current of frontier) {
          for (const caller of reverse.get(current) ?? []) {
            if (seen.has(caller)) continue;
            seen.add(caller);
            if (tests.has(caller)) {
              selected.add(caller);
              reasons.push("тест вызывает изменённый файл через " + depth + " импорт(а/ов): " + caller);
            } else {
              next.push(caller);
            }
          }
        }
        frontier = next;
      }
    }
  }

  const all = [...selected].sort((a, b) => a.localeCompare(b));
  const result = all.slice(0, limit);
  return {
    tests: result,
    changed,
    reasons: [...new Set(reasons)].slice(0, 20),
    fullRun,
    truncated: all.length > result.length,
  };
}
