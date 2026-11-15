import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanProject } from "./scan.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "wnd-index-scan-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await mkdir(path.join(root, ".webnestdev"), { recursive: true });
  await mkdir(path.join(root, "assets"), { recursive: true });
  await writeFile(path.join(root, "src", "app.ts"), "export const app = 1;\n");
  await writeFile(path.join(root, "src", "helper.ts"), "export function helper() {}\n");
  await writeFile(path.join(root, "node_modules", "pkg", "index.ts"), "export const hidden = 1;\n");
  await writeFile(path.join(root, ".webnestdev", "cache.json"), "{}\n");
  await writeFile(path.join(root, ".env.local"), "SECRET=1\n");
  await writeFile(path.join(root, "assets", "logo.png"), "not really a png\n");
  await writeFile(path.join(root, "README.md"), "# Project\n");
  return root;
}

test("сканер берёт исходники и конфиги, но не зависимости, секреты и служебный кэш", async () => {
  const root = await fixture();
  const result = await scanProject(root, { maxFiles: 100, maxFileBytes: 10_000 });
  assert.deepEqual(result.files.map(file => file.path), [
    "README.md",
    "src/app.ts",
    "src/helper.ts",
  ]);
  assert.equal(result.stats.sourceFiles, 2);
  assert.equal(result.stats.skipped.secret, 1);
  assert.equal(result.stats.skipped.binary + result.stats.skipped.unsupported, 1);
  assert.ok(result.stats.skipped.dirs >= 2);
});

test("символическая ссылка не попадает в индекс", async () => {
  const root = await fixture();
  const outside = await mkdtemp(path.join(tmpdir(), "wnd-index-outside-"));
  await writeFile(path.join(outside, "secret.ts"), "export const stolen = 1;\n");
  try {
    await symlink(path.join(outside, "secret.ts"), path.join(root, "src", "link.ts"));
  } catch {
    return; // Windows без прав: остальные проверки уже покрывают безопасность пути.
  }
  const result = await scanProject(root, { maxFiles: 100, maxFileBytes: 10_000 });
  assert.equal(result.files.some(file => file.path === "src/link.ts"), false);
  assert.ok(result.stats.skipped.symlink >= 1);
});

test("лимит файлов и размера честно помечается, fingerprint меняется вместе с проектом", async () => {
  const root = await fixture();
  const first = await scanProject(root, { maxFiles: 2, maxFileBytes: 10_000 });
  assert.equal(first.files.length, 2);
  assert.equal(first.stats.truncated, true);

  const before = await scanProject(root, { maxFiles: 100, maxFileBytes: 10_000 });
  await new Promise(resolve => setTimeout(resolve, 5));
  await writeFile(path.join(root, "src", "app.ts"), "export const app = 2;\n");
  const after = await scanProject(root, { maxFiles: 100, maxFileBytes: 10_000 });
  assert.notEqual(before.fingerprint, after.fingerprint);

  const tooLarge = await scanProject(root, { maxFiles: 100, maxFileBytes: 4 });
  assert.equal(tooLarge.files.some(file => file.path === "src/app.ts"), false);
  assert.ok(tooLarge.stats.skipped.large >= 1);

  const totalLimit = await scanProject(root, { maxFiles: 100, maxFileBytes: 10_000, maxTotalBytes: 15 });
  assert.equal(totalLimit.files.length, 1);
  assert.equal(totalLimit.stats.truncated, true);
});
