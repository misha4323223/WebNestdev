import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Сквозная проверка «Изменений» на настоящем каталоге проекта: задача создаёт точку, вторая
 * задача — следующую, откат возвращает файлы, а чужая учётная запись не видит историю.
 *
 * Каталоги задаются до первого импорта: и хранилище, и песочницы читают переменные один раз
 * при загрузке модуля. Поэтому файл — один тест с последовательными шагами.
 */
test("история задач, откат и проверка владельца", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wnd-changes-"));
  process.env.WEBNESTDEV_DATA_DIR = path.join(root, "data");
  process.env.WEBNESTDEV_SANDBOX_DIR = path.join(root, "sandboxes");
  try {
    const { createProject } = await import("../project-store.js");
    const { changesOverview, finalizeRunChanges, repositoryNameFromProject, rollbackToCheckpoint } = await import("./changes-service.js");
    // GitHub принимает только латиницу: имя репозитория строится из названия проекта.
    assert.equal(repositoryNameFromProject("Мой Магазин"), "moy-magazin");
    assert.equal(repositoryNameFromProject("   "), "webnestdev-project");
    assert.equal(repositoryNameFromProject("Интернет-магазин 2026!"), "internet-magazin-2026");

    const project = await createProject("История", undefined, "user-changes");
    const sandbox = path.join(process.env.WEBNESTDEV_SANDBOX_DIR, project.id);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sandbox, { recursive: true });

    // Запуск без правок файлов не оставляет пустую точку в истории.
    assert.equal(await finalizeRunChanges({ projectId: project.id, userId: "user-changes", runId: "run-empty", title: "Просто поговорили" }), null);
    const empty = await changesOverview(project.id, "user-changes");
    assert.equal(empty.initialized, true);
    assert.equal(empty.checkpoints.length, 0);

    await writeFile(path.join(sandbox, "index.html"), "<h1>Первая версия</h1>\n");
    const first = await finalizeRunChanges({ projectId: project.id, userId: "user-changes", runId: "run-1", conversationId: "conv-1", title: "Собрать страницу" });
    assert.ok(first, "первая задача должна создать точку");
    assert.equal(first.checkpoint.filesChanged, 1);
    // Задача оставляет точку только в проекте: отправку на GitHub запускает пользователь,
    // а результат завершения задачи даже не несёт статуса отправки.
    assert.equal("pushed" in first, false, "завершение задачи не пушит само");
    assert.equal(first.checkpoint.pushed, false);

    await writeFile(path.join(sandbox, "index.html"), "<h1>Вторая версия</h1>\n");
    await writeFile(path.join(sandbox, "styles.css"), "body{margin:0}\n");
    const second = await finalizeRunChanges({ projectId: project.id, userId: "user-changes", runId: "run-2", conversationId: "conv-1", title: "Перекрасить страницу" });
    assert.ok(second);
    assert.equal(second.checkpoint.filesChanged, 2);

    const overview = await changesOverview(project.id, "user-changes");
    assert.equal(overview.checkpoints.length, 2);
    assert.equal(overview.checkpoints[0].sha, second.checkpoint.sha);
    assert.equal(overview.checkpoints[0].subject, "Перекрасить страницу");
    assert.equal(overview.checkpoints[0].runId, "run-2");
    assert.equal(overview.checkpoints[0].conversationId, "conv-1");
    assert.equal(overview.checkpoints[1].sha, first.checkpoint.sha);
    assert.deepEqual(overview.checkpoints[1].files, [{ path: "index.html", status: "added" }]);

    const rollback = await rollbackToCheckpoint(project.id, "user-changes", first.checkpoint.sha);
    assert.equal(rollback.checkpoint.kind, "rollback");
    assert.equal(rollback.checkpoint.revertedTo, first.checkpoint.sha);
    assert.equal(await readFile(path.join(sandbox, "index.html"), "utf8"), "<h1>Первая версия</h1>\n");
    await assert.rejects(() => readFile(path.join(sandbox, "styles.css"), "utf8"), /ENOENT/);

    const after = await changesOverview(project.id, "user-changes");
    assert.equal(after.checkpoints[0].kind, "rollback");
    assert.equal(after.checkpoints.length, 3);

    await assert.rejects(() => changesOverview(project.id, "другой-пользователь"), /Проект не найден/);
    await assert.rejects(() => rollbackToCheckpoint(project.id, "другой-пользователь", first.checkpoint.sha), /Проект не найден/);
  } finally {
    delete process.env.WEBNESTDEV_DATA_DIR;
    delete process.env.WEBNESTDEV_SANDBOX_DIR;
    await rm(root, { recursive: true, force: true });
  }
});
