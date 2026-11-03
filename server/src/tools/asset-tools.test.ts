import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { auditAssets } from "./asset-tools.js";

test("project.assets находит ассет без literal-ссылки и не трогает используемый", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wnd-assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "public", "images"), { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "public", "images", "hero.png"), "used");
  await writeFile(path.join(root, "public", "images", "dead.png"), "unused");
  await writeFile(path.join(root, "src", "App.tsx"), 'export const hero = "/images/hero.png";\n');
  await writeFile(path.join(root, "index.html"), '<img src="/images/hero.png">\n');

  const result = await auditAssets(root);
  assert.equal(result.assets, 2);
  assert.deepEqual(result.unused.map(asset => asset.path), ["public/images/dead.png"]);
  assert.equal(result.unusedBytes, 6);
  assert.match(result.note, /динамическ|переменн/);
});
