import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkpointDiff,
  createBranch,
  createCheckpoint,
  createManualCheckpoint,
  initRepo,
  listBranches,
  scanChanges,
  worktreeDiff,
} from "./git-repo.js";

test("ручной коммит берёт только выбранные файлы, diff показывает строки, ветка создаётся", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nestdev-manual-commit-"));
  try {
    await writeFile(path.join(root, "index.html"), "<h1>Старое</h1>\n");
    await writeFile(path.join(root, "notes.txt"), "первая\n");
    await initRepo(root, { branch: "main" });
    const first = await createCheckpoint(root, { branch: "main", subject: "Начальное состояние", kind: "imported" });
    assert.ok(first);

    await writeFile(path.join(root, "index.html"), "<h1>Старое</h1>\n<p>Новое</p>\n");
    await writeFile(path.join(root, "notes.txt"), "вторая\n");

    const worktree = await scanChanges(root);
    assert.deepEqual(worktree.changed.map(file => file.path).sort(), ["index.html", "notes.txt"]);

    const diff = await worktreeDiff(root, "index.html");
    assert.equal(diff.status, "modified");
    assert.match(diff.patch, /^--- a\/index\.html/m);
    assert.match(diff.patch, /^\+<p>Новое<\/p>$/m);
    assert.match(diff.patch, /^ <h1>Старое<\/h1>$/m);

    const commit = await createManualCheckpoint(root, { branch: "main", subject: "Только страницу", paths: ["index.html"] });
    assert.ok(commit);
    assert.equal(commit.kind, "manual");
    assert.deepEqual(commit.files, [{ path: "index.html", status: "modified" }]);

    // Невыбранный файл остался в рабочем дереве: выбор файлов не стирает остальную работу.
    const remaining = await scanChanges(root);
    assert.deepEqual(remaining.changed, [{ path: "notes.txt", status: "modified" }]);

    const committedDiff = await checkpointDiff(root, commit.sha, "index.html");
    assert.match(committedDiff.patch, /^\+<p>Новое<\/p>$/m);

    const branch = await createBranch(root, "feature");
    assert.equal(branch.created, true);
    assert.equal((await listBranches(root, "main")).current, "feature");
    assert.equal(await readFile(path.join(root, "notes.txt"), "utf8"), "вторая\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
