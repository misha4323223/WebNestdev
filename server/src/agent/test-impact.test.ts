import test from "node:test";
import assert from "node:assert/strict";
import { affectedTests } from "./test-impact.js";
import type { RepoIndex, RepoFile } from "./repo-index/types.js";

function file(path: string, imports: Array<{ target?: string }> = []): RepoFile {
  return {
    path,
    language: path.endsWith(".py") ? "python" : "ts",
    bytes: 10,
    lines: 1,
    imports: imports.map((item, index) => ({
      specifier: item.target ?? "external-" + index,
      ...(item.target ? { target: item.target } : {}),
      external: !item.target,
    })),
    symbols: [],
  };
}

function index(files: RepoFile[], tests: string[]): RepoIndex {
  return {
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    fingerprint: "test",
    limits: { maxFiles: 100, maxFileBytes: 1000, maxTotalBytes: 10_000 },
    files,
    packages: [],
    entryPoints: [],
    tests,
    stats: {
      files: files.length,
      sourceFiles: files.length,
      textFiles: files.length,
      truncated: false,
      skipped: { dirs: 0, binary: 0, large: 0, secret: 0, symlink: 0, unsupported: 0 },
    },
  };
}

const service = file("src/service.ts");
const app = file("src/app.ts", [{ target: "src/service.ts" }]);
const appTest = file("src/app.test.ts", [{ target: "src/app.ts" }]);
const helper = file("src/helper.ts");
const helperTest = file("src/helper.test.ts", [{ target: "src/helper.ts" }]);
const newTest = file("src/new.test.ts");
const fixture = index([service, app, appTest, helper, helperTest, newTest, file("package.json")], [
  "src/app.test.ts",
  "src/helper.test.ts",
  "src/new.test.ts",
]);

test("изменение сервиса поднимает тест через два импорта", () => {
  const result = affectedTests(fixture, ["src/service.ts"]);
  assert.deepEqual(result.tests, ["src/app.test.ts"]);
  assert.match(result.reasons.join(" "), /2 импорт/);
  assert.equal(result.fullRun, false);
});

test("прямой тест и изменённый тест не теряются", () => {
  assert.deepEqual(affectedTests(fixture, ["src/helper.ts"]).tests, ["src/helper.test.ts"]);
  assert.deepEqual(affectedTests(fixture, ["src/helper.test.ts"]).tests, ["src/helper.test.ts"]);
});

test("package.json включает полный набор, потому что сужение небезопасно", () => {
  const result = affectedTests(fixture, ["package.json"]);
  assert.deepEqual(result.tests, ["src/app.test.ts", "src/helper.test.ts", "src/new.test.ts"]);
  assert.equal(result.fullRun, true);
});

test("новый файл находит соседний тест, даже если его ещё нет в графе", () => {
  const result = affectedTests(fixture, ["src/new.ts"]);
  assert.deepEqual(result.tests, ["src/new.test.ts"]);
  assert.deepEqual(affectedTests(fixture, ["src/helper.ts"], { maxDepth: 0 }).tests, ["src/helper.test.ts"]);
});

test("лимит честно помечает усечение", () => {
  const result = affectedTests(fixture, ["package.json"], { limit: 1 });
  assert.equal(result.tests.length, 1);
  assert.equal(result.truncated, true);
});
