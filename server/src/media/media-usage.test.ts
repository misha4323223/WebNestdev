import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanMediaUsageInRoot } from "./media-usage.js";

const base = "https://storage.mwsapis.ru/nestdev-media";
const url = base + "/media/user-1/project-1/2026/11/11111111-1111-1111-1111-111111111111-photo.jpg";

test("usage scan finds media URLs in sources and skips dependencies, builds and secrets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "media-usage-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "src", "page.tsx"), `<img src="${url}"/>\n`);
    await writeFile(path.join(root, "src", "theme.css"), `body{background:url("${url}")}\n`);
    await writeFile(path.join(root, "node_modules", "pkg", "index.js"), `const x="${url}";\n`);
    await writeFile(path.join(root, "dist", "index.html"), `<img src="${url}"/>\n`);
    await writeFile(path.join(root, ".env"), `MEDIA=${url}\n`);

    const result = await scanMediaUsageInRoot(root, base, [url]);
    assert.equal(result.truncated, false);
    assert.equal(result.usage.get(url)?.count, 2);
    assert.deepEqual(result.usage.get(url)?.files.map(file => file.path).sort(), ["src/page.tsx", "src/theme.css"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage scan marks a skipped large text file as incomplete", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "media-usage-"));
  try {
    await writeFile(path.join(root, "large.txt"), "x".repeat(600 * 1024) + "\n" + url + "\n");
    const result = await scanMediaUsageInRoot(root, base, [url]);
    assert.equal(result.truncated, true);
    assert.equal(result.usage.get(url)?.count, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
