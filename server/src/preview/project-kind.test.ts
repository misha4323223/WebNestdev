import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifyProject, detectProject, type ProjectFiles } from "./project-kind.js";

function files(overrides: Partial<ProjectFiles> & { entries: string[] }): ProjectFiles {
  return overrides;
}

async function project(entries: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-project-kind-"));
  for (const [name, content] of Object.entries(entries)) {
    const full = path.join(root, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

test("plain HTML/CSS/JS is an instant site: no build, no container", () => {
  const shape = classifyProject(files({ entries: ["index.html", "styles.css", "app.js", "assets"], staticEntry: "index.html" }));
  assert.equal(shape.kind, "instant-site");
  assert.match(shape.reason, /без сборки/);
  assert.deepEqual(shape.evidence, ["index.html"]);
});

test("one file is never the whole answer: package.json with a build script is a build, not a runtime", () => {
  const shape = classifyProject(files({
    entries: ["package.json", "vite.config.ts", "src"],
    packageJson: { scripts: { build: "vite build", dev: "vite" }, devDependencies: { vite: "^8.0.0" } },
  }));
  assert.equal(shape.kind, "static-build");
  assert.ok(shape.evidence.includes("scripts.build: vite build"));
  assert.ok(shape.evidence.includes("vite"));
});

test("a dependency that answers HTTP makes it a runtime even with a build script", () => {
  const shape = classifyProject(files({
    entries: ["package.json", "src"],
    packageJson: { scripts: { build: "tsc", start: "node dist/server.js" }, dependencies: { express: "^5.0.0" } },
  }));
  assert.equal(shape.kind, "node-runtime");
  assert.ok(shape.evidence.includes("express"));
});

test("a start command alone is enough to need a running process", () => {
  const shape = classifyProject(files({
    entries: ["package.json", "server.mjs"],
    packageJson: { scripts: { start: "node server.mjs" } },
  }));
  assert.equal(shape.kind, "node-runtime");
  assert.match(shape.evidence.join(" "), /start: node server\.mjs/);
});

test("Next.js in server mode is a runtime, while output: export is a static build", () => {
  const runtime = classifyProject(files({
    entries: ["package.json", "next.config.mjs", "app"],
    packageJson: { scripts: { build: "next build", start: "next start" }, dependencies: { next: "^15.0.0" } },
  }));
  assert.equal(runtime.kind, "node-runtime");

  const exported = classifyProject(files({
    entries: ["package.json", "next.config.mjs", "app"],
    packageJson: { scripts: { build: "next build", start: "next start" }, dependencies: { next: "^15.0.0" } },
    configText: "const config = { output: 'export' }; export default config;",
  }));
  assert.equal(exported.kind, "static-build", "next с output: export отдаётся файлами, а не процессом");
});

test("framework dev servers that only serve files don't buy a container", () => {
  const astro = classifyProject(files({
    entries: ["package.json", "astro.config.mjs", "src"],
    packageJson: { scripts: { build: "astro build", dev: "astro dev" }, devDependencies: { astro: "^5.0.0" } },
  }));
  assert.equal(astro.kind, "static-build", "astro и vite отдают файлы: контейнер не нужен");
});

test("an external file server wrapper is not a reason to start a container", () => {
  const shape = classifyProject(files({
    entries: ["package.json", "dist/index.html"],
    packageJson: { scripts: { start: "serve dist" }, dependencies: { serve: "^14.0.0" } },
    staticEntry: "dist/index.html",
  }));
  assert.equal(shape.kind, "instant-site", "готовые файлы в dist отдаём сами, без процесса");
  assert.deepEqual(shape.evidence, ["dist/index.html"]);
});

test("a Python project with a web framework needs a process", () => {
  const shape = classifyProject(files({
    entries: ["requirements.txt", "main.py"],
    pythonManifest: "fastapi==0.115.0\nuvicorn==0.30.0\n",
  }));
  assert.equal(shape.kind, "python-runtime");
  assert.match(shape.reason, /fastapi/);
});

test("a Python manifest without a framework is still a process, not a page", () => {
  const shape = classifyProject(files({ entries: ["pyproject.toml", "script.py"], pythonManifest: "[project]\nname = \"probe\"\n" }));
  assert.equal(shape.kind, "python-runtime");
});

test("a Dockerfile is reported but never used to run the project", () => {
  const shape = classifyProject(files({
    entries: ["Dockerfile", "docker-compose.yml", "package.json", "src"],
    packageJson: { scripts: { build: "vite build" }, devDependencies: { vite: "^8.0.0" } },
  }));
  assert.equal(shape.userDockerfile, true);
  assert.equal(shape.kind, "static-build", "наличие Dockerfile не меняет выбранный режим");
  assert.match(shape.evidence.join(" "), /Dockerfile \(не запускаем/);
});

test("an empty or unrecognised project is unknown, not silently static", () => {
  const empty = classifyProject(files({ entries: ["README.md"] }));
  assert.equal(empty.kind, "unknown");
  const packageOnly = classifyProject(files({ entries: ["package.json"], packageJson: { name: "probe" } }));
  assert.equal(packageOnly.kind, "unknown");
  assert.match(packageOnly.reason, /без скрипта сборки/);
});

test("detectProject reads the same answer from a real directory", async () => {
  const root = await project({
    "package.json": JSON.stringify({ scripts: { build: "vite build" }, devDependencies: { vite: "^8.0.0" } }),
    "vite.config.ts": "export default {};",
    "src/main.ts": "export {};",
  });
  try {
    const shape = await detectProject(root);
    assert.equal(shape.kind, "static-build");
    assert.equal(shape.userDockerfile, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detectProject finds a static site that has no package.json at all", async () => {
  const root = await project({ "index.html": "<html></html>", "app.js": "console.log(1)" });
  try {
    const shape = await detectProject(root);
    assert.equal(shape.kind, "instant-site");
    assert.deepEqual(shape.evidence, ["index.html"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detectProject sees a ready build output inside dist", async () => {
  const root = await project({ "dist/index.html": "<html></html>", "vendor/lib.js": "" });
  try {
    const shape = await detectProject(root);
    assert.equal(shape.kind, "instant-site");
    assert.deepEqual(shape.evidence, ["dist/index.html"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
