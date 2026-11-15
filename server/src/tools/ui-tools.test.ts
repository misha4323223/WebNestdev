import test from "node:test";
import assert from "node:assert/strict";
import { getTool } from "../tool-registry.js";
import "./ui-tools.js";

async function run(input: unknown) {
  const tool = getTool("ui.render");
  assert.ok(tool?.execute);
  return tool.execute(input, { projectId: "p", runId: "r", userId: "u" }) as Promise<{
    ok?: boolean;
    code?: string;
    error?: string;
    blocks?: number;
    types?: string[];
    hint?: string;
  }>;
}

test("ui.render возвращает подтверждение и типы проверенных блоков", async () => {
  const result = await run({
    blocks: [{
      type: "choice",
      title: "Что делаем?",
      options: [{ label: "Превью", prompt: "Запусти превью" }],
    }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.blocks, 1);
  assert.deepEqual(result.types, ["choice"]);
});

test("ui.render объясняет ошибку схемы и не роняет запуск", async () => {
  const result = await run({ blocks: [{ type: "html", title: "x" }] });
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_ui");
  assert.match(result.error ?? "", /UI-блок/);
  assert.match(result.hint ?? "", /Исправьте/);
});

test("ui.render ограничивает общий размер ответа, а не только отдельные поля", async () => {
  const text = "x".repeat(20_000);
  const result = await run({
    blocks: [{ type: "diff", before: text, after: text }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "ui_too_large");
  assert.match(result.hint ?? "", /Сократите/);
});

test("ui.render отклоняет пустой набор и опасный путь к снимку", async () => {
  const empty = await run({ blocks: [] });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, "invalid_ui");

  const unsafe = await run({
    blocks: [{ type: "preview", images: [{ label: "Секрет", path: "../../.env.local" }] }],
  });
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.code, "invalid_ui");
});
