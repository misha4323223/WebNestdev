import test from "node:test";
import assert from "node:assert/strict";
import {
  beginPreviewStart,
  clearPreviewStartProgress,
  getPreviewStartProgress,
  previewStartProgressLog,
  setPreviewStartProgress,
} from "./preview-start-progress.js";

test("a start reports its current phase and clears it afterwards", () => {
  const projectId = "progress-project";
  clearPreviewStartProgress(projectId);
  beginPreviewStart(projectId);
  assert.equal(getPreviewStartProgress(projectId)?.phase, "checking");

  setPreviewStartProgress(projectId, "installing", "Устанавливаем зависимости…", "12 пакетов");
  const progress = getPreviewStartProgress(projectId);
  assert.equal(progress?.phase, "installing");
  assert.equal(progress?.message, "Устанавливаем зависимости…");
  assert.equal(progress?.detail, "12 пакетов");
  assert.match(previewStartProgressLog(projectId), /Устанавливаем зависимости/);

  clearPreviewStartProgress(projectId);
  assert.equal(getPreviewStartProgress(projectId), null);
  assert.equal(previewStartProgressLog(projectId), "");
});

test("progress only updates a start that was explicitly begun", () => {
  const projectId = "not-started-project";
  clearPreviewStartProgress(projectId);
  setPreviewStartProgress(projectId, "building", "Собираем проект…");
  assert.equal(getPreviewStartProgress(projectId), null);
});
