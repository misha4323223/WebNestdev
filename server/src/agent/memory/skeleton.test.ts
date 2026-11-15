import test from "node:test";
import assert from "node:assert/strict";
import { architectureSkeleton } from "./skeleton.js";
import type { RepoIndex } from "../repo-index/types.js";

function index(): RepoIndex {
  return {
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    fingerprint: "abc123",
    limits: { maxFiles: 100, maxFileBytes: 1000, maxTotalBytes: 10_000 },
    files: [],
    packages: [{ name: "@app/api", dir: "apps/api", entry: "apps/api/src/main.ts" }],
    entryPoints: ["apps/api/src/main.ts"],
    tests: ["apps/api/src/main.test.ts"],
    stats: {
      files: 2,
      sourceFiles: 2,
      textFiles: 2,
      truncated: false,
      skipped: { dirs: 0, binary: 0, large: 0, secret: 0, symlink: 0, unsupported: 0 },
    },
  };
}

test("скелет собирается из метаданных и оставляет границы на ревью", () => {
  const text = architectureSkeleton(index());
  assert.match(text, /# Architecture/);
  assert.match(text, /@app\/api/);
  assert.match(text, /apps\/api\/src\/main\.ts/);
  assert.match(text, /## Boundaries/);
  assert.match(text, /TODO/);
  assert.match(text, /abc123/);
  assert.doesNotMatch(text, /secret|password/i);
});
