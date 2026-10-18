import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxConfig } from "../sandbox/sandbox-types.js";

const dataRoot = await mkdtemp(path.join(tmpdir(), "wnd-preview-secrets-data-"));
const sandboxRoot = path.join(dataRoot, "sandboxes");
process.env.WEBNESTDEV_DATA_DIR = dataRoot;
process.env.WEBNESTDEV_SANDBOX_DIR = sandboxRoot;

const { saveProjectSecrets } = await import("./project-secrets.js");
const { previewSecretMounts, clearAllPreviewSecrets, clearPreviewSecrets } = await import("./preview-secrets.js");

function config(projectId: string): SandboxConfig {
  return {
    projectId,
    root: path.join(sandboxRoot, projectId),
    hostRoot: path.join(sandboxRoot, projectId),
    memoryMb: 256,
    cpuLimit: 1,
    timeoutMs: 1000,
  };
}

test("секреты монтируются в предпросмотр read-only и лежат вне проекта", async () => {
  const projectId = "preview-one";
  const sandbox = config(projectId);
  await mkdir(sandbox.root, { recursive: true });
  await saveProjectSecrets(projectId, sandbox.root, { TOKEN: "secret-value", MULTILINE: "a\nb" });

  const mounts = await previewSecretMounts(sandbox);
  try {
    assert.equal(mounts.mounts.length, 2);
    assert.equal(mounts.mounts[0], "-v");
    const [source, target] = mounts.mounts[1].split(":/workspace/");
    assert.equal(target, ".env.local:ro");
    assert.ok(!source.startsWith(sandbox.root), "временный файл не должен лежать в проекте");
    const content = await readFile(source, "utf8");
    assert.match(content, /TOKEN=secret-value/);
    assert.match(content, /MULTILINE="a\\nb"/);
    // Цель bind-mount должна существовать файлом: Docker не создаёт её за нас.
    assert.equal(await readFile(path.join(sandbox.root, ".env.local"), "utf8"), "");
  } finally {
    await mounts.cleanup();
  }
  await assert.rejects(() => readFile(path.join(sandboxRoot, ".secret-runtime", projectId, ".env.local")), /ENOENT/);
});

test("дополнительные env-файлы монтируются по своим путям", async () => {
  const projectId = "preview-many";
  const sandbox = config(projectId);
  await mkdir(sandbox.root, { recursive: true });
  await saveProjectSecrets(projectId, sandbox.root, { LOCAL: "1" }, ".env.local");
  await saveProjectSecrets(projectId, sandbox.root, { PROD: "2" }, ".env.production");

  const mounts = await previewSecretMounts(sandbox);
  try {
    const targets = mounts.mounts.filter((value, index) => index % 2 === 1).map(value => value.slice(value.indexOf(":/workspace/")));
    assert.deepEqual(targets.sort(), [":/workspace/.env.local:ro", ":/workspace/.env.production:ro"].sort());
    assert.equal(await readFile(path.join(sandbox.root, ".env.local"), "utf8"), "");
    assert.equal(await readFile(path.join(sandbox.root, ".env.production"), "utf8"), "");
  } finally {
    await mounts.cleanup();
  }
});

test("без секретов предпросмотр не монтирует ничего и убирает старый файл", async () => {
  const projectId = "preview-empty";
  const sandbox = config(projectId);
  await mkdir(sandbox.root, { recursive: true });
  const staleDir = path.join(sandboxRoot, ".secret-runtime", projectId);
  await mkdir(staleDir, { recursive: true });
  await writeFile(path.join(staleDir, ".env.local"), "OLD=1\n");

  const mounts = await previewSecretMounts(sandbox);
  assert.deepEqual(mounts.mounts, []);
  await assert.rejects(() => readFile(path.join(staleDir, ".env.local")), /ENOENT/);
});

test("очистка убирает все временные файлы", async () => {
  const id = "preview-all";
  const dir = path.join(sandboxRoot, ".secret-runtime", id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, ".env.local"), "A=1\n");
  await clearPreviewSecrets(id);
  await assert.rejects(() => readFile(path.join(dir, ".env.local")), /ENOENT/);

  const other = path.join(sandboxRoot, ".secret-runtime", "other");
  await mkdir(other, { recursive: true });
  await writeFile(path.join(other, ".env.local"), "B=1\n");
  await clearAllPreviewSecrets();
  await assert.rejects(() => readFile(path.join(other, ".env.local")), /ENOENT/);
});
