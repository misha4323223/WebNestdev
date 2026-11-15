import { describe, expect, it } from "vitest";
import { choicePrompt, formPrompt, isSafeUiAssetPath, parseUiBlocks } from "./ui-blocks";

describe("ui-blocks", () => {
  it("принимает проверенные блоки и сохраняет готовые запросы", () => {
    const blocks = parseUiBlocks({ blocks: [
      {
        type: "choice",
        title: "Стек",
        options: [{ label: "React", prompt: "Сделай на React" }],
      },
      {
        type: "form",
        title: "Бриф",
        fields: [{ name: "project_name", label: "Название", required: true }],
      },
    ] });
    expect(blocks).toHaveLength(2);
    expect(blocks?.[0]).toMatchObject({ type: "choice", title: "Стек" });
    expect(blocks?.[1]).toMatchObject({ type: "form", fields: [{ name: "project_name" }] });
  });

  it("не пропускает неизвестный тип, HTML и опасный путь", () => {
    expect(parseUiBlocks({ blocks: [{ type: "html", title: "x" }] })).toBeNull();
    expect(parseUiBlocks({ blocks: [{ type: "preview", images: [{ label: "x", path: "https://evil.test/a.png" }] }] })).toBeNull();
    expect(parseUiBlocks({ blocks: [{ type: "preview", images: [{ label: "x", path: "../.env" }] }] })).toBeNull();
    expect(parseUiBlocks({ blocks: [] })).toBeNull();
  });

  it("принимает таблицу с пустой ячейкой так же, как серверная схема", () => {
    const blocks = parseUiBlocks({ blocks: [{ type: "table", columns: ["Поле", "Статус"], rows: [["Сборка", ""]] }] });
    expect(blocks?.[0]).toMatchObject({ type: "table", rows: [["Сборка", ""]] });
  });

  it("проверяет относительный путь без выхода из проекта", () => {
    expect(isSafeUiAssetPath(".webnestdev/screenshots/desktop.png")).toBe(true);
    expect(isSafeUiAssetPath("public/images/hero.webp")).toBe(true);
    expect(isSafeUiAssetPath("/etc/passwd")).toBe(false);
    expect(isSafeUiAssetPath("public/../../secret")).toBe(false);
    expect(isSafeUiAssetPath("javascript:alert(1)")).toBe(false);
    expect(isSafeUiAssetPath("apps/web/.env.production")).toBe(false);
  });

  it("собирает текст выбора и формы для следующего сообщения агенту", () => {
    const choice = {
      type: "choice" as const,
      title: "Стек",
      options: [
        { label: "React", prompt: "Сделай на React" },
        { label: "Next.js", prompt: "Сделай на Next.js" },
      ],
    };
    expect(choicePrompt(choice, ["React"])).toBe("Сделай на React");
    expect(choicePrompt(choice, ["React", "Next.js"])).toContain("Сделай на React");

    const form = {
      type: "form" as const,
      title: "Бриф",
      submitPrompt: "Создай проект по брифу",
      fields: [
        { name: "project_name", label: "Название" },
        { name: "notes", label: "Пожелания" },
      ],
    };
    expect(formPrompt(form, { project_name: "Nest", notes: "" })).toBe("Создай проект по брифу\n- Название: Nest");
    expect(formPrompt(form, {})).toBe("");
  });
});
