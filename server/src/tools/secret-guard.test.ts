import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dataRoot = await mkdtemp(path.join(tmpdir(), "wnd-tools-"));
process.env.WEBNESTDEV_DATA_DIR = dataRoot;
process.env.WEBNESTDEV_SANDBOX_DIR = path.join(dataRoot, "sandboxes");

const { createProject } = await import("../project-store.js");
const { sandboxRootPath } = await import("../sandbox/config.js");
await import("./filesystem-tools.js");
await import("./project-tools.js");
const { retrieveRelevantFiles } = await import("../agent/context-retrieval.js");
const { buildProjectContext } = await import("../agent/context-builder.js");
const { getTool } = await import("../tool-registry.js");

const project = await createProject("Secret guard", undefined, "u1");
const context = { projectId: project.id, userId: "u1", runId: "run-1" };
const projectRoot = sandboxRootPath(project.id);
await mkdir(projectRoot, { recursive: true });
await writeFile(path.join(projectRoot, ".env.local"), "SECRET_VALUE=do-not-leak\n");
await writeFile(path.join(projectRoot, ".env.example"), "PUBLIC_VALUE=\n");
await writeFile(path.join(projectRoot, "src.ts"), "export const ok = true;\n");
await writeFile(path.join(projectRoot, "TASKS.md"), "# Задачи проекта\n\n- [ ] Задача, которая не должна попасть в контекст\n");
await mkdir(path.join(projectRoot, "apps", "web"), { recursive: true });
await writeFile(path.join(projectRoot, "apps", "web", ".env.production"), "NESTED=do-not-leak\n");

async function tool(name: string, input: unknown) {
  const definition = getTool(name);
  assert.ok(definition?.execute, name + " не зарегистрирован");
  return definition.execute(input, context);
}

test("fs.list скрывает секретные env-файлы, но показывает шаблон", async () => {
  const entries = await tool("fs.list", { path: "." }) as Array<{ name: string }>;
  const names = entries.map((entry) => entry.name);
  assert.ok(names.includes("src.ts"));
  assert.ok(names.includes(".env.example"));
  assert.ok(!names.includes(".env.local"));
});

test("fs.read отказывает в корне и в подкаталоге, не возвращая значение", async () => {
  for (const file of [".env.local", "apps/web/.env.production", "./.env.local"]) {
    await assert.rejects(async () => tool("fs.read", { path: file }), /секрет/i, file);
  }
});

test("fs.write, fs.rename и fs.delete не могут создать, подменить или удалить секрет", async () => {
  await assert.rejects(async () => tool("fs.write", { path: ".env.local", content: "X=1" }), /секрет/i);
  await assert.rejects(async () => tool("fs.write", { path: "apps/web/.env.production", content: "X=1" }), /секрет/i);
  await assert.rejects(
    async () => tool("fs.rename", { from: ".env.local", to: "leak.txt" }),
    /секрет/i,
  );
  await assert.rejects(
    async () => tool("fs.rename", { from: "src.ts", to: ".env.local" }),
    /секрет/i,
  );
  await assert.rejects(async () => tool("fs.delete", { path: ".env.local" }), /секрет/i);

  assert.match(await readFile(path.join(projectRoot, ".env.local"), "utf8"), /do-not-leak/);
});

test("проектный список файлов тоже не показывает секрет", async () => {
  const entries = await tool("project.list_files", {}) as Array<{ name: string }>;
  assert.ok(!entries.some((entry) => entry.name === ".env.local"));
});

test("контекст агента не содержит секретный файл ни именем, ни значением", async () => {
  const retrieved = await retrieveRelevantFiles(project.id, "u1", "secret env local production");
  assert.doesNotMatch(retrieved, /\.env\.local|\.env\.production|do-not-leak/);
  assert.doesNotMatch(retrieved, /SECRET_VALUE|NESTED/);

  const full = await buildProjectContext(project, "u1");
  assert.doesNotMatch(full, /\.env\.local|\.env\.production/);
  assert.doesNotMatch(full, /do-not-leak|SECRET_VALUE|NESTED/);
  assert.match(full, /\.env\.example/);
  assert.match(full, /src\.ts/);
});

test("контекст не тянет TASKS.md целиком: задачи читаются по запросу", async () => {
  const full = await buildProjectContext(project, "u1");
  assert.match(full, /TASKS\.md/, "имя файла видно в дереве проекта");
  assert.doesNotMatch(full, /Задача, которая не должна попасть в контекст/);
});
