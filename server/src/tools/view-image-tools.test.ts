import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dataRoot = await mkdtemp(path.join(tmpdir(), "wnd-view-image-"));
process.env.WEBNESTDEV_DATA_DIR = dataRoot;
process.env.WEBNESTDEV_SANDBOX_DIR = path.join(dataRoot, "sandboxes");

const { createProject } = await import("../project-store.js");
const { sandboxRootPath } = await import("../sandbox/config.js");
await import("./view-image-tools.js");
await import("./vision-tools.js");
const { getTool } = await import("../tool-registry.js");

const project = await createProject("View image tools", undefined, "u1");
const context = { projectId: project.id, userId: "u1", runId: "run-view" };
const projectRoot = sandboxRootPath(project.id);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
await mkdir(path.join(projectRoot, "public", "images"), { recursive: true });
await writeFile(path.join(projectRoot, "public", "images", "hero.png"), PNG);
await writeFile(path.join(projectRoot, ".env.local"), "SECRET=1\n");

async function tool(name: string, input: unknown, toolContext: typeof context & { model?: string } = context) {
  const definition = getTool(name);
  assert.ok(definition?.execute, name + " не зарегистрирован");
  return definition.execute(input, toolContext);
}

test("image.view отдаёт локальный файл из любой папки главной модели", async () => {
  const result = await tool("image.view", { path: "public/images/hero.png" }) as {
    ok?: boolean;
    path?: string;
    contentType?: string;
    viewImage?: boolean;
  };
  assert.equal(result.ok, true);
  assert.equal(result.path, "public/images/hero.png");
  assert.equal(result.contentType, "image/png");
  assert.equal(result.viewImage, true);
});

test("image.inspect для локального файла прикладывает его главной модели, а не зовёт vision", async () => {
  const result = await tool(
    "image.inspect",
    { path: "public/images/hero.png" },
    { ...context, model: "multimodal-main-model" },
  ) as { ok?: boolean; viewImage?: boolean; direct?: boolean; contentType?: string; analysis?: string };
  assert.equal(result.ok, true);
  assert.equal(result.viewImage, true);
  assert.equal(result.direct, true);
  assert.equal(result.contentType, "image/png");
  assert.equal(result.analysis, undefined);
});

test("image.view не читает секретный env-файл", async () => {
  await assert.rejects(async () => tool("image.view", { path: ".env.local" }), /секрет/i);
});

test("image.view честно отказывает для не-растрового файла", async () => {
  await writeFile(path.join(projectRoot, "public", "images", "logo.svg"), "<svg/>");
  const result = await tool("image.view", { path: "public/images/logo.svg" }) as { ok?: boolean; code?: string };
  assert.equal(result.ok, false);
  assert.equal(result.code, "unsupported");
});
