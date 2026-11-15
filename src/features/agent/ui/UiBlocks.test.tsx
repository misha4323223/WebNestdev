import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { UiBlock } from "../../../lib/ui-blocks";
import { UiBlocks } from "./UiBlocks";

describe("UiBlocks", () => {
  it("отправляет готовый запрос при выборе варианта", () => {
    const onAction = vi.fn();
    const blocks: UiBlock[] = [{
      type: "choice",
      title: "Стек",
      options: [{ label: "React", prompt: "Сделай на React + Vite" }],
    }];
    render(<UiBlocks blocks={blocks} projectId="p1" onAction={onAction}/>);
    fireEvent.click(screen.getByRole("button", { name: /React/ }));
    expect(onAction).toHaveBeenCalledWith("Сделай на React + Vite");
  });

  it("собирает значения формы в запрос и не отправляет пустую обязательную форму", () => {
    const onAction = vi.fn();
    const blocks: UiBlock[] = [{
      type: "form",
      title: "Бриф",
      submitPrompt: "Создай проект по брифу",
      fields: [
        { name: "project_name", label: "Название", required: true },
        { name: "notes", label: "Пожелания", type: "textarea" },
      ],
    }];
    render(<UiBlocks blocks={blocks} projectId="p1" onAction={onAction}/>);
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Название");

    fireEvent.change(screen.getByLabelText(/Название/), { target: { value: "Nest" } });
    fireEvent.change(screen.getByLabelText(/Пожелания/), { target: { value: "Тёмная тема" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    expect(onAction).toHaveBeenCalledWith("Создай проект по брифу\n- Название: Nest\n- Пожелания: Тёмная тема");
  });

  it("рисует chart, table, diff и preview без исполнения разметки", () => {
    const onAction = vi.fn();
    const blocks: UiBlock[] = [
      { type: "chart", title: "Метрики", labels: ["A", "B"], series: [{ label: "Визиты", values: [1, 2] }] },
      { type: "table", title: "Сравнение", columns: ["Пункт", "Статус"], rows: [["Сборка", "ok"]] },
      { type: "diff", title: "Правка", path: "src/a.ts", before: "const a = 1;", after: "const a = 2;" },
      { type: "preview", title: "Экраны", images: [{ label: "Desktop", path: ".webnestdev/screenshots/desktop.png" }] },
    ];
    const { container } = render(<UiBlocks blocks={blocks} projectId="p1" onAction={onAction}/>);
    expect(screen.getByRole("img", { name: "Метрики" })).toBeTruthy();
    expect(container.querySelector(".ui-table")?.textContent).toContain("Сборка");
    expect(container.querySelector(".ui-diff")?.textContent).toContain("const a = 2;");
    expect(container.querySelector(".ui-preview")?.textContent).toContain("Desktop");
    expect(container.querySelector(".ui-diff-code")?.textContent).toContain("+const a = 2;");
    expect(onAction).not.toHaveBeenCalled();
  });
});
