import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readProjectMemory } from "./read.js";

async function rootWith(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "wnd-memory-"));
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(root, name), content);
  return root;
}

test("память читает три документа и не включает секретный файл", async () => {
  const root = await rootWith({
    "ARCHITECTURE.md": "# Architecture\n\n## Modules\n\n- API and worker.\n",
    "DECISIONS.md": "# Decisions\n\n- Use PostgreSQL.\n",
    "CONTRACTS.md": "-----BEGIN PRIVATE KEY-----\nnot-for-context\n",
  });
  try {
    const memory = await readProjectMemory(root);
    assert.match(memory.text, /ARCHITECTURE\.md/);
    assert.match(memory.text, /PostgreSQL/);
    assert.doesNotMatch(memory.text, /not-for-context/);
    assert.doesNotMatch(memory.text, /PRIVATE KEY/);
    assert.equal(memory.files.length, 2);
    assert.equal(memory.skipped[0]?.path, "CONTRACTS.md");
    assert.match(memory.skipped[0]?.reason ?? "", /секрет/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("пустой проект не выдаёт пустую память за знания", async () => {
  const root = await rootWith({ "README.md": "no memory yet\n" });
  try {
    const memory = await readProjectMemory(root);
    assert.equal(memory.text, "");
    assert.deepEqual(memory.missing, ["ARCHITECTURE.md", "DECISIONS.md", "CONTRACTS.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("большой документ ограничен, но сначала проверяется целиком", async () => {
  const secret = "ghp_" + "a".repeat(32);
  const root = await rootWith({
    "ARCHITECTURE.md": "A".repeat(20_000) + "\n" + secret + "\n",
  });
  try {
    const memory = await readProjectMemory(root);
    assert.equal(memory.text, "");
    assert.equal(memory.skipped[0]?.path, "ARCHITECTURE.md");
    assert.match(memory.skipped[0]?.reason ?? "", /секрет/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
