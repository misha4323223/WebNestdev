import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { API_BRIDGE_PATH, installApiBridge } from "./api-bridge.js";

test("переписывает /api на отдельный хост и вставляет мост ровно один раз", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "webnestdev-api-bridge-"));
  try {
    await mkdir(path.join(root, "about"));
    await writeFile(path.join(root, "index.html"), "<html><head><title>x</title></head><body></body></html>");
    await writeFile(path.join(root, "about", "index.html"), "<html><body>about</body></html>");
    await writeFile(path.join(root, "app.js"), "fetch('/api/orders')");

    assert.equal(await installApiBridge(root, "https://api.host.nestdev.ru/demo"), true);
    const index = await readFile(path.join(root, "index.html"), "utf8");
    assert.match(index, /<head>\n<script src="\/_webnestdev\/api-bridge.js"><\/script><title>x<\/title><\/head>/);
    assert.match(await readFile(path.join(root, "about", "index.html"), "utf8"), /api-bridge\.js/);
    const script = await readFile(path.join(root, "_webnestdev", "api-bridge.js"), "utf8");
    assert.match(script, /https:\/\/api\.host\.nestdev\.ru\/demo/);
    assert.match(script, /value === "\/api"/);

    // Повторная публикация не должна добавлять второй тег.
    assert.equal(await installApiBridge(root, "https://api.host.nestdev.ru/demo"), false);
    assert.equal((await readFile(path.join(root, "index.html"), "utf8")).match(/api-bridge\.js/g)?.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("не трогает HTML без head/body и не выходит за staging-каталог", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "webnestdev-api-bridge-"));
  try {
    await writeFile(path.join(root, "fragment.html"), "<p>fragment</p>");
    assert.equal(await installApiBridge(root, "https://api.host.nestdev.ru/demo"), false);
    assert.equal(await readFile(path.join(root, "fragment.html"), "utf8"), "<p>fragment</p>");
    assert.ok(API_BRIDGE_PATH.startsWith("/_webnestdev/"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
