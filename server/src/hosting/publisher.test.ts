import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxConfig } from "../sandbox-manager.js";
import type { HostingSite } from "./types.js";
import { buildStatic } from "./publisher.js";

function config(root: string): SandboxConfig {
  return { projectId: "hosting-publisher", root, memoryMb: 512, cpuLimit: 0.5, timeoutMs: 5000 };
}

async function project(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-hosting-publisher-"));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

test("static-functions with ready files skips npm install and npm run build", async () => {
  const root = await project({
    "package.json": JSON.stringify({ private: true, type: "module" }),
    "index.html": "<html></html>",
    "nestdev.functions.json": JSON.stringify({ functions: [], jobs: [] }),
  });
  try {
    const result = await buildStatic(config(root), {} as HostingSite, []);
    assert.equal(result.sourceDir, root);
    assert.match(result.log, /Сборка не требуется/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
