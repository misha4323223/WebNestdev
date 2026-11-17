import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("preview runtime routes methods and bodies without starting a container per request", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-preview-runtime-"));
  const functionsDir = path.join(root, "functions");
  const nextFunctionsDir = path.join(root, "functions-2");
  await mkdir(path.join(functionsDir, "echo"), { recursive: true });
  await writeFile(path.join(functionsDir, "echo", "index.mjs"), [
    "export async function handler(request) {",
    "  return { status: 201, headers: { 'x-preview-function': 'echo' }, body: JSON.stringify({",
    "    method: request.method, path: request.path, query: request.query, body: request.body.toString(),",
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
    assert.deepEqual(await get.json(), { method: "GET", path: "/api/echo", query: "?x=1", body: "" });

    const post = await fetch(base + "/api/echo", { method: "POST", body: "hello" });
    assert.equal(post.status, 201);
    assert.deepEqual(await post.json(), { method: "POST", path: "/api/echo", query: "", body: "hello" });

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
