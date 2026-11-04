import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { copyArtifact, inspectArtifact } from "./artifact.js";
import { HostingError } from "./types.js";

const limits = { maxReleaseBytes: 1_000_000, maxFileBytes: 500_000, maxFiles: 100 };

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-artifact-"));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  }
  return root;
}

test("манифест считает файлы и не включает .env/node_modules/package.json", async t => {
  const root = await fixture({
    "index.html": "<html><body>ok</body></html>",
    "assets/app-abc123.js": "console.log('ok')",
    ".env": "SECRET=value",
    ".env.local": "SECRET=value",
    "package.json": "{}",
    "TASKS.md": "internal checklist",
    "node_modules/pkg/index.js": "x",
    "nested/index.html": "nested",
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = await inspectArtifact(root, { limits, projectRoot: root });
  assert.deepEqual(manifest.files.map(file => file.path), ["assets/app-abc123.js", "index.html", "nested/index.html"]);
  assert.equal(manifest.filesCount, 3);
  assert.equal(manifest.files.find(file => file.path === "index.html")?.bytes, 28);
  assert.equal(manifest.version, 1);
});

test("source map и известный секрет отвергаются до копирования", async t => {
  const root = await fixture({
    "index.html": "<html></html>",
    "assets/app.js.map": "{}",
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(() => inspectArtifact(root, { limits, projectRoot: root }), (error: unknown) => {
    assert.ok(error instanceof HostingError);
    assert.equal(error.code, "ARTIFACT_INVALID");
    return true;
  });

  const secretRoot = await fixture({
    "index.html": "<html></html>",
    "config.js": "const key = 'sk-abcdefghijklmnopqrstuvwxyz123456';",
  });
  t.after(() => rm(secretRoot, { recursive: true, force: true }));
  await assert.rejects(() => inspectArtifact(secretRoot, { limits, projectRoot: secretRoot }), /похожие на секрет/);
});

test("точное значение проектного секрета тоже не попадает в релиз", async t => {
  const root = await fixture({ "index.html": "<html></html>", "main.js": "const token = 'super-secret-token';" });
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    () => inspectArtifact(root, { limits, projectRoot: root, secretValues: ["super-secret-token"] }),
    /проектн|секрет/,
  );
});

test("жёсткая ссылка и FIFO запрещены", async t => {
  const root = await fixture({ "index.html": "<html></html>", "real.js": "x" });
  await link(path.join(root, "real.js"), path.join(root, "hard.js"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(() => inspectArtifact(root, { limits, projectRoot: root }), /Жёсткая ссылка/);

  const fifoRoot = await fixture({ "index.html": "<html></html>" });
  t.after(() => rm(fifoRoot, { recursive: true, force: true }));
  try {
    await promisify(execFile)("mkfifo", [path.join(fifoRoot, "pipe")]);
  } catch {
    t.skip("mkfifo недоступен на этой платформе");
    return;
  }
  await assert.rejects(() => inspectArtifact(fifoRoot, { limits, projectRoot: fifoRoot }), /обычные файлы/);
});

test("символическая ссылка запрещена", async t => {
  const root = await fixture({ "index.html": "<html></html>", "outside.txt": "x" });
  await symlink("outside.txt", path.join(root, "link.txt"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(() => inspectArtifact(root, { limits, projectRoot: root }), /Символическая ссылка/);
});

test("копирование создаёт только проверенные файлы и сохраняет содержимое", async t => {
  const root = await fixture({
    "index.html": "<html><body>copy</body></html>",
    "assets/a.css": "body{color:red}",
    ".env": "PRIVATE=1",
  });
  const destination = await mkdtemp(path.join(tmpdir(), "webnestdev-artifact-out-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(destination, { recursive: true, force: true }));
  const manifest = await inspectArtifact(root, { limits, projectRoot: root });
  await rm(destination, { recursive: true, force: true });
  await copyArtifact(root, destination, manifest, { limits, projectRoot: root });
  assert.equal(await readFile(path.join(destination, "index.html"), "utf8"), "<html><body>copy</body></html>");
  assert.equal(await readFile(path.join(destination, "assets/a.css"), "utf8"), "body{color:red}");
  await assert.rejects(() => readFile(path.join(destination, ".env"), "utf8"), /ENOENT/);
});

test("файл больше лимита и отсутствие index.html дают понятную ошибку", async t => {
  const root = await fixture({ "index.html": "x", "big.bin": "y".repeat(100) });
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    () => inspectArtifact(root, { limits: { ...limits, maxFileBytes: 10 }, projectRoot: root }),
    /больше лимита/,
  );
  const noIndex = await fixture({ "page.html": "x" });
  t.after(() => rm(noIndex, { recursive: true, force: true }));
  await assert.rejects(() => inspectArtifact(noIndex, { limits, projectRoot: noIndex }), /index.html/);
});
