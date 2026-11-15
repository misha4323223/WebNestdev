import test from "node:test";
import assert from "node:assert/strict";
import { findRelevantFiles, resolveSearchScope } from "./query.js";
import type { RepoIndex } from "./types.js";

function index(): RepoIndex {
  return {
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    fingerprint: "test",
    limits: { maxFiles: 100, maxFileBytes: 1000, maxTotalBytes: 10_000 },
    files: [
      { path: "src/app.ts", language: "ts", bytes: 10, lines: 1, imports: [{ specifier: "./service", target: "src/service.ts", external: false }], symbols: ["app"] },
      { path: "src/service.ts", language: "ts", bytes: 10, lines: 1, imports: [], symbols: ["loadOrders"] },
      { path: "packages/ui/src/index.ts", language: "ts", bytes: 10, lines: 1, imports: [], symbols: ["Button"] },
      { path: "src/app.test.ts", language: "ts", bytes: 10, lines: 1, imports: [{ specifier: "./service", target: "src/service.ts", external: false }], symbols: [] },
    ],
    packages: [{ name: "@shop/ui", dir: "packages/ui", entry: "packages/ui/src/index.ts" }],
    entryPoints: ["src/app.ts"],
    tests: ["src/app.test.ts"],
    stats: {
      files: 4,
      sourceFiles: 4,
      textFiles: 4,
      truncated: false,
      skipped: { dirs: 0, binary: 0, large: 0, secret: 0, symlink: 0, unsupported: 0 },
    },
  };
}

test("scope разрешает имя пакета, каталог и отвергает выход из проекта", () => {
  assert.deepEqual(resolveSearchScope(index(), "@shop/ui"), { path: "packages/ui", label: "@shop/ui" });
  assert.deepEqual(resolveSearchScope(index(), "src"), { path: "src", label: "src" });
  assert.equal(resolveSearchScope(index(), "missing"), undefined);
  assert.equal(resolveSearchScope(index(), "../etc"), undefined);
});

test("нечёткий запрос возвращает ограниченные ориентиры, а не пустоту", () => {
  const found = findRelevantFiles(index(), "сделай красиво", { limit: 5 });
  assert.ok(found.length > 0);
  assert.ok(found.length <= 5);
  assert.ok(found.some(item => item.path === "src/app.ts"));
});
