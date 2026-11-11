import test from "node:test";
import assert from "node:assert/strict";
import { listPreviewContainerIds, previewStatus } from "./preview-manager.js";
import { PREVIEW_LABEL } from "./preview/types.js";
import { getPreview, removePreview, setPreview } from "./preview/preview-store.js";

/**
 * Подтверждённый адрес — это адрес, на который уже ответил сам сервер, поэтому чтение статуса не должно
 * ходить в контейнер: прокси читает статус на каждый файл приложения, а `docker exec` стоит сотни
 * миллисекунд. До этой проверки каждая загрузка модуля через панель платила лишний раунд, и приложение
 * в панели грузилось заметно медленнее, чем по прямому адресу, которым пользуется Chromium.
 *
 * Замер времени здесь не украшение: без него проверка молча проходила бы и там, где Docker есть, —
 * `docker exec` успел бы отработать и вернуть то же самое.
 */
test("a confirmed address is served without a container round-trip on every status read", async () => {
  setPreview({ mode: "container", containerId: "c1", projectId: "p1", host: "172.19.0.4", port: 5173, startedAt: 1, lastUsedAt: 1, settled: true });
  try {
    const started = Date.now();
    const status = await previewStatus("p1");
    const elapsed = Date.now() - started;
    assert.deepEqual(status, {
      running: true,
      ready: true,
      settled: true,
      mode: "container",
      port: 5173,
      host: "172.19.0.4",
      containerId: "c1",
      startedAt: 1,
    });
    assert.ok(elapsed < 100, "подтверждённый адрес не должен ждать контейнера: " + elapsed + " мс");
    assert.ok((getPreview("p1")?.lastUsedAt ?? 0) >= 1, "чтение статуса считается использованием — иначе предпросмотр остановит сборщик по бездействию");
  } finally {
    removePreview("p1");
  }
});

/**
 * Без `--no-trunc` Docker отдаёт короткие ID, а общий реестр хранит полный: уборщик не узнавал
 * живой предпросмотр и удалял его при каждом старте API (проверено на node-2 11.11.2026).
 */
test("the reap lists preview containers with full ids", async () => {
  const calls: string[][] = [];
  const ids = await listPreviewContainerIds(async args => {
    calls.push(args);
    return { code: 0, stdout: "abc123\n789def\n" };
  });
  assert.deepEqual(calls[0], ["ps", "-aq", "--no-trunc", "--filter", "label=" + PREVIEW_LABEL]);
  assert.deepEqual(ids, ["abc123", "789def"]);
});

test("a failed container listing reaps nothing", async () => {
  assert.deepEqual(await listPreviewContainerIds(async () => ({ code: 1, stdout: "ignored" })), []);
});

test("a project without a preview reports nothing running", async () => {
  removePreview("p2");
  assert.deepEqual(await previewStatus("p2"), { running: false });
});
