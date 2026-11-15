import { describe, expect, it } from "vitest";
import type { UiBlock } from "./ui-blocks";
import { flattenLiveUi, removeLiveUiCall, upsertLiveUiCall } from "./ui-live";

const choice: UiBlock = {
  type: "choice",
  title: "Стек",
  options: [{ label: "React", prompt: "Сделай на React" }],
};

const table: UiBlock = {
  type: "table",
  title: "Сравнение",
  columns: ["Пункт", "Статус"],
  rows: [["Сборка", "ok"]],
};

const preview: UiBlock = {
  type: "preview",
  title: "Экраны",
  images: [{ label: "Desktop", path: ".webnestdev/screenshots/desktop.png" }],
};

describe("live ui calls", () => {
  it("сохраняет блоки обоих вызовов ui.render, а не последний", () => {
    let calls = upsertLiveUiCall([], "call-1", [choice, table]);
    calls = upsertLiveUiCall(calls, "call-2", [preview]);
    expect(flattenLiveUi(calls)).toEqual([choice, table, preview]);
  });

  it("повторное событие с тем же toolCallId не дублирует блоки", () => {
    let calls = upsertLiveUiCall([], "call-1", [choice]);
    calls = upsertLiveUiCall(calls, "call-1", [choice]);
    expect(calls).toHaveLength(1);
    expect(flattenLiveUi(calls)).toEqual([choice]);
  });

  it("ошибка второго вызова убирает только его блоки", () => {
    let calls = upsertLiveUiCall([], "call-1", [choice]);
    calls = upsertLiveUiCall(calls, "call-2", [preview]);
    calls = removeLiveUiCall(calls, "call-2");
    expect(flattenLiveUi(calls)).toEqual([choice]);
  });
});
