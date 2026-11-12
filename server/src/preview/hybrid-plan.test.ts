import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxConfig } from "../sandbox-manager.js";
import { planHybridPreview } from "./hybrid-plan.js";

async function makeProject(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-hybrid-plan-"));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

function config(root: string): SandboxConfig {
  return { projectId: "hybrid-plan", root, memoryMb: 512, cpuLimit: 0.5, timeoutMs: 5_000 };
}

const packageJson = JSON.stringify({
  scripts: { build: "vite build", "start:preview-api": "node server.js" },
  preview: { mode: "hybrid", backend: "start:preview-api", staticDir: "dist", backendPaths: ["/api", "/ws"] },
});

test("hybrid plans a node-runtime project instead of refusing it as static", async () => {
  const root = await makeProject({
    "package.json": packageJson,
    "dist/index.html": "<html></html>",
  });
  try {
    const plan = await planHybridPreview(config(root));
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.dir, path.join(root, "dist"));
    assert.equal(plan.config.backendScript, "start:preview-api");
    assert.equal(plan.built, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hybrid names the configured static directory when it is not built yet", async () => {
  const root = await makeProject({ "package.json": packageJson });
  try {
    const plan = await planHybridPreview(config(root));
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.dir, path.join(root, "dist"));
    assert.equal(plan.built, false);
    assert.equal(plan.build, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a non-hybrid project is refused before a build or container is spent", async () => {
  const root = await makeProject({
    "package.json": JSON.stringify({ scripts: { build: "vite build", start: "node server.js" } }),
    "dist/index.html": "<html></html>",
  });
  try {
    const plan = await planHybridPreview(config(root));
    assert.equal(plan.ok, false);
    if (!plan.ok) assert.match(plan.reason, /preview\.mode/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
