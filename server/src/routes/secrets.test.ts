import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { registerSecretRoutes, type SecretRouteDeps } from "./secrets.js";
import { requestSecret, resolveSecretRequest } from "../secrets/pending-secrets.js";
import { listSecretAudit } from "../secrets/secret-audit.js";
import { loadStoredSecretValues } from "../secrets/secret-store.js";

// Аудит и секреты пишутся в отдельный каталог: тест не должен оставлять данные в рабочем `.webnestdev`.
process.env.WEBNESTDEV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "wnd-secret-audit-"));

let projectCounter = 0;
function nextProjectId() {
  return "p" + ++projectCounter;
}

async function tempRoot(initial?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "wnd-secret-"));
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

test("значение из окна уходит в зашифрованное хранилище, а не в файл проекта", async () => {
  const projectId = nextProjectId();
  const root = await tempRoot("KEEP=1\n");
  const { request, answer } = requestSecret({ projectId, userId: "u1", variable: "STRIPE_SECRET_KEY", purpose: "Оплата", file: ".env.local" });
  const app = await appWith(root, projectId);
  try {
    const response = await app.inject({ method: "POST", url: "/api/projects/" + projectId + "/secrets", payload: { requestId: request.id, value: "sk_live_12345" } });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual(body, { ok: true, variable: "STRIPE_SECRET_KEY", file: ".env.local", delivered: true });
    assert.ok(!JSON.stringify(body).includes("sk_live_12345"), "значение не должно возвращаться в браузер");

    assert.equal(await missing(path.join(root, ".env.local")), true, "файл должен уйти из проекта");
    assert.deepEqual(await loadStoredSecretValues(projectId), {
      ".env.local": { KEEP: "1", STRIPE_SECRET_KEY: "sk_live_12345" },
    });
    assert.deepEqual(await answer, { ok: true, variable: "STRIPE_SECRET_KEY", file: ".env.local" });
  } finally { await app.close(); }
});

test("многострочный ключ хранится как значение и не ломает env-файл", async () => {
  const projectId = nextProjectId();
  const root = await tempRoot("");
  const { request, answer } = requestSecret({ projectId, userId: "u1", variable: "PRIVATE_KEY", purpose: "Подпись", file: ".env.local" });
  const app = await appWith(root, projectId);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/" + projectId + "/secrets",
      payload: { requestId: request.id, value: "-----BEGIN KEY-----\nMIIB\n-----END KEY-----" },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(await loadStoredSecretValues(projectId), {
      ".env.local": { PRIVATE_KEY: "-----BEGIN KEY-----\nMIIB\n-----END KEY-----" },
    });
    await answer;
  } finally { await app.close(); }
});

test("окно ключа переживает обрыв запуска: значение сохраняется, но запуск надо продолжить", async () => {
  const projectId = nextProjectId();
  const root = await tempRoot("");
  const controller = new AbortController();
  const { request, answer } = requestSecret({
    projectId, userId: "u1", variable: "TOKEN", purpose: "Доступ к API", file: ".env.local", conversationId: "c1",
    signal: controller.signal,
  });
  // Перезагрузка вкладки закрывает сокет, а значит — и запуск, который ждал ключ.
  controller.abort();
  await answer;
  const app = await appWith(root, projectId);
  try {
    const pending = await app.inject({ method: "GET", url: "/api/projects/" + projectId + "/secrets/pending?conversationId=c1" });
    assert.equal(pending.statusCode, 200);
    const requests = pending.json().requests;
    assert.equal(requests.length, 1);
    assert.equal(requests[0].variable, "TOKEN");
    assert.equal(requests[0].file, ".env.local");
    assert.equal(requests[0].waiting, false);
    assert.ok(!JSON.stringify(requests).includes("secret-value"));

    const response = await app.inject({
      method: "POST",
      url: "/api/projects/" + projectId + "/secrets",
      payload: { requestId: request.id, value: "secret-value" },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true, variable: "TOKEN", file: ".env.local", delivered: false });
    assert.deepEqual(await loadStoredSecretValues(projectId), { ".env.local": { TOKEN: "secret-value" } });

    // Сохранённое окно больше не висит в чате.
    const after = await app.inject({ method: "GET", url: "/api/projects/" + projectId + "/secrets/pending?conversationId=c1" });
    assert.deepEqual(after.json().requests, []);
  } finally { await app.close(); }
});

