import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readHybridConfig } from "./hybrid-config.js";

async function project(packageJson: unknown) {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-hybrid-config-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify(packageJson));
  return root;
}

function packageWith(preview: unknown) {
  return {
    scripts: {
      build: "vite build",
      "start:preview-api": "node server.js",
    },
    preview,
  };
}

test("hybrid config is explicit and resolves npm scripts", async () => {
  const root = await project(packageWith({
    mode: "hybrid",
    staticDir: "dist",
    backend: "start:preview-api",
    backendPaths: ["/api", "/ws"],
    backendPort: 3100,
    backendEnv: { NODE_ENV: "production" },
  }));
  try {
    const result = await readHybridConfig(root);
    assert.equal(result.kind, "configured");
    if (result.kind !== "configured") return;
    assert.deepEqual(result.config, {
      buildScript: "build",
      staticDir: "dist",
      backendScript: "start:preview-api",
      backendPaths: ["/api", "/ws"],
      backendPort: 3100,
      backendEnv: { NODE_ENV: "production" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a project without preview.mode=hybrid is not a hybrid candidate", async () => {
  const root = await project(packageWith({ mode: "static", backend: "start:preview-api" }));
  try {
    assert.deepEqual(await readHybridConfig(root), { kind: "absent" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backend must be an existing npm script, not an arbitrary command", async () => {
  const root = await project({ scripts: { build: "vite build" }, preview: { mode: "hybrid", backend: "sh -c whoami" } });
  try {
    const result = await readHybridConfig(root);
    assert.equal(result.kind, "invalid");
    if (result.kind === "invalid") assert.match(result.reason, /npm-скрипта/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing build and escaping staticDir are refused", async () => {
  const root = await project({ scripts: { "start:preview-api": "node server.js" }, preview: { mode: "hybrid", backend: "start:preview-api" } });
  try {
    const result = await readHybridConfig(root);
    assert.equal(result.kind, "invalid");
    if (result.kind === "invalid") assert.match(result.reason, /build/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const root2 = await project(packageWith({ mode: "hybrid", backend: "start:preview-api", staticDir: "../outside" }));
  try {
    const result = await readHybridConfig(root2);
    assert.equal(result.kind, "invalid");
    if (result.kind === "invalid") assert.match(result.reason, /staticDir/);
  } finally {
    await rm(root2, { recursive: true, force: true });
  }
});

test("backendPaths uses prefix boundaries and rejects the site root", async () => {
  const root = await project(packageWith({ mode: "hybrid", backend: "start:preview-api", backendPaths: ["/"] }));
  try {
    const result = await readHybridConfig(root);
    assert.equal(result.kind, "invalid");
    if (result.kind === "invalid") assert.match(result.reason, /backend path/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
