import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveChecks } from "./check-tools.js";

async function makeProject(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wnd-check-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

test("project.check по умолчанию выбирает npm run typecheck, если скрипт объявлен", async t => {
  const root = await makeProject({
    "package.json": JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await resolveChecks(root, { scripts: { typecheck: "tsc --noEmit" } }, { typecheck: true, lint: false });
  assert.deepEqual(result.checks, [{ name: "typecheck", command: "npm run typecheck" }]);
  assert.equal(result.skipped.length, 0);
});

test("project.check без скрипта использует локальный tsc, только когда он установлен", async t => {
  const root = await makeProject({
    "tsconfig.json": "{}",
    "node_modules/.bin/tsc": "",
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await resolveChecks(root, { scripts: {} }, { typecheck: true, lint: false });
  assert.deepEqual(result.checks, [{ name: "typecheck", command: "./node_modules/.bin/tsc --noEmit" }]);
});

test("project.check честно говорит not_configured вместо выдуманного tsc", async t => {
  const root = await makeProject({ "tsconfig.json": "{}" });
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await resolveChecks(root, { scripts: {} }, { typecheck: true, lint: false });
  assert.equal(result.checks.length, 0);
  assert.equal(result.skipped[0]?.status, "not_configured");
  assert.match(result.skipped[0]?.reason ?? "", /TypeScript не установлен/);
});

test("lint запускается только по объявленному скрипту", async t => {
  const root = await makeProject({ "package.json": JSON.stringify({ scripts: { lint: "eslint ." } }) });
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await resolveChecks(root, { scripts: { lint: "eslint ." } }, { typecheck: false, lint: true });
  assert.deepEqual(result.checks, [{ name: "lint", command: "npm run lint" }]);
});
