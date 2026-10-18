import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { registerSecretRoutes, type SecretRouteDeps } from "./secrets.js";
import { loadStoredSecretValues, secretStoreFile } from "../secrets/secret-store.js";
import { projectSecretPreview } from "../secrets/project-secrets.js";

process.env.WEBNESTDEV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "wnd-project-secrets-data-"));

let projectCounter = 0;
function nextProjectId() {
  return "p" + ++projectCounter;
}

async function tempRoot(initial?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "wnd-project-secrets-"));
  if (initial !== undefined) await writeFile(path.join(root, ".env.local"), initial, "utf8");
  return root;
}

async function appWith(root: string, projectId: string, overrides: Partial<SecretRouteDeps> = {}) {
  const app = Fastify();
  await registerSecretRoutes(app, {
    authorize: async () => ({ id: "u1" }),
    getProject: async id => ({ id, userId: "u1" }),
    getSandboxRoot: async () => root,
    ...overrides,
  });
  await app.ready();
  return app;
}

async function missing(file: string) {
  try {
    await readFile(file, "utf8");
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

test("список секретов переносит .env.local в шифрованное хранилище и не показывает значения", async () => {
  const projectId = nextProjectId();
  const root = await tempRoot([
    "# ключи проекта",
    "STRIPE_SECRET_KEY=sk_live_123456789",
    'DATABASE_URL="postgres://user:pass@host/db"',
    'PRIVATE_KEY="первая строка',
    'вторая строка"',
    "",
  ].join("\n"));
  const app = await appWith(root, projectId);
  try {
    const response = await app.inject({ method: "GET", url: "/api/projects/" + projectId + "/secrets" });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { file: string; variables: Array<{ name: string; preview: string; file: string }> };
    assert.equal(body.file, ".env.local");
    assert.deepEqual(body.variables.map(item => item.name), ["DATABASE_URL", "PRIVATE_KEY", "STRIPE_SECRET_KEY"]);
    assert.ok(body.variables.every(item => item.preview.length > 0 && item.file === ".env.local"));
    assert.ok(!JSON.stringify(body).includes("sk_live_123456789"));
    assert.ok(!JSON.stringify(body).includes("postgres://user:pass@host/db"));
    assert.ok(!JSON.stringify(body).includes("первая строка"));

    assert.equal(await missing(path.join(root, ".env.local")), true, "файл должен уйти из проекта");
    const stored = await readFile(secretStoreFile(projectId), "utf8");
    assert.doesNotMatch(stored, /sk_live_123456789|postgres:\/\/user:pass|первая строка/);
    assert.deepEqual(await loadStoredSecretValues(projectId), {
      ".env.local": {
        STRIPE_SECRET_KEY: "sk_live_123456789",
        DATABASE_URL: "postgres://user:pass@host/db",
        PRIVATE_KEY: "первая строка\nвторая строка",
      },
    });
  } finally { await app.close(); }
});

test("PUT добавляет переменную, сохраняет соседние ключи и не пишет файл в проект", async () => {
  const projectId = nextProjectId();
  const root = await tempRoot("# важное\nKEEP=1\n");
  const app = await appWith(root, projectId);
  try {
    const response = await app.inject({
      method: "PUT",
      url: "/api/projects/" + projectId + "/secrets",
      payload: { variables: { STRIPE_SECRET_KEY: "sk_live_12345" } },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { variables: Array<{ name: string; preview: string; file: string }> };
    assert.ok(body.variables.some(item => item.name === "STRIPE_SECRET_KEY"));
    assert.ok(!response.body.includes("sk_live_12345"));

    assert.equal(await missing(path.join(root, ".env.local")), true);
    assert.deepEqual(await loadStoredSecretValues(projectId), {
      ".env.local": { KEEP: "1", STRIPE_SECRET_KEY: "sk_live_12345" },
    });
  } finally { await app.close(); }
});

test("PUT заменяет значение, а не дописывает вторую переменную с тем же именем", async () => {
  const projectId = nextProjectId();
  const root = await tempRoot('PRIVATE_KEY="старая строка\\nвторая"\nKEEP=1\n');
  const app = await appWith(root, projectId);
  try {
    const response = await app.inject({
      method: "PUT",
      url: "/api/projects/" + projectId + "/secrets",
      payload: { variables: { PRIVATE_KEY: "новая строка" } },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(await loadStoredSecretValues(projectId), {
      ".env.local": { PRIVATE_KEY: "новая строка", KEEP: "1" },
    });
  } finally { await app.close(); }
});

test("PUT импортирует .env с export и многострочным значением", async () => {
  const projectId = nextProjectId();
  const root = await tempRoot("KEEP=1\n");
  const app = await appWith(root, projectId);
  try {
    const response = await app.inject({
      method: "PUT",
      url: "/api/projects/" + projectId + "/secrets",
      payload: { env: 'export API_URL=https://example.com\nPRIVATE_KEY="a\nb"\n' },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { variables: Array<{ name: string; preview: string }> };
    assert.ok(body.variables.some(item => item.name === "API_URL"));
    assert.ok(body.variables.some(item => item.name === "PRIVATE_KEY" && item.preview === "скрыто · 2 строк"));
    assert.deepEqual(await loadStoredSecretValues(projectId), {
      ".env.local": { KEEP: "1", API_URL: "https://example.com", PRIVATE_KEY: "a\nb" },
    });
  } finally { await app.close(); }
});

test("DELETE удаляет только выбранную переменную", async () => {
  const projectId = nextProjectId();
  const root = await tempRoot("# комментарий\nKEEP=1\nGONE=2\n");
  const app = await appWith(root, projectId);
  try {
    const response = await app.inject({ method: "DELETE", url: "/api/projects/" + projectId + "/secrets/GONE" });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { deleted: boolean; variables: Array<{ name: string }> };
    assert.equal(body.deleted, true);
    assert.deepEqual(body.variables.map(item => item.name), ["KEEP"]);
    assert.deepEqual(await loadStoredSecretValues(projectId), { ".env.local": { KEEP: "1" } });
  } finally { await app.close(); }
});

test("сохранение в дополнительный env-файл видно в списке и удаляется отдельно", async () => {
  const projectId = nextProjectId();
  const root = await tempRoot("KEEP=1\n");
  const app = await appWith(root, projectId);
  try {
    const saved = await app.inject({
      method: "PUT",
      url: "/api/projects/" + projectId + "/secrets",
      payload: { file: ".env.production", variables: { PROD_TOKEN: "prod-value" } },
    });
    assert.equal(saved.statusCode, 200);
    assert.equal((saved.json() as { file: string }).file, ".env.production");
    const list = await app.inject({ method: "GET", url: "/api/projects/" + projectId + "/secrets" });
    const variables = list.json().variables as Array<{ name: string; file: string }>;
    assert.ok(variables.some(item => item.name === "KEEP" && item.file === ".env.local"));
    assert.ok(variables.some(item => item.name === "PROD_TOKEN" && item.file === ".env.production"));

    const removed = await app.inject({
      method: "DELETE",
      url: "/api/projects/" + projectId + "/secrets/PROD_TOKEN?file=" + encodeURIComponent(".env.production"),
    });
    assert.equal(removed.statusCode, 200);
    assert.deepEqual(await loadStoredSecretValues(projectId), { ".env.local": { KEEP: "1" } });
  } finally { await app.close(); }
});

test("некорректное имя переменной отклоняется и не трогает файл проекта", async () => {
  const projectId = nextProjectId();
  const root = await tempRoot("KEEP=1\n");
  const app = await appWith(root, projectId);
  try {
    const response = await app.inject({
      method: "PUT",
      url: "/api/projects/" + projectId + "/secrets",
      payload: { variables: { "BAD-NAME": "x" } },
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /Имя переменной/);
    assert.equal(await readFile(path.join(root, ".env.local"), "utf8"), "KEEP=1\n");
    assert.equal(await loadStoredSecretValues(projectId), null);
  } finally { await app.close(); }
});

test("секреты чужого проекта не читаются и не меняются", async () => {
  const projectId = nextProjectId();
  const root = await tempRoot("KEEP=1\n");
  const app = await appWith(root, projectId, { getProject: async id => ({ id, userId: "u2" }) });
  try {
    for (const request of [
      { method: "GET" as const, url: "/api/projects/" + projectId + "/secrets" },
      { method: "PUT" as const, url: "/api/projects/" + projectId + "/secrets", payload: { variables: { X: "1" } } },
      { method: "DELETE" as const, url: "/api/projects/" + projectId + "/secrets/KEEP" },
    ]) {
      const response = await app.inject(request);
      assert.equal(response.statusCode, 404);
    }
    assert.equal(await readFile(path.join(root, ".env.local"), "utf8"), "KEEP=1\n");
    assert.equal(await loadStoredSecretValues(projectId), null);
  } finally { await app.close(); }
});

test("файл, появившийся после первой миграции, тоже уходит в хранилище", async () => {
  const projectId = nextProjectId();
  const root = await tempRoot("FIRST=1\n");
  const app = await appWith(root, projectId);
  try {
    const first = await app.inject({ method: "GET", url: "/api/projects/" + projectId + "/secrets" });
    assert.equal(first.statusCode, 200);
    assert.equal(await missing(path.join(root, ".env.local")), true);

    // Такой файл мог прийти из git pull или быть восстановлен вручную уже после миграции.
    await writeFile(path.join(root, ".env.production.local"), "LATE_TOKEN=late-value\n", "utf8");
    const second = await app.inject({ method: "GET", url: "/api/projects/" + projectId + "/secrets" });
    assert.equal(second.statusCode, 200);
    const variables = second.json().variables as Array<{ name: string; file: string }>;
    assert.ok(variables.some(item => item.name === "LATE_TOKEN" && item.file === ".env.production.local"));
    assert.equal(await missing(path.join(root, ".env.production.local")), true);
    assert.deepEqual(await loadStoredSecretValues(projectId), {
      ".env.local": { FIRST: "1" },
      ".env.production.local": { LATE_TOKEN: "late-value" },
    });
  } finally { await app.close(); }
});

test("превью значения не содержит даже фрагмента секрета", () => {
  assert.equal(projectSecretPreview("sk_live_123456789"), "скрыто");
  assert.equal(projectSecretPreview("a\nb"), "скрыто · 2 строк");
  assert.equal(projectSecretPreview("  "), "пусто");
});
