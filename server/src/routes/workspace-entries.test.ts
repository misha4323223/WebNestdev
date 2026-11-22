import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";

const dataRoot = await mkdtemp(path.join(tmpdir(), "wnd-workspace-entries-"));
process.env.WEBNESTDEV_DATA_DIR = dataRoot;
process.env.WEBNESTDEV_SANDBOX_DIR = path.join(dataRoot, "sandboxes");

const { createUser, createSession } = await import("../auth/auth-store.js");
const { createProject } = await import("../project-store.js");
const { sandboxRootPath } = await import("../sandbox/config.js");
const { registerWorkspaceEntryRoutes } = await import("./workspace-entries.js");

let emailCounter = 0;
async function setApp() {
  const user = await createUser("entries-" + ++emailCounter + "@example.com", "password-123");
  const project = await createProject("Entries", undefined, user.id);
  const session = await createSession(user.id);
  const root = sandboxRootPath(project.id);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "src.ts"), "export const ok = true;\n");
  await writeFile(path.join(root, ".env.local"), "SECRET=do-not-leak\n");

  const app = Fastify();
  await app.register(cookie);
  await registerWorkspaceEntryRoutes(app);
  await app.ready();
  return { app, projectId: project.id, root, headers: { cookie: "webnestdev_session=" + session.id } };
}

test("создаёт файл и папку, переименовывает и удаляет их", async () => {
  const { app, projectId, root, headers } = await setApp();
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/" + projectId + "/files",
      headers,
      payload: { path: "docs/readme.md", type: "file", content: "# Проект\n" },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(await readFile(path.join(root, "docs", "readme.md"), "utf8"), "# Проект\n");

    const folder = await app.inject({
      method: "POST",
      url: "/api/projects/" + projectId + "/files",
      headers,
      payload: { path: "assets", type: "directory" },
    });
    assert.equal(folder.statusCode, 201);
    assert.equal((await stat(path.join(root, "assets"))).isDirectory(), true);

    const renamed = await app.inject({
      method: "PATCH",
      url: "/api/projects/" + projectId + "/files",
      headers,
      payload: { from: "docs/readme.md", to: "docs/intro.md" },
    });
    assert.equal(renamed.statusCode, 200);
    assert.equal(await readFile(path.join(root, "docs", "intro.md"), "utf8"), "# Проект\n");

    const removed = await app.inject({
      method: "DELETE",
      url: "/api/projects/" + projectId + "/files?path=docs",
      headers,
    });
    assert.equal(removed.statusCode, 200);
    await assert.rejects(() => stat(path.join(root, "docs")), /ENOENT/);
  } finally {
    await app.close();
  }
});

test("загружает и скачивает отдельный файл, не открывая чужие пути", async () => {
  const { app, projectId, root, headers } = await setApp();
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
  try {
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/projects/" + projectId + "/files/upload",
      headers,
      payload: { path: "assets", name: "logo.png", data: bytes.toString("base64") },
    });
    assert.equal(uploaded.statusCode, 201);
    assert.equal(uploaded.json().path, "assets/logo.png");

    const downloaded = await app.inject({
      method: "GET",
      url: "/api/projects/" + projectId + "/files/download?path=assets/logo.png",
      headers,
    });
    assert.equal(downloaded.statusCode, 200);
    assert.deepEqual(downloaded.rawPayload, bytes);
    assert.match(String(downloaded.headers["content-disposition"]), /logo\.png/);
    assert.match(String(downloaded.headers["cache-control"]), /no-store/);
    assert.equal((await stat(path.join(root, "assets", "logo.png"))).size, bytes.length);
  } finally {
    await app.close();
  }
});

test("не даёт перезаписать существующее, выйти за проект или открыть секреты", async () => {
  const { app, projectId, headers } = await setApp();
  try {
    const existing = await app.inject({
      method: "POST",
      url: "/api/projects/" + projectId + "/files",
      headers,
      payload: { path: "src.ts", type: "file" },
    });
    assert.equal(existing.statusCode, 409);

    const secret = await app.inject({
      method: "POST",
      url: "/api/projects/" + projectId + "/files",
      headers,
      payload: { path: ".env.local", type: "file" },
    });
    assert.equal(secret.statusCode, 403);

    const git = await app.inject({
      method: "POST",
      url: "/api/projects/" + projectId + "/files",
      headers,
      payload: { path: ".git/config", type: "file" },
    });
    assert.equal(git.statusCode, 400);

    const outside = await app.inject({
      method: "POST",
      url: "/api/projects/" + projectId + "/files",
      headers,
      payload: { path: "../escape.txt", type: "file" },
    });
    assert.equal(outside.statusCode, 400);

    const overwrite = await app.inject({
      method: "PATCH",
      url: "/api/projects/" + projectId + "/files",
      headers,
      payload: { from: "src.ts", to: ".env.local" },
    });
    assert.equal(overwrite.statusCode, 403);

    const serviceUpload = await app.inject({
      method: "POST",
      url: "/api/projects/" + projectId + "/files/upload",
      headers,
      payload: { path: "assets", name: ".git", data: Buffer.from("x").toString("base64") },
    });
    assert.equal(serviceUpload.statusCode, 400);

    const secretDownload = await app.inject({
      method: "GET",
      url: "/api/projects/" + projectId + "/files/download?path=.env.local",
      headers,
    });
    assert.equal(secretDownload.statusCode, 403);
  } finally {
    await app.close();
  }
});
