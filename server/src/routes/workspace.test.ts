import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";

/**
 * The data and sandbox directories are read when the stores are imported, so this file sets them
 * first and only then loads the routes. That is the same order the server uses at startup.
 */
const dataRoot = await mkdtemp(path.join(tmpdir(), "wnd-workspace-"));
process.env.WEBNESTDEV_DATA_DIR = dataRoot;
process.env.WEBNESTDEV_SANDBOX_DIR = path.join(dataRoot, "sandboxes");

const { createUser, createSession } = await import("../auth/auth-store.js");
const { createProject } = await import("../project-store.js");
const { sandboxRootPath } = await import("../sandbox/config.js");
const { registerWorkspaceRoutes } = await import("./workspace.js");

let emailCounter = 0;
async function setApp() {
  const user = await createUser("workspace-" + ++emailCounter + "@example.com", "password-123");
  const project = await createProject("Workspace", undefined, user.id);
  const session = await createSession(user.id);
  const root = sandboxRootPath(project.id);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, ".env.local"), "SECRET_VALUE=do-not-leak\n");
  await writeFile(path.join(root, ".env.example"), "PUBLIC_VALUE=\n");
  await writeFile(path.join(root, "src.ts"), "export const ok = true;\n");

  const app = Fastify();
  await app.register(cookie);
  await registerWorkspaceRoutes(app);
  await app.ready();
  return {
    app,
    projectId: project.id,
    headers: { cookie: "webnestdev_session=" + session.id },
  };
}

test("список файлов скрывает секретные env-файлы и не кэшируется", async () => {
  const { app, projectId, headers } = await setApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/projects/" + projectId + "/files?path=.",
      headers,
    });
    assert.equal(response.statusCode, 200);
    const names = response.json().files.map((file: { name: string }) => file.name);
    assert.ok(names.includes("src.ts"));
    assert.ok(names.includes(".env.example"));
    assert.ok(!names.includes(".env.local"));
    assert.match(String(response.headers["cache-control"]), /no-store/);
  } finally { await app.close(); }
});

const readText = (file: string) => readFile(file, "utf8");
const readBytes = (file: string) => readFile(file);

/**
 * Имена файлов прямо из локальных заголовков архива: наш ZIP пишется без data descriptor,
 * поэтому размеры известны до данных и записи идут подряд.
 */
function zipNames(buffer: Buffer) {
  const names: string[] = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const compressed = buffer.readUInt32LE(offset + 18);
    names.push(buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8"));
    offset += 30 + nameLength + extraLength + compressed;
  }
  return names;
}

test("прямое редактирование сохраняет текст в файл проекта", async () => {
  const { app, projectId, headers } = await setApp();
  try {
    const response = await app.inject({
      method: "PUT",
      url: "/api/projects/" + projectId + "/file",
      headers,
      payload: { path: "src.ts", content: "export const ok = false;\n" },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().bytes, Buffer.byteLength("export const ok = false;\n"));
    const root = sandboxRootPath(projectId);
    assert.equal(await readText(path.join(root, "src.ts")), "export const ok = false;\n");

    // Панель открывает файл заново — она видит уже сохранённый текст.
    const read = await app.inject({ method: "GET", url: "/api/projects/" + projectId + "/file?path=src.ts", headers });
    assert.match(read.json().content, /ok = false/);
  } finally { await app.close(); }
});

test("редактор не отдаёт секреты, историю и двоичные файлы", async () => {
  const { app, projectId, headers } = await setApp();
  const root = sandboxRootPath(projectId);
  await mkdir(path.join(root, ".git"), { recursive: true });
  await writeFile(path.join(root, ".git", "config"), "[core]\n");
  await writeFile(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  try {
    const secret = await app.inject({ method: "PUT", url: "/api/projects/" + projectId + "/file", headers, payload: { path: ".env.local", content: "LEAK=1\n" } });
    assert.equal(secret.statusCode, 403);
    assert.equal(await readText(path.join(root, ".env.local")), "SECRET_VALUE=do-not-leak\n", "секрет не перезаписан");

    const git = await app.inject({ method: "PUT", url: "/api/projects/" + projectId + "/file", headers, payload: { path: ".git/config", content: "x" } });
    assert.equal(git.statusCode, 400);
    assert.equal(await readText(path.join(root, ".git", "config")), "[core]\n");

    const binary = await app.inject({ method: "GET", url: "/api/projects/" + projectId + "/file?path=logo.png", headers });
    assert.equal(binary.statusCode, 200);
    assert.equal(binary.json().binary, true);
    assert.equal(binary.json().content, "");

    const overwrite = await app.inject({ method: "PUT", url: "/api/projects/" + projectId + "/file", headers, payload: { path: "logo.png", content: "not an image" } });
    assert.equal(overwrite.statusCode, 400);
    assert.deepEqual(await readBytes(path.join(root, "logo.png")), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

    const missing = await app.inject({ method: "PUT", url: "/api/projects/" + projectId + "/file", headers, payload: { path: "nope.ts", content: "x" } });
    assert.equal(missing.statusCode, 404);
  } finally { await app.close(); }
});

test("архив проекта отдаётся zip и не включает зависимости и секреты", async () => {
  const { app, projectId, headers } = await setApp();
  const root = sandboxRootPath(projectId);
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  await mkdir(path.join(root, "src", "глубоко"), { recursive: true });
  await writeFile(path.join(root, "src", "глубоко", "файл.txt"), "привет\n");
  try {
    const response = await app.inject({ method: "GET", url: "/api/projects/" + projectId + "/export", headers });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "application/zip");
    assert.match(String(response.headers["content-disposition"]), /filename\*=UTF-8''Workspace\.zip/);
    assert.match(String(response.headers["cache-control"]), /no-store/);

    const names = zipNames(response.rawPayload);
    assert.ok(names.includes("Workspace/src.ts"), "файлы лежат в папке проекта");
    assert.ok(names.includes("Workspace/src/глубоко/файл.txt"), "русские имена не бьются");
    assert.ok(names.every(name => !name.includes("node_modules")), "зависимости в архив не попадают");
    assert.ok(names.every(name => !name.includes(".env.local")), "секреты в архив не попадают");
    assert.equal(response.rawPayload.readUInt32LE(response.rawPayload.length - 22), 0x06054b50, "архив завершён оглавлением");
  } finally { await app.close(); }
});

test("прямое открытие секретного файла — 403 без содержимого, шаблон открывается", async () => {
  const { app, projectId, headers } = await setApp();
  try {
    const secret = await app.inject({
      method: "GET",
      url: "/api/projects/" + projectId + "/file?path=.env.local",
      headers,
    });
    assert.equal(secret.statusCode, 403);
    assert.doesNotMatch(secret.body, /do-not-leak|SECRET_VALUE/);
    assert.match(String(secret.headers["cache-control"]), /no-store/);

    const nested = await app.inject({
      method: "GET",
      url: "/api/projects/" + projectId + "/file?path=apps/web/.env.production",
      headers,
    });
    assert.equal(nested.statusCode, 403);
    assert.doesNotMatch(nested.body, /SECRET/);

    const template = await app.inject({
      method: "GET",
      url: "/api/projects/" + projectId + "/file?path=.env.example",
      headers,
    });
    assert.equal(template.statusCode, 200);
    assert.match(template.json().content, /PUBLIC_VALUE/);
  } finally { await app.close(); }
});
