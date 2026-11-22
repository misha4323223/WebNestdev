import test from "node:test";
import assert from "node:assert/strict";
import { uiRenderSchema, uiValidationError } from "./ui-schema.js";

const validBlocks = [
  {
    type: "choice",
    title: "Выберите стек",
    options: [
      { label: "React + Vite", prompt: "Сделай проект на React + Vite" },
      { label: "Next.js", prompt: "Сделай проект на Next.js" },
    ],
  },
  {
    type: "form",
    title: "Бриф проекта",
    fields: [
      { name: "project_name", label: "Название", required: true },
      { name: "notes", label: "Пожелания", type: "textarea" },
    ],
  },
  {
    type: "actions",
    title: "Что дальше?",
    actions: [{ label: "Запустить превью", prompt: "Запусти превью и проверь главную" }],
  },
  {
    type: "checklist",
    title: "Что проверить",
    items: [
      { label: "Главная", description: "Первый экран и меню", prompt: "Проверь главную", checked: true },
      { label: "Мобильная вёрстка", prompt: "Проверь мобильный вид" },
    ],
  },
  {
    type: "chart",
    title: "Метрики",
    labels: ["A", "B"],
    series: [{ label: "Визиты", values: [3, 5] }],
  },
  {
    type: "table",
    title: "Сравнение",
    columns: ["Пункт", "Статус"],
    rows: [["Превью", "готово"], ["Сборка", "нет"]],
  },
  {
    type: "diff",
    title: "Правка",
    path: "src/app.ts",
    before: "const a = 1;",
    after: "const a = 2;",
  },
  {
    type: "preview",
    title: "Экраны",
    images: [{ label: "Desktop", path: ".webnestdev/screenshots/desktop.png" }],
  },
];

test("схема принимает каждый поддерживаемый тип интерактивного блока", () => {
  for (const block of validBlocks) {
    const result = uiRenderSchema.safeParse({ blocks: [block] });
    assert.equal(result.success, true, block.type);
  }
});

test("схема отклоняет неизвестный тип, HTML и произвольный URL в снимке", () => {
  const unknown = uiRenderSchema.safeParse({ blocks: [{ type: "html", title: "x" }] });
  assert.equal(unknown.success, false);
  if (!unknown.success) assert.match(uiValidationError(unknown.error), /type|Invalid/i);

  const unsafePath = uiRenderSchema.safeParse({
    blocks: [{ type: "preview", images: [{ label: "x", path: "https://example.com/a.png" }] }],
  });
  assert.equal(unsafePath.success, false);

  const traversal = uiRenderSchema.safeParse({
    blocks: [{ type: "preview", images: [{ label: "x", path: "../secret.png" }] }],
  });
  assert.equal(traversal.success, false);

  const secret = uiRenderSchema.safeParse({
    blocks: [{ type: "preview", images: [{ label: "x", path: ".env.local" }] }],
  });
  assert.equal(secret.success, false);

  const secretDiff = uiRenderSchema.safeParse({
    blocks: [{ type: "diff", path: "apps/web/.env.production", before: "A=1", after: "A=2" }],
  });
  assert.equal(secretDiff.success, false);
});

test("схема проверяет длины графиков и таблиц, а не молча рисует сдвиг", () => {
  const chart = uiRenderSchema.safeParse({
    blocks: [{ type: "chart", title: "x", labels: ["A", "B"], series: [{ label: "s", values: [1] }] }],
  });
  assert.equal(chart.success, false);

  const table = uiRenderSchema.safeParse({
    blocks: [{ type: "table", columns: ["A", "B"], rows: [["one"]] }],
  });
  assert.equal(table.success, false);
});

test("схема не принимает пустой чек-лист и пункт без подписи", () => {
  const empty = uiRenderSchema.safeParse({ blocks: [{ type: "checklist", title: "x", items: [] }] });
  assert.equal(empty.success, false);

  const blank = uiRenderSchema.safeParse({ blocks: [{ type: "checklist", title: "x", items: [{ description: "без подписи" }] }] });
  assert.equal(blank.success, false);
});

test("схема ограничивает количество блоков", () => {
  const result = uiRenderSchema.safeParse({ blocks: Array.from({ length: 7 }, (_, index) => ({
    type: "actions",
    title: "Шаг " + index,
    actions: [{ label: "Дальше", prompt: "Продолжай" }],
  })) });
  assert.equal(result.success, false);
});
