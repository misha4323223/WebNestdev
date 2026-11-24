import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runtime = fileURLToPath(new URL("./preview-runtime.mjs", import.meta.url));

async function waitForPort(child: ReturnType<typeof spawn>) {
  return new Promise<number>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("runtime did not start: " + output)), 5_000);
    child.stdout?.on("data", chunk => {
      output += String(chunk);
      const match = /listening on 127\.0\.0\.1:(\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.stderr?.on("data", chunk => { output += String(chunk); });
    child.once("exit", code => {
      if (!output.includes("listening")) {
        clearTimeout(timer);
        reject(new Error("runtime exited with " + code + ": " + output));
      }
    });
  });
}

test("preview supervisor restarts a crashed runtime without Docker --restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-preview-supervisor-"));
  const marker = path.join(root, "runs.txt");
  const fakeRuntime = path.join(root, "runtime.mjs");
  await writeFile(fakeRuntime, [
    "import http from 'node:http';",
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "let runs = 0; try { runs = Number(readFileSync(process.env.RUNS_MARKER, 'utf8')); } catch {}",
    "writeFileSync(process.env.RUNS_MARKER, String(runs + 1));",
    "if (runs === 0) process.exit(1);",
    "const server = http.createServer((_q, res) => res.end('ok'));",
    "server.listen(Number(process.env.PORT || 0), '127.0.0.1', () => console.log('listening on 127.0.0.1:' + server.address().port));",
  ].join("\n"));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./preview-supervisor.mjs", import.meta.url))], {
    env: { ...process.env, PORT: "0", RUNS_MARKER: marker, WEBNESTDEV_PREVIEW_RUNTIME: fakeRuntime },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const port = await waitForPort(child);
    const response = await fetch("http://127.0.0.1:" + port + "/");
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
    assert.equal((await readFile(marker, "utf8")).trim(), "2");
  } finally {
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("exit", resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("preview runtime loads project env files without overriding the container contract", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-preview-env-"));
  const functionsDir = path.join(root, "functions");
  await mkdir(path.join(functionsDir, "env"), { recursive: true });
  await writeFile(path.join(functionsDir, "env", "index.mjs"), [
    "export async function handler() {",
    "  return { status: 200, body: JSON.stringify({",
    "    database: process.env.DATABASE_URL, multiline: process.env.MULTILINE, portfolio: process.env.PORTFOLIO, proxy: process.env.HTTP_PROXY, port: process.env.PORT, root: process.env.WEBNESTDEV_PREVIEW_FUNCTIONS_DIR,",
    "  }) };",
    "}",
  ].join("\n"));
  await writeFile(path.join(functionsDir, "manifest.json"), JSON.stringify({
    version: 1,
    runtime: "node",
    functions: [{ name: "env", path: "/api/env", methods: ["GET"], handler: "node:functions/env.ts#handler", timeoutMs: 5_000, memoryMb: 128 }],
    jobs: [],
    bytes: 0,
  }));
  await writeFile(path.join(root, ".env"), "DATABASE_URL=postgres://base\n");
  await writeFile(path.join(root, ".env.local"), [
    "DATABASE_URL=postgres://preview",
    "MULTILINE=\"line1\\nline2\"",
    "PORTFOLIO=allowed",
    "HTTP_PROXY=http://evil.invalid",
    "PORT=5432",
    "WEBNESTDEV_PREVIEW_FUNCTIONS_DIR=/tmp/evil",
    "",
  ].join("\n"));
  await writeFile(path.join(root, ".env.production"), "DATABASE_URL=postgres://production\n");

  const child = spawn(process.execPath, [runtime], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "0",
      HTTP_PROXY: "http://platform-proxy:3128",
      WEBNESTDEV_PREVIEW_FUNCTIONS_DIR: functionsDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const port = await waitForPort(child);
    const response = await fetch("http://127.0.0.1:" + port + "/api/env");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      database: "postgres://production",
      multiline: "line1\nline2",
      portfolio: "allowed",
      proxy: "http://platform-proxy:3128",
      port: "0",
      root: functionsDir,
    });
  } finally {
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("exit", resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("preview runtime routes methods and bodies without starting a container per request", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-preview-runtime-"));
  const functionsDir = path.join(root, "functions");
  const nextFunctionsDir = path.join(root, "functions-2");
  await mkdir(path.join(functionsDir, "echo"), { recursive: true });
  await writeFile(path.join(functionsDir, "echo", "index.mjs"), [
    "export async function handler(request) {",
    "  return { status: 201, headers: { 'x-preview-function': 'echo' }, body: JSON.stringify({",
    "    method: request.method, path: request.path, query: request.query, search: request.search, body: request.body.toString(),",
    "  }) };",
    "}",
  ].join("\n"));
  const manifest = {
    version: 1,
    runtime: "node",
    functions: [{
      name: "echo",
      path: "/api/echo",
      methods: ["GET", "POST"],
      handler: "node:api/echo.ts#handler",
      timeoutMs: 5_000,
      memoryMb: 128,
    }],
    jobs: [],
    bytes: 0,
  };
  await writeFile(path.join(functionsDir, "manifest.json"), JSON.stringify(manifest));
  await mkdir(path.join(nextFunctionsDir, "echo"), { recursive: true });
  await writeFile(path.join(nextFunctionsDir, "echo", "index.mjs"), [
    "export async function handler() {",
    "  return { status: 200, body: 'second version' };",
    "}",
  ].join("\n"));
  await writeFile(path.join(nextFunctionsDir, "manifest.json"), JSON.stringify(manifest));

  const child = spawn(process.execPath, [runtime], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "0",
      WEBNESTDEV_PREVIEW_FUNCTIONS_DIR: functionsDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const port = await waitForPort(child);
    const base = "http://127.0.0.1:" + port;
    const health = await fetch(base + "/");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, runtime: "functions-preview", functions: 1 });

    const get = await fetch(base + "/api/echo?x=1");
    assert.equal(get.status, 201);
    assert.equal(get.headers.get("x-preview-function"), "echo");
    assert.deepEqual(await get.json(), { method: "GET", path: "/api/echo", query: { x: "1" }, search: "?x=1", body: "" });

    const post = await fetch(base + "/api/echo", { method: "POST", body: "hello" });
    assert.equal(post.status, 201);
    assert.deepEqual(await post.json(), { method: "POST", path: "/api/echo", query: {}, search: "", body: "hello" });

    const missing = await fetch(base + "/api/missing");
    assert.equal(missing.status, 404);

    const wrongMethod = await fetch(base + "/api/echo", { method: "DELETE" });
    assert.equal(wrongMethod.status, 405);
    assert.match(wrongMethod.headers.get("allow") ?? "", /GET/);

    const reload = await fetch(base + "/__preview/reload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: nextFunctionsDir }),
    });
    assert.equal(reload.status, 200);
    const reloaded = await fetch(base + "/api/echo");
    assert.equal(await reloaded.text(), "second version");
  } finally {
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("exit", resolve));
    await rm(root, { recursive: true, force: true });
  }
});
