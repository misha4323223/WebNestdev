import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { previewMemoryChange, writeMemoryFile } from "./write.js";

async function rootWith(files: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "wnd-memory-write-"));
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(root, name), content);
  return root;
}

test("diff не пишет, а write требует точный hash", async () => {
  const root = await rootWith({ "ARCHITECTURE.md": "# Architecture\n\nold\n" });
  try {
    const preview = await previewMemoryChange(root, "ARCHITECTURE.md", "# Architecture\n\nnew\n");
    assert.equal(preview.exists, true);
    assert.equal(preview.changed, true);
    assert.match(preview.patch, /^-old$/m);
    assert.match(preview.patch, /^\+new$/m);
    assert.match(preview.currentHash, /^[a-f0-9]{64}$/);
    assert.equal(await readFile(path.join(root, "ARCHITECTURE.md"), "utf8"), "# Architecture\n\nold\n");

    await assert.rejects(
      writeMemoryFile(root, "ARCHITECTURE.md", "# Architecture\n\nnew\n", "0".repeat(64)),
      /изменился после diff/,
    );
    const written = await writeMemoryFile(root, "ARCHITECTURE.md", "# Architecture\n\nnew\n", preview.currentHash);
    assert.equal(written.changed, true);
    assert.equal(await readFile(path.join(root, "ARCHITECTURE.md"), "utf8"), "# Architecture\n\nnew\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("create идёт от пустого hash и не позволяет обойти whitelist", async () => {
  const root = await rootWith();
  try {
    const preview = await previewMemoryChange(root, "DECISIONS.md", "# Decisions\n");
    assert.equal(preview.exists, false);
    assert.equal(preview.currentHash, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    await assert.rejects(previewMemoryChange(root, "README.md", "x"), /не входит в память/);
    await writeMemoryFile(root, "DECISIONS.md", "# Decisions\n", preview.currentHash);
    assert.equal(await readFile(path.join(root, "DECISIONS.md"), "utf8"), "# Decisions\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("секрет и слишком большой документ отвергаются до записи", async () => {
  const root = await rootWith();
  try {
    await assert.rejects(
      previewMemoryChange(root, "ARCHITECTURE.md", "token: ghp_" + "a".repeat(32)),
      /секрет/,
    );
    await assert.rejects(
      previewMemoryChange(root, "ARCHITECTURE.md", "x".repeat(24_001)),
      /максимум/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
