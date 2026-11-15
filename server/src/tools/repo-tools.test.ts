import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dataRoot = await mkdtemp(path.join(tmpdir(), "wnd-repo-tools-"));
process.env.WEBNESTDEV_DATA_DIR = dataRoot;
process.env.WEBNESTDEV_SANDBOX_DIR = path.join(dataRoot, "sandboxes");

const { createProject } = await import("../project-store.js");
const { sandboxRootPath } = await import("../sandbox/config.js");
const { retrieveRelevantFiles } = await import("../agent/context-retrieval.js");
const { buildProjectContext } = await import("../agent/context-builder.js");
await import("./repo-tools.js");
await import("./filesystem-tools.js");
await import("./memory-tools.js");
const { getTool } = await import("../tool-registry.js");

const project = await createProject("Repo tools", undefined, "u1");
const context = { projectId: project.id, userId: "u1", runId: "run-repo" };
const root = sandboxRootPath(project.id);
await mkdir(path.join(root, "src"), { recursive: true });
await mkdir(path.join(root, "packages", "ui", "src"), { recursive: true });
await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "demo", private: true, workspaces: ["packages/*"] }));
await writeFile(path.join(root, "src", "service.ts"), 'export function loadOrders() { return ["order"]; }\n');
await writeFile(path.join(root, "src", "app.ts"), 'import { loadOrders } from "./service";\nexport const app = loadOrders();\n');
await writeFile(path.join(root, "src", "shared.ts"), "export function Button() { return null; }\n");
await writeFile(path.join(root, "packages", "ui", "package.json"), JSON.stringify({ name: "@shop/ui", main: "src/index.ts" }));
await writeFile(path.join(root, "packages", "ui", "src", "index.ts"), "export function Button() { return null; }\n");
await writeFile(path.join(root, "ARCHITECTURE.md"), "# Architecture\n\nAPI and UI share the order service.\n");
await writeFile(path.join(root, ".env.local"), "SECRET=must-not-appear\n");

async function call(name: string, input: unknown) {
  const tool = getTool(name);
  assert.ok(tool?.execute, name + " не зарегистрирован");
  return tool.execute(input, context);
}

test("repo.map отдаёт компактную карту проекта", async () => {
  const map = await call("repo.map", { refresh: true }) as {
    stats?: { sourceFiles?: number };
    entryPoints?: string[];
    packages?: Array<{ name: string }>;
  };
  assert.ok((map.stats?.sourceFiles ?? 0) >= 2);
  assert.ok(map.packages?.some(pkg => pkg.name === "demo"));
  assert.equal(JSON.stringify(map).includes("must-not-appear"), false);
});

test("repo.find находит символ и вызывающий файл", async () => {
  const found = await call("repo.find", { query: "loadOrders", limit: 5, refresh: true }) as {
    files?: Array<{ path: string; symbols?: string[]; dependents?: string[] }>;
  };
  assert.equal(found.files?.[0]?.path, "src/service.ts");
  assert.ok(found.files?.some(file => file.path === "src/app.ts"));
});

test("repo.find отклоняет пустой запрос", async () => {
  await assert.rejects(call("repo.find", { query: "   " }), /нужен query/);
});

test("контекст с repoMap берёт файлы из индекса, а обычный путь остаётся доступным", async () => {
  const indexed = await retrieveRelevantFiles(project.id, "u1", "loadOrders", { repoMap: true });
  assert.match(indexed, /src\/service\.ts/);
  assert.match(indexed, /src\/app\.ts/);
  const lexical = await retrieveRelevantFiles(project.id, "u1", "loadOrders");
  assert.ok(lexical.length > 0);
});

test("buildProjectContext добавляет карту только при repoMap", async () => {
  const withMap = await buildProjectContext(project, "u1", { repoMap: true });
  assert.match(withMap, /REPOSITORY MAP/);
  assert.match(withMap, /src\/service\.ts/);
  const withoutMap = await buildProjectContext(project, "u1");
  assert.equal(withoutMap.includes("REPOSITORY MAP"), false);
});

test("архитектурная память включается только флагом и не тащит секреты", async () => {
  const withMemory = await buildProjectContext(project, "u1", { archMemory: true });
  assert.match(withMemory, /PROJECT MEMORY/);
  assert.match(withMemory, /API and UI share/);
  assert.doesNotMatch(withMemory, /must-not-appear/);
  const withoutMemory = await buildProjectContext(project, "u1");
  assert.equal(withoutMemory.includes("PROJECT MEMORY"), false);

  const snapshot = await call("project.memory", { action: "read" }) as {
    text?: string;
    missing?: string[];
  };
  assert.match(snapshot.text ?? "", /ARCHITECTURE\.md/);
  assert.ok(snapshot.missing?.includes("CONTRACTS.md"));
});

test("project.memory сначала показывает diff, потом пишет по hash", async () => {
  const next = "# Architecture\n\nAPI and UI share the order service.\n\nUpdated.\n";
  const preview = await call("project.memory", {
    action: "diff",
    path: "ARCHITECTURE.md",
    content: next,
  }) as { currentHash?: string; changed?: boolean; patch?: string };
  assert.equal(preview.changed, true);
  assert.match(preview.patch ?? "", /^\+Updated\.$/m);
  assert.equal(await readFile(path.join(root, "ARCHITECTURE.md"), "utf8"), "# Architecture\n\nAPI and UI share the order service.\n");

  await assert.rejects(call("project.memory", {
    action: "write",
    path: "ARCHITECTURE.md",
    content: next,
    expectedHash: preview.currentHash,
  }), /confirm:true/);

  const written = await call("project.memory", {
    action: "write",
    path: "ARCHITECTURE.md",
    content: next,
    expectedHash: preview.currentHash,
    confirm: true,
  }) as { changed?: boolean };
  assert.equal(written.changed, true);
  assert.equal(await readFile(path.join(root, "ARCHITECTURE.md"), "utf8"), next);
});

test("fs.grep scope сужает поиск до workspace-пакета", async () => {
  const scoped = await call("fs.grep", { pattern: "Button", scope: "@shop/ui" }) as {
    matches?: Array<{ file: string }>;
    scope?: string;
  };
  assert.deepEqual(scoped.matches?.map(match => match.file), ["packages/ui/src/index.ts"]);
  assert.equal(scoped.scope, "@shop/ui");

  const all = await call("fs.grep", { pattern: "Button" }) as { matches?: Array<{ file: string }> };
  assert.equal(all.matches?.length, 2);
  await assert.rejects(call("fs.grep", { pattern: "Button", scope: "missing-package" }), /не найден/);
  await assert.rejects(call("fs.grep", { pattern: "Button", scope: "@shop/ui", path: "../.." }), /не может выходить/);
});
