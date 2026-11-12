import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectAndSaveHybridProfile, detectHybridCandidate } from "./hybrid-detect.js";
import { PREVIEW_PROFILE_PATH, readPreviewProfile } from "./hybrid-config.js";

async function makeProject(packageJson: unknown, files: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-hybrid-detect-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify(packageJson));
  for (const [name, content] of Object.entries({
    "dist/index.html": "<html></html>",
    "src/client.ts": 'fetch("/api/health");',
    ...files,
  })) {
    const full = path.join(root, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

const packageJson = {
  scripts: { build: "vite build", "start:preview-api": "node server.js" },
  dependencies: { vite: "^6.0.0" },
};

test("an obvious frontend with a dedicated backend and /api becomes a profile candidate", async () => {
  const root = await makeProject(packageJson);
  try {
    const result = await detectHybridCandidate(root);
    assert.equal(result.kind, "candidate");
    if (result.kind !== "candidate") return;
    assert.deepEqual(result.config, {
      buildScript: "build",
      staticDir: "dist",
      backendScript: "start:preview-api",
      backendPaths: ["/api"],
      backendPort: 3000,
      backendEnv: {},
    });
    assert.ok(result.evidence.some(item => item.includes("/api")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a generic start script is not treated as a separate backend", async () => {
  const root = await makeProject({
    ...packageJson,
    scripts: { build: "vite build", start: "node server.js" },
  });
  try {
    const result = await detectHybridCandidate(root);
    assert.equal(result.kind, "none");
    if (result.kind === "none") assert.match(result.reasons.join(" "), /backend-скрипта/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("no backend path evidence keeps the project on the ordinary preview", async () => {
  const root = await makeProject(packageJson, { "src/client.ts": 'fetch("/health");' });
  try {
    const result = await detectHybridCandidate(root);
    assert.equal(result.kind, "none");
    if (result.kind === "none") assert.match(result.reasons.join(" "), /backend-префикс/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit package preview is never overridden by auto-detection", async () => {
  const root = await makeProject({ ...packageJson, preview: { mode: "container" } });
  try {
    const result = await detectHybridCandidate(root);
    assert.equal(result.kind, "none");
    if (result.kind === "none") assert.match(result.reasons.join(" "), /preview-контракт/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saving a detected profile writes .webnestdev and excludes it from git", async () => {
  const root = await makeProject(packageJson);
  try {
    await mkdir(path.join(root, ".git", "info"), { recursive: true });
    await writeFile(path.join(root, ".git", "info", "exclude"), "user-rule\n");
    const packageBefore = await readFile(path.join(root, "package.json"), "utf8");
    const result = await detectAndSaveHybridProfile(root, "agent");
    assert.equal(result.kind, "configured");
    if (result.kind === "configured") assert.equal(result.saved, true);

    const profile = await readPreviewProfile(root);
    assert.equal(profile.kind, "configured");
    assert.equal((await readFile(path.join(root, "package.json"), "utf8")), packageBefore);
    const exclude = await readFile(path.join(root, ".git", "info", "exclude"), "utf8");
    assert.match(exclude, /\.webnestdev\//);
    assert.match(exclude, /user-rule/);
    assert.ok(await readFile(path.join(root, PREVIEW_PROFILE_PATH), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
