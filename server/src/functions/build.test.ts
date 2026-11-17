import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildFunctions, FunctionBuildError } from "./build.js";
import { parseFunctionManifest } from "./manifest.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "functions-build-"));
  await mkdir(path.join(root, "functions"), { recursive: true });
  await writeFile(
    path.join(root, "functions", "hello.ts"),
    [
      'import { greeting } from "./greeting.js";',
      "export async function handler(request: { query: string }) {",
      '  return { status: 201, headers: { "content-type": "text/plain" }, body: greeting(request.query) };',
      "}",
    ].join("\n"),
  );
  await writeFile(path.join(root, "functions", "greeting.ts"), 'export function greeting(name: string) { return "hi " + name; }\n');
  await writeFile(
    path.join(root, "functions", "job.ts"),
    'export async function handler(request: { body: Buffer }) { return { ok: JSON.parse(request.body.toString()).id }; }\n',
  );
  await writeFile(
    path.join(root, "nestdev.functions.json"),
    JSON.stringify({
      version: 1,
      runtime: "node",
      functions: [{ name: "hello", path: "/api/hello", methods: ["GET"], handler: "functions/hello.ts#handler" }],
      jobs: [{ name: "send-receipt", handler: "functions/job.ts#handler" }],
    }),
  );
  return root;
}

test("собирает функцию в один ESM-файл и пишет манифест релиза", async () => {
  const root = await fixture();
  try {
    const manifest = parseFunctionManifest(JSON.parse(await readFile(path.join(root, "nestdev.functions.json"), "utf8")));
    const out = path.join(root, "release", ".functions");
    const built = await buildFunctions({ root, outDir: out, manifest });
    assert.equal(built.functions.length, 1);
    assert.equal(built.functions[0]!.name, "hello");
    assert.equal(built.functions[0]!.path, "/api/hello");
    assert.equal(built.jobs?.length, 1);
    assert.equal(built.jobs?.[0]?.name, "send-receipt");
    assert.equal(built.runtime, "node");
    assert.ok(built.bytes > 0);
    const code = await readFile(path.join(out, "hello", "index.mjs"), "utf8");
    assert.match(code, /hi /);
    assert.match(code, /export/);
    const written = JSON.parse(await readFile(path.join(out, "manifest.json"), "utf8"));
    assert.deepEqual(written, built);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("отказывает обработчику за пределами проекта", async () => {
  const root = await fixture();
  try {
    // Схема манифеста отклоняет `..` раньше; здесь проверяем вторую линию — сам сборщик
    // получает уже доверенный объект и всё равно не должен выйти из проекта.
    const manifest = {
      version: 1,
      runtime: "node",
      functions: [{ name: "escape", path: "/api/escape", methods: ["GET"], handler: "../outside.ts#handler", timeoutMs: 5000, memoryMb: 128 }],
    } as unknown as import("./manifest.js").FunctionManifest;
    await assert.rejects(
      () => buildFunctions({ root, outDir: path.join(root, "release"), manifest }),
      (error: unknown) => error instanceof FunctionBuildError && /пределы проекта/.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("не допускает точное значение секрета в собранном файле", async () => {
  const root = await fixture();
  try {
    await writeFile(
      path.join(root, "functions", "hello.ts"),
      'export async function handler() { return "sk-live-123456789012345678901234"; }\n',
    );
    const manifest = parseFunctionManifest(JSON.parse(await readFile(path.join(root, "nestdev.functions.json"), "utf8")));
    await assert.rejects(
      () => buildFunctions({ root, outDir: path.join(root, "release"), manifest, secretValues: ["sk-live-123456789012345678901234"] }),
      (error: unknown) => error instanceof FunctionBuildError && /секрет/.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
