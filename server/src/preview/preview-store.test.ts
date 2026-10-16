import test from "node:test";
import assert from "node:assert/strict";
import { getPreview,previewAddresses,removePreview,setPreview,setPreviewExecOnly,touchPreview,unsettlePreview } from "./preview-store.js";
import type { PreviewState } from "./types.js";

const PROJECT = "store-test";

function state(overrides: Partial<PreviewState> = {}): PreviewState {
  return { mode: "container", containerId: "c1", host: "172.19.0.5", port: 3000, projectId: PROJECT, startedAt: 0, lastUsedAt: 0, ...overrides };
}

/**
 * Пометка «панель идёт через `docker exec`» — точка встречи двух сторон: её ставит прокси, снимает
 * проверка адреса, а по её времени считается, когда повторять проверку (см. preview-manager.ts).
 */
test("the exec-only mark is set and cleared once, and carries the moment of the check", () => {
  try {
    setPreview(state());
    assert.equal(setPreviewExecOnly(PROJECT, true), true);
    assert.equal(getPreview(PROJECT)?.execOnly, true);
    assert.ok((getPreview(PROJECT)?.execOnlyCheckedAt ?? 0) > 0, "проверка отсчитывается от момента отметки");

    // Повторная установка ничего не меняет: вызов идёт из прокси на каждый файл приложения, и
    // обновление времени на каждом из них вернуло бы полную проверку адреса на каждый файл.
    const checkedAt = getPreview(PROJECT)?.execOnlyCheckedAt;
    assert.equal(setPreviewExecOnly(PROJECT, true), false);
    assert.equal(getPreview(PROJECT)?.execOnlyCheckedAt, checkedAt);

    assert.equal(setPreviewExecOnly(PROJECT, false), true);
    assert.equal(getPreview(PROJECT)?.execOnly, false);
    assert.equal(getPreview(PROJECT)?.execOnlyCheckedAt, undefined);

    // Статический предпросмотр в этой пометке не нуждается: он и так отдаётся самим сервером.
    setPreview({ ...state(), mode: "static" });
    assert.equal(setPreviewExecOnly(PROJECT, true), false);
    assert.equal(getPreview(PROJECT)?.execOnly, undefined);
  } finally {
    removePreview(PROJECT);
  }
});

test("a degraded preview is visible in the health line, not only as an unconfirmed address", () => {
  try {
    setPreview(state({ settled: false }));
    setPreviewExecOnly(PROJECT, true);
    touchPreview(PROJECT, Date.now());
    const [address] = previewAddresses();
    assert.equal(address.settled, false);
    assert.equal(address.viaExec, true, "без этого поля живой предпросмотр выглядел бы недоступным панели");
    assert.ok(address.execCheckedAt && address.execCheckedAt > 0);

    // Подтверждённый адрес возвращает состояние к обычному виду.
    setPreviewExecOnly(PROJECT, false);
    setPreview(state({ settled: true }));
    assert.equal(previewAddresses()[0].viaExec, false);
    assert.equal(previewAddresses()[0].settled, true);
    assert.equal(unsettlePreview(PROJECT), true);
    assert.equal(previewAddresses()[0].settled, false);
  } finally {
    removePreview(PROJECT);
  }
});
