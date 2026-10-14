import test from "node:test";
import assert from "node:assert/strict";
import { mkdir,mkdtemp,rm,utimes,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxConfig } from "../sandbox-manager.js";
import { isStaticBuildFresh,newestSourceMtime,planStaticPreview } from "./static-plan.js";

async function project(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-static-plan-"));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

function config(root: string): SandboxConfig {
  return { projectId: "static-plan", root, memoryMb: 512, cpuLimit: 0.5, timeoutMs: 5000 };
}

/** Filesystem timestamps are compared in seconds, so the tests set them explicitly. */
async function setMtime(file: string, seconds: number) {
  await utimes(file, seconds, seconds);
}

const buildScript = JSON.stringify({ scripts: { build: "vite build" } });

test("a project that already built is served from its output directory", async () => {
  const root = await project({ "package.json": buildScript, "dist/index.html": "<html></html>" });
  try {
    assert.deepEqual(await planStaticPreview(config(root)), { ok: true, dir: path.join(root, "dist"), built: true, build: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a build output other than dist is still found", async () => {
  const root = await project({ "package.json": buildScript, "build/index.html": "<html></html>" });
  try {
    assert.deepEqual(await planStaticPreview(config(root)), { ok: true, dir: path.join(root, "build"), built: true, build: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nothing built yet points at the directory the build is expected to fill", async () => {
  const root = await project({ "package.json": buildScript });
  try {
    assert.deepEqual(await planStaticPreview(config(root)), { ok: true, dir: path.join(root, "dist"), built: false, build: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a plain HTML/CSS/JS project is served as is, with no build and no container", async () => {
  const root = await project({ "index.html": "<html></html>", "app.js": "console.log(1)" });
  try {
    assert.deepEqual(await planStaticPreview(config(root)), { ok: true, dir: root, built: true, build: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("files already present in dist are served even without a build script", async () => {
  const root = await project({ "dist/index.html": "<html></html>", "dist/app.js": "" });
  try {
    assert.deepEqual(await planStaticPreview(config(root)), { ok: true, dir: path.join(root, "dist"), built: true, build: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a build script wins over a root index.html: the template is not the app", async () => {
  const root = await project({ "package.json": buildScript, "index.html": "<div id=root></div>" });
  try {
    assert.deepEqual(await planStaticPreview(config(root)), { ok: true, dir: path.join(root, "dist"), built: false, build: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a project with neither files nor a build is refused, with the detector's reason", async () => {
  const root = await project({ "package.json": JSON.stringify({ scripts: { dev: "vite" } }) });
  try {
    const plan = await planStaticPreview(config(root));
    assert.equal(plan.ok, false);
    if (plan.ok) return;
    assert.match(plan.reason, /без скрипта сборки/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an empty project is refused with a reason that names the problem", async () => {
  const root = await project({ "README.md": "# пусто" });
  try {
    const plan = await planStaticPreview(config(root));
    assert.equal(plan.ok, false);
    if (plan.ok) return;
    assert.match(plan.reason, /тип проекта/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a server project is refused before anything is built, so no container is spent on it", async () => {
  const root = await project({
    "package.json": JSON.stringify({ scripts: { build: "tsc", start: "node dist/server.js" }, dependencies: { express: "^5.0.0" } }),
  });
  try {
    const plan = await planStaticPreview(config(root));
    assert.equal(plan.ok, false);
    if (plan.ok) return;
    assert.match(plan.reason, /express/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PREVIEW_STATIC_DIR replaces the usual candidate directories", async () => {
  const root = await project({ "package.json": buildScript, "site/index.html": "<html></html>" });
  const previous = process.env.PREVIEW_STATIC_DIR;
  process.env.PREVIEW_STATIC_DIR = "site";
  try {
    assert.deepEqual(await planStaticPreview(config(root)), { ok: true, dir: path.join(root, "site"), built: true, build: true });
  } finally {
    if (previous === undefined) delete process.env.PREVIEW_STATIC_DIR;
    else process.env.PREVIEW_STATIC_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("a source newer than the build makes it stale, and a recorded build time wins", async () => {
  const root = await project({ "package.json": buildScript, "dist/index.html": "<html></html>", "src/main.ts": "export {}" });
  try {
    const dir = path.join(root, "dist");
    const source = path.join(root, "src/main.ts");
    // package.json is a source too: changing the build script must invalidate the output.
    await setMtime(path.join(root, "package.json"), 500);
    await setMtime(source, 1000);
    await setMtime(path.join(dir, "index.html"), 2000);
    assert.equal(await isStaticBuildFresh(root, dir), true);

    await setMtime(source, 5000);
    assert.equal(await isStaticBuildFresh(root, dir), false);
    // A build this process ran is newer than any source, whatever index.html says: the
    // recorded time is a Date.now() value, so it is given in milliseconds.
    assert.equal(await isStaticBuildFresh(root, dir, 6_000_000), true);

    await rm(dir, { recursive: true, force: true });
    assert.equal(await isStaticBuildFresh(root, dir), false, "отсутствующая сборка не может быть свежей");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the freshness scan ignores node_modules and the previous build", async () => {
  const root = await project({
    "package.json": buildScript,
    "dist/index.html": "<html></html>",
    "node_modules/pkg/index.js": "module.exports = 1",
    "src/app.ts": "export const app = 1",
  });
  try {
    await setMtime(path.join(root, "package.json"), 1000);
    await setMtime(path.join(root, "node_modules/pkg/index.js"), 9000);
    await setMtime(path.join(root, "dist/index.html"), 9000);
    await setMtime(path.join(root, "src/app.ts"), 3000);
    const newest = await newestSourceMtime(root, path.join(root, "dist"));
    assert.equal(Math.round(newest / 1000), 3000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
