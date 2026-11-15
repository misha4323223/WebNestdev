import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRepoIndex, getRepoIndex } from "./build.js";
import { findRelevantFiles, repoMapSummary } from "./query.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "wnd-index-build-"));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "shop", private: true, workspaces: ["apps/*", "packages/*"] }),
    "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
    "src/app.ts": [
      'import { loadOrders } from "./service";',
      'import type { Order } from "@/types";',
      "export function handler(): Order[] { return loadOrders(); }",
    ].join("\n"),
    "src/service.ts": [
      'import { query } from "../lib/db";',
      "export function loadOrders() { return query(\"orders\"); }",
    ].join("\n"),
    "src/types.ts": "export type Order = { id: string };\n",
    "src/service.test.ts": 'import { loadOrders } from "./service";\nloadOrders();\n',
    "lib/db.ts": "export function query(name: string) { return [name]; }\n",
    "packages/ui/package.json": JSON.stringify({ name: "@shop/ui", main: "src/index.ts" }),
    "packages/ui/src/index.ts": "export const Button = () => null;\n",
    "apps/web/src/page.tsx": 'import { Button } from "@shop/ui";\nexport const page = Button;\n',
    "src/theme.css": '@import "/root.css";\n',
    "root.css": "body { margin: 0; }\n",
  };
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
  return root;
}

test("индекс разрешает относительные импорты, alias и workspace-пакет", async () => {
  const root = await fixture();
  const index = await buildRepoIndex(root, { useDiskCache: false });
  const byPath = new Map(index.files.map(file => [file.path, file]));
  assert.equal(byPath.get("src/app.ts")?.imports.find(item => item.specifier === "./service")?.target, "src/service.ts");
  assert.equal(byPath.get("src/app.ts")?.imports.find(item => item.specifier === "@/types")?.target, "src/types.ts");
  assert.equal(byPath.get("src/service.ts")?.imports.find(item => item.specifier === "../lib/db")?.target, "lib/db.ts");
  assert.equal(byPath.get("apps/web/src/page.tsx")?.imports.find(item => item.specifier === "@shop/ui")?.target, "packages/ui/src/index.ts");
  assert.equal(byPath.get("src/theme.css")?.imports.find(item => item.specifier === "/root.css")?.target, "root.css");
  assert.deepEqual(index.packages.map(pkg => pkg.name).sort(), ["@shop/ui", "shop"]);
  assert.ok(index.entryPoints.includes("packages/ui/src/index.ts"));
  assert.deepEqual(index.tests, ["src/service.test.ts"]);
});

test("поиск поднимает символ и его вызывающий файл, а карта даёт ориентиры", async () => {
  const root = await fixture();
  const index = await buildRepoIndex(root, { useDiskCache: false });
  const found = findRelevantFiles(index, "loadOrders", { limit: 10 });
  assert.equal(found[0]?.path, "src/service.ts");
  assert.ok(found.some(item => item.path === "src/app.ts"), "вызывающий файл должен попасть в выдачу");
  assert.ok(found.some(item => item.path === "apps/web/src/page.tsx") === false, "чужая ветка не должна раздувать выдачу");

  const map = repoMapSummary(index);
  assert.ok(map.packages.some(pkg => pkg.name === "@shop/ui"));
  assert.ok(map.entryPoints.includes("packages/ui/src/index.ts"));
  assert.equal(map.testFiles, 1);
  assert.ok(map.languages.tsx >= 1);
  assert.ok(map.anchors.length > 0);
});

test("кэш не перечитывает неизменённый проект и инвалидируется изменением файла", async () => {
  const root = await fixture();
  const first = await buildRepoIndex(root);
  const cache = JSON.parse(await readFile(path.join(root, ".webnestdev", "repo-index.json"), "utf8")) as { fingerprint: string };
  assert.equal(cache.fingerprint, first.fingerprint);
  const second = await buildRepoIndex(root);
  assert.equal(second.generatedAt, first.generatedAt, "неизменённый проект должен взять дисковой кэш");

  await new Promise(resolve => setTimeout(resolve, 5));
  await writeFile(path.join(root, "src", "app.ts"), 'import { loadOrders } from "./service";\nexport function handler() { return loadOrders(); }\n');
  const third = await buildRepoIndex(root);
  assert.notEqual(third.fingerprint, first.fingerprint);
  assert.notEqual(third.generatedAt, first.generatedAt);
});

test("испорченный кэш не ломает построение карты", async () => {
  const root = await fixture();
  await mkdir(path.join(root, ".webnestdev"), { recursive: true });
  await writeFile(path.join(root, ".webnestdev", "repo-index.json"), "{not json");
  const index = await buildRepoIndex(root);
  assert.ok(index.files.length > 0);
});

test("getRepoIndex переиспользует память и умеет принудительно обновиться", async () => {
  const root = await fixture();
  const first = await getRepoIndex(root, { useDiskCache: false });
  const second = await getRepoIndex(root, { useDiskCache: false });
  assert.equal(second.generatedAt, first.generatedAt);
  await new Promise(resolve => setTimeout(resolve, 5));
  const refreshed = await getRepoIndex(root, { refresh: true, useDiskCache: false });
  assert.notEqual(refreshed.generatedAt, first.generatedAt);
});
