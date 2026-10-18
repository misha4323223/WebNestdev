import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { findSecretEnvFiles, secretEnvMaskMounts } from "./secret-mask.js";
import type { SandboxConfig } from "./sandbox-types.js";

async function projectWithFiles() {
  const root = await mkdtemp(path.join(tmpdir(), "wnd-mask-"));
  await writeFile(path.join(root, ".env"), "SECRET=1\n");
  await writeFile(path.join(root, ".env.local"), "LOCAL=1\n");
  await writeFile(path.join(root, ".env.example"), "PUBLIC=\n");
  await mkdir(path.join(root, "apps", "web"), { recursive: true });
  await writeFile(path.join(root, "apps", "web", ".env.production"), "PROD=1\n");
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "pkg", ".env"), "DEP=1\n");
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "dist", ".env"), "BUILD=1\n");
  return root;
}

function configFor(root: string): SandboxConfig {
  return { projectId: "p1", root, memoryMb: 256, cpuLimit: 1, timeoutMs: 1000 };
}

test("находит секретные env-файлы рекурсивно и не трогает шаблоны и node_modules", async () => {
  const root = await projectWithFiles();
  const files = await findSecretEnvFiles(root);
  assert.deepEqual(files.sort(), [".env", ".env.local", "apps/web/.env.production"]);
});

test("каждый секретный файл перекрывается пустым read-only файлом", async () => {
  const root = await projectWithFiles();
  const mounts = await secretEnvMaskMounts(configFor(root));
  assert.equal(mounts.length % 2, 0);
  const pairs: string[] = [];
  for (let index = 0; index < mounts.length; index += 2) {
    assert.equal(mounts[index], "-v");
    pairs.push(mounts[index + 1]);
  }
  assert.deepEqual(
    pairs.map((value) => value.slice(value.indexOf(":/workspace/"))).sort(),
    [":/workspace/.env:ro", ":/workspace/.env.local:ro", ":/workspace/apps/web/.env.production:ro"].sort(),
  );
  const source = pairs[0].slice(0, pairs[0].indexOf(":/workspace/"));
  assert.equal((await stat(source)).size, 0);
  assert.equal(await readFile(source, "utf8"), "");
  assert.ok(pairs.every((value) => value.endsWith(":ro")));
});

test("без секретных файлов масок нет", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wnd-mask-empty-"));
  await writeFile(path.join(root, ".env.example"), "PUBLIC=\n");
  assert.deepEqual(await secretEnvMaskMounts(configFor(root)), []);
});

test("путь с двоеточием не даёт выполнить команду без маски", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wnd-mask-colon-"));
  await writeFile(path.join(root, ".env.:prod"), "SECRET=1\n");
  await assert.rejects(() => secretEnvMaskMounts(configFor(root)), /переименуйте/i);
});