test("устаревшее окно ничего не пишет и не отдаёт значение обратно", async () => {
  const projectId = nextProjectId();
  const root = await tempRoot("KEEP=1\n");
  const app = await appWith(root, projectId);
  try {
    const response = await app.inject({ method: "POST", url: "/api/projects/" + projectId + "/secrets", payload: { requestId: "нет-такого", value: "sk_live_12345" } });
    assert.equal(response.statusCode, 404);
    assert.ok(!response.body.includes("sk_live_12345"));
    assert.equal(await readFile(path.join(root, ".env.local"), "utf8"), "KEEP=1\n");
    assert.equal(await loadStoredSecretValues(projectId), null);
  } finally { await app.close(); }
});

test("отмена закрывает ожидание инструмента отказом", async () => {
  const projectId = nextProjectId();
  const root = await tempRoot("");
  const { request, answer } = requestSecret({ projectId, userId: "u1", variable: "TOKEN", purpose: "", file: ".env.local" });
  const app = await appWith(root, projectId);
  try {
    const response = await app.inject({ method: "POST", url: "/api/projects/" + projectId + "/secrets/" + request.id + "/cancel" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { cancelled: true });
    assert.deepEqual(await answer, { ok: false, cancelled: true });
  } finally { await app.close(); }
});

test("ответы о секретах не кэшируются и отклоняют чужой Origin", async () => {
  const projectId = nextProjectId();
  const root = await tempRoot("KEEP=1\n");
  const app = await appWith(root, projectId);
  try {
    const list = await app.inject({ method: "GET", url: "/api/projects/" + projectId + "/secrets" });
    assert.equal(list.statusCode, 200);
    assert.match(String(list.headers["cache-control"]), /no-store/);
    // GET переносит существующий `.env.local` в хранилище — это и есть проверка миграции.
    assert.equal(await missing(path.join(root, ".env.local")), true);
    assert.deepEqual(await loadStoredSecretValues(projectId), { ".env.local": { KEEP: "1" } });

    const foreign = await app.inject({
      method: "PUT",
      url: "/api/projects/" + projectId + "/secrets",
      headers: { host: "app.test", origin: "https://evil.test" },
      payload: { variables: { TOKEN: "super-secret-value" } },
    });
    assert.equal(foreign.statusCode, 403);
    assert.deepEqual(await loadStoredSecretValues(projectId), { ".env.local": { KEEP: "1" } });

    const own = await app.inject({
      method: "PUT",
      url: "/api/projects/" + projectId + "/secrets",
      headers: { host: "app.test", origin: "https://app.test", "x-forwarded-proto": "https" },
      payload: { variables: { TOKEN: "super-secret-value" } },
    });
    assert.equal(own.statusCode, 200);
    assert.deepEqual(await loadStoredSecretValues(projectId), {
      ".env.local": { KEEP: "1", TOKEN: "super-secret-value" },
    });
  } finally { await app.close(); }
});

test("операция с секретом попадает в аудит без значения", async () => {
  const projectId = nextProjectId();
  const root = await tempRoot("");
  const app = await appWith(root, projectId);
  try {
    const response = await app.inject({
      method: "PUT",
      url: "/api/projects/" + projectId + "/secrets",
      payload: { variables: { AUDIT_ONLY_SECRET: "never-store-this-value" } },
    });
    assert.equal(response.statusCode, 200);

    const entries = await listSecretAudit(projectId);
    assert.ok(entries.length >= 1);
    const latest = entries[0];
    assert.equal(latest.action, "write");
    assert.deepEqual(latest.names, ["AUDIT_ONLY_SECRET"]);
    assert.equal(latest.userId, "u1");
    assert.equal(latest.file, ".env.local");
    assert.ok(!JSON.stringify(entries).includes("never-store-this-value"));
  } finally { await app.close(); }
});

test("проект другого аккаунта закрыт так же, как несуществующий", async () => {
  const projectId = nextProjectId();
  const root = await tempRoot("");
  const { request } = requestSecret({ projectId, userId: "u1", variable: "TOKEN", purpose: "", file: ".env.local" });
  const app = await appWith(root, projectId, { getProject: async id => ({ id, userId: "u2" }) });
  try {
    const response = await app.inject({ method: "POST", url: "/api/projects/" + projectId + "/secrets", payload: { requestId: request.id, value: "sk_live_12345" } });
    assert.equal(response.statusCode, 404);
    assert.match(response.body, /Проект не найден/);
  } finally {
    resolveSecretRequest(request.id, { ok: false, cancelled: true });
    await app.close();
  }
});
