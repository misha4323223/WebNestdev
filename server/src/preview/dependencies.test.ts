import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureProjectDependencies, missingDependencies, readDeclaredDependencies } from "./dependencies.js";
import type { SandboxConfig } from "../sandbox-manager.js";

/** Проект на диске: только то, что важно проверке — `package.json` и `node_modules`. */
async function project(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-deps-"));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  }
  return root;
}

const config = (root: string): SandboxConfig => ({ projectId: "p1", root, memoryMb: 1024, cpuLimit: 1, timeoutMs: 120000 });

/** Установка отмечается здесь: тесту важно, вызывалась ли она и с какой сетью. */
function recorder(result: { ok: boolean; stdout?: string; stderr?: string } = { ok: true }) {
  const calls: { command: string; cwd: string; network?: string }[] = [];
  const run = async (_config: SandboxConfig, command: string, cwd: string, options: { network?: "none" | "bridge" }) => {
    calls.push({ command, cwd, network: options.network });
    return { ok: result.ok, exitCode: result.ok ? 0 : 1, signal: null, stdout: result.stdout ?? "added 120 packages", stderr: result.stderr ?? "", truncated: false };
  };
  return { calls, run };
}

test("зависимости без node_modules названы все: проект создан агентом, установки ещё не было", async t => {
  const root = await project({ "package.json": JSON.stringify({ dependencies: { react: "^19.0.0" }, devDependencies: { vite: "^8.0.0" } }) });
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(await missingDependencies(root), ["react", "vite"]);
});

test("установленный пакет не считается отсутствующим", async t => {
  const root = await project({
    "package.json": JSON.stringify({ dependencies: { react: "^19.0.0", "@scope/ui": "^1.0.0" } }),
    "node_modules/react/index.js": "",
    "node_modules/@scope/ui/package.json": "{}",
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(await missingDependencies(root), []);
});

test("частичная установка добирается: добавленную позже зависимость видно", async t => {
  const root = await project({
    "package.json": JSON.stringify({ dependencies: { react: "^19.0.0", zod: "^4.0.0" } }),
    "node_modules/react/index.js": "",
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(await missingDependencies(root), ["zod"]);
});

test("локальные ссылки не требуются: их ставит не реестр", async t => {
  const root = await project({
    "package.json": JSON.stringify({ dependencies: { app: "file:../app", core: "workspace:*" }, devDependencies: { vite: "^8.0.0" } }),
    "node_modules/vite/index.js": "",
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const declared = await readDeclaredDependencies(root);
  assert.deepEqual(declared, ["vite"]);
  assert.deepEqual(await missingDependencies(root), []);
});

test("без package.json ставить нечего", async t => {
  const root = await project({ "index.html": "<h1>Статика</h1>" });
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(await missingDependencies(root), null);
  const result = await ensureProjectDependencies(config(root), recorder().run);
  assert.deepEqual(result, { ok: true, installed: false, log: "" });
});

test("проект с готовыми зависимостями не платит установкой", async t => {
  const root = await project({
    "package.json": JSON.stringify({ dependencies: { vite: "^8.0.0" } }),
    "node_modules/vite/index.js": "",
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const { calls, run } = recorder();
  const result = await ensureProjectDependencies(config(root), run);
  assert.deepEqual(result, { ok: true, installed: false, log: "" });
  assert.equal(calls.length, 0);
});

test("установка идёт с сетью — как npm.install, и её вывод попадает в лог предпросмотра", async t => {
  const root = await project({ "package.json": JSON.stringify({ dependencies: { vite: "^8.0.0", react: "^19.0.0" } }) });
  t.after(() => rm(root, { recursive: true, force: true }));

  const { calls, run } = recorder();
  const result = await ensureProjectDependencies(config(root), run);
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.installed : false, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "npm install --no-audit --no-fund");
  assert.equal(calls[0].cwd, root);
  // Сеть включается только для установки: остальные команды песочницы остаются без неё.
  assert.equal(calls[0].network, "bridge");
  assert.match(result.ok ? result.log : "", /vite, react/);
  assert.match(result.ok ? result.log : "", /added 120 packages/);
});

test("неудачная установка — это причина, а не молчаливый запуск без зависимостей", async t => {
  const root = await project({ "package.json": JSON.stringify({ dependencies: { vite: "^8.0.0" } }) });
  t.after(() => rm(root, { recursive: true, force: true }));

  const failing = recorder({ ok: false, stdout: "", stderr: "npm ERR! network request to registry.npmjs.org failed" });
  const result = await ensureProjectDependencies(config(root), failing.run);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /установка зависимостей не прошла/);
  assert.match(result.ok ? "" : result.reason, /registry\.npmjs\.org/);
});

test("недоступный Docker в установке назван причиной, а не выброшен исключением", async t => {
  const root = await project({ "package.json": JSON.stringify({ dependencies: { vite: "^8.0.0" } }) });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await ensureProjectDependencies(config(root), async () => {
    throw new Error("Docker недоступен");
  });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /Docker недоступен/);
});
