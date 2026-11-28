/**
 * Fixture repositories for the `mvp` eval tasks.
 *
 * The projects ship failing tests, which is what a real repository looks like when a user reports
 * the task: the test names the expected contract, the implementation does not satisfy it yet. The
 * eval runs `npm test` in the sandbox, so pass/fail is the project's own suite, not a guess.
 */
import type { EvalFixture } from "./types.js";
import { BUILD_DIST } from "./build-dist.js";

const NOTES_APP = `import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const dataFile = path.join(process.cwd(), "data", "notes.json");

async function readData() {
  try { return JSON.parse(await readFile(dataFile, "utf8")); }
  catch { return { users: [], notes: [] }; }
}

async function writeData(data) {
  await writeFile(dataFile, JSON.stringify(data, null, 2));
}

function send(res, status, body) {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, text ? { "content-type": "application/json; charset=utf-8" } : {});
  res.end(text);
}

/**
 * Личный кабинет заметок. Сейчас сервер отдаёт заметки без входа: тесты в tests/ описывают
 * вход по cookie и CRUD, которого ещё нет.
 */
export function createApp() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/health") return send(res, 200, { ok: true });
    if (url.pathname.startsWith("/api/notes")) {
      const data = await readData();
      if (req.method === "GET") return send(res, 200, data.notes);
    }
    send(res, 404, { error: "not found" });
  });
}

export function start(port = 0) {
  const server = createApp();
  server.listen(port, "127.0.0.1");
  return server;
}
`;

const NOTES_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { start } from "../src/app.mjs";

async function withServer(run) {
  const server = start(0);
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port;
  try { await run(base); } finally { server.close(); }
}

const json = (method, body, cookie) => ({
  method,
  headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test("заметки требуют входа", async () => {
  await withServer(async base => {
    const response = await fetch(base + "/api/notes");
    assert.equal(response.status, 401);
  });
});

test("вход выдаёт cookie, неверный пароль отклоняется", async () => {
  await withServer(async base => {
    const bad = await fetch(base + "/api/login", json("POST", { email: "a@example.com", password: "wrong" }));
    assert.equal(bad.status, 401);

    const ok = await fetch(base + "/api/login", json("POST", { email: "a@example.com", password: "secret" }));
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("set-cookie") ?? "", /session=/);
  });
});

test("CRUD заметок в личном кабинете", async () => {
  await withServer(async base => {
    const login = await fetch(base + "/api/login", json("POST", { email: "a@example.com", password: "secret" }));
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    assert.ok(cookie, "ожидается cookie сессии");

    const empty = await fetch(base + "/api/notes", json("GET", undefined, cookie));
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), []);

    const created = await fetch(base + "/api/notes", json("POST", { title: "Первая", text: "Текст" }, cookie));
    assert.equal(created.status, 201);
    const note = await created.json();
    assert.ok(note.id);

    const updated = await fetch(base + "/api/notes/" + note.id, json("PATCH", { title: "Вторая" }, cookie));
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).title, "Вторая");

    const invalid = await fetch(base + "/api/notes", json("POST", { title: "" }, cookie));
    assert.equal(invalid.status, 400);

    const removed = await fetch(base + "/api/notes/" + note.id, json("DELETE", undefined, cookie));
    assert.equal(removed.status, 204);

    const after = await fetch(base + "/api/notes", json("GET", undefined, cookie));
    assert.deepEqual(await after.json(), []);
  });
});

test("чужую заметку не видно", async () => {
  await withServer(async base => {
    const first = await fetch(base + "/api/login", json("POST", { email: "a@example.com", password: "secret" }));
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
    const created = await fetch(base + "/api/notes", json("POST", { title: "Личная" }, cookie));
    const note = await created.json();

    const second = await fetch(base + "/api/login", json("POST", { email: "b@example.com", password: "secret" }));
    const otherCookie = (second.headers.get("set-cookie") ?? "").split(";")[0];
    const hidden = await fetch(base + "/api/notes/" + note.id, json("PATCH", { title: "Чужая" }, otherCookie));
    assert.equal(hidden.status, 404);
  });
});
`;

const ORDERS_MIGRATE = `import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const file = path.join(process.cwd(), "data", "orders.json");

