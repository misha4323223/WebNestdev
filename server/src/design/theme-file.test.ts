import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { findThemeFile } from "./theme-file.js";

async function project() {
  return await mkdtemp(path.join(tmpdir(), "nestdev-theme-"));
}

test("findThemeFile prefers theme.css in the project root", async () => {
  const root = await project();
  await writeFile(path.join(root, "theme.css"), ":root{--color-bg:#000000;}");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/theme.css"), ":root{--color-bg:#ffffff;}");
  const found = await findThemeFile(root);
  assert.equal(found?.file, "theme.css");
  assert.match(found?.css ?? "", /#000000/);
});

test("findThemeFile falls back to src/theme.css for a bundler project", async () => {
  const root = await project();
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/theme.css"), ":root{--color-accent:#112233;}");
  const found = await findThemeFile(root);
  assert.equal(found?.file, "src/theme.css");
});

test("findThemeFile returns null when the project has no theme", async () => {
  const root = await project();
  await writeFile(path.join(root, "index.html"), "<!doctype html>");
  assert.equal(await findThemeFile(root), null);
});

test("findThemeFile refuses a theme that links outside the project", async () => {
  const root = await project();
  const outside = await project();
  const secret = path.join(outside, "theme.css");
  await writeFile(secret, ":root{--color-bg:#123456;}");
  await symlink(secret, path.join(root, "theme.css"));
  assert.equal(await findThemeFile(root), null);
});

test("findThemeFile skips a theme larger than the panel can show", async () => {
  const root = await project();
  await writeFile(path.join(root, "theme.css"), ":root{--color-bg:#000000;}" + " ".repeat(500));
  assert.equal(await findThemeFile(root, 100), null);
  assert.ok(await findThemeFile(root));
});