/**
 * Миграция к схеме с полем status. Сейчас она пересобирает заказы из полей, которые считает
 * нужными, и теряет остальное — тесты в tests/ показывают, что именно должно сохраниться.
 */
const orders = JSON.parse(await readFile(file, "utf8"));
const migrated = orders.map(order => ({
  id: order.id,
  total: order.total,
}));

await writeFile(file, JSON.stringify(migrated, null, 2));
console.log("migrated " + migrated.length + " orders");
`;

const ORDERS_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdtemp, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

async function migratedProject() {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-orders-"));
  await cp(path.join(process.cwd(), "data"), path.join(dir, "data"), { recursive: true });
  await cp(path.join(process.cwd(), "src"), path.join(dir, "src"), { recursive: true });
  await run(process.execPath, [path.join(dir, "src", "migrate.mjs")], { cwd: dir });
  return JSON.parse(await readFile(path.join(dir, "data", "orders.json"), "utf8"));
}

test("миграция сохраняет существующие заказы", async () => {
  const orders = await migratedProject();
  assert.equal(orders.length, 3);
  assert.deepEqual(orders.map(order => order.id).sort(), ["o-1", "o-2", "o-3"]);
  assert.equal(orders.find(order => order.id === "o-2").total, 4800);
  assert.equal(orders.find(order => order.id === "o-2").note, "позвонить перед доставкой");
});

test("статус заполняется разумным значением", async () => {
  const orders = await migratedProject();
  for (const order of orders) {
    assert.ok(typeof order.status === "string" && order.status.trim(), "у заказа " + order.id + " нет статуса");
  }
  assert.equal(orders.find(order => order.id === "o-3").status, "paid");
});
`;

export const MVP_FIXTURES: Record<string, EvalFixture> = {
  "mvp-notes": {
    files: {
      "package.json": JSON.stringify({
        name: "eval-mvp-notes",
        private: true,
        version: "0.1.0",
        type: "module",
        scripts: {
          build: "node scripts/build.mjs",
          test: "node --test tests/*.test.mjs",
        },
      }, null, 2) + "\n",
      "src/app.mjs": NOTES_APP,
      "scripts/build.mjs": BUILD_DIST,
      "tests/notes.test.mjs": NOTES_TEST,
      "data/notes.json": JSON.stringify({
        users: [
          { id: "u-1", email: "a@example.com", password: "secret" },
          { id: "u-2", email: "b@example.com", password: "secret" },
        ],
        notes: [],
      }, null, 2) + "\n",
    },
  },
  "mvp-orders": {
    files: {
      "package.json": JSON.stringify({
        name: "eval-mvp-orders",
        private: true,
        version: "0.1.0",
        type: "module",
        scripts: {
          build: "node scripts/build.mjs",
          test: "node --test tests/*.test.mjs",
          migrate: "node src/migrate.mjs",
        },
      }, null, 2) + "\n",
      "data/orders.json": JSON.stringify([
        { id: "o-1", total: 2500, createdAt: "2026-10-01T10:00:00Z" },
        { id: "o-2", total: 4800, createdAt: "2026-10-02T11:30:00Z", note: "позвонить перед доставкой" },
        { id: "o-3", total: 990, createdAt: "2026-10-03T09:15:00Z", paidAt: "2026-10-03T09:20:00Z" },
      ], null, 2) + "\n",
      "src/migrate.mjs": ORDERS_MIGRATE,
      "scripts/build.mjs": BUILD_DIST,
      "tests/orders.test.mjs": ORDERS_TEST,
    },
  },
};
