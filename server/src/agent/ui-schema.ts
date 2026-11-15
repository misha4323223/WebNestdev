import { z } from "zod";
import { isSecretProjectPath } from "../secrets/secret-paths.js";

/**
 * Контракт интерактивных блоков чата.
 *
 * Блок — это не HTML и не произвольный код, а данные для небольшого набора наших
 * React-компонентов. Модель выбирает блок и заполняет поля; сервер проверяет форму и
 * ограничения, а клиент рендерит только известные типы. Поэтому здесь нет ни `html`,
 * ни `script`, ни произвольных ссылок: всё, что модель может сделать, — предложить
 * пользователю кнопку, форму, график, таблицу, diff или набор готовых снимков.
 */
export const UI_LIMITS = {
  blocks: 6,
  options: 12,
  fields: 12,
  actions: 6,
  columns: 8,
  rows: 30,
  series: 4,
  points: 24,
  images: 4,
  text: 600,
  prompt: 2000,
  code: 20_000,
} as const;

const text = z.string().trim().min(1).max(UI_LIMITS.text);
const optionalText = z.string().trim().max(UI_LIMITS.text).optional();
const label = z.string().trim().min(1).max(160);
const prompt = z.string().trim().min(1).max(UI_LIMITS.prompt);
const blockId = z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_.-]+$/).optional();

/** Путь к файлу проекта: только относительный, без выхода наверх и без схемы URL. */
export const uiAssetPath = z.string().trim().min(1).max(400).refine(value => {
  const normalized = value.replace(/\\/g, "/");
  return !normalized.startsWith("/")
    && !normalized.split("/").includes("..")
    && !/^[a-z][a-z0-9+.-]*:/i.test(normalized)
    && !isSecretProjectPath(normalized);
}, { message: "Нужен относительный путь внутри проекта" });

const choiceOption = z.object({
  label,
  description: optionalText,
  /** Готовый текст запроса; без него клиент отправит «Заголовок: вариант». */
  prompt: prompt.optional(),
}).strict();

export const choiceBlock = z.object({
  type: z.literal("choice"),
  id: blockId,
  title: text,
  description: optionalText,
  multiple: z.boolean().optional(),
  options: z.array(choiceOption).min(1).max(UI_LIMITS.options),
}).strict();

const formField = z.object({
  name: z.string().trim().min(1).max(40).regex(/^[a-z][a-z0-9_]*$/, "Имя поля: латиница, цифры и _"),
  label,
  type: z.enum(["text", "textarea", "select"]).optional(),
  placeholder: z.string().trim().max(200).optional(),
  required: z.boolean().optional(),
  options: z.array(label).min(1).max(UI_LIMITS.options).optional(),
}).strict().refine(value => value.type !== "select" || Boolean(value.options?.length), {
  message: "Для select нужны варианты options",
});

export const formBlock = z.object({
  type: z.literal("form"),
  id: blockId,
  title: text,
  description: optionalText,
  submitLabel: z.string().trim().min(1).max(80).optional(),
  submitPrompt: z.string().trim().max(UI_LIMITS.prompt).optional(),
  fields: z.array(formField).min(1).max(UI_LIMITS.fields),
}).strict();

const action = z.object({
  label,
  prompt,
  variant: z.enum(["primary", "secondary", "danger"]).optional(),
}).strict();

export const actionsBlock = z.object({
  type: z.literal("actions"),
  id: blockId,
  title: text,
  description: optionalText,
  actions: z.array(action).min(1).max(UI_LIMITS.actions),
}).strict();

const chartSeries = z.object({
  label,
  values: z.array(z.number().finite()).min(1).max(UI_LIMITS.points),
  color: z.string().trim().regex(/^#[0-9a-f]{3,8}$/i).optional(),
}).strict();

export const chartBlock = z.object({
  type: z.literal("chart"),
  id: blockId,
  title: text,
  description: optionalText,
  kind: z.enum(["bar", "line"]).optional(),
  labels: z.array(label).min(1).max(UI_LIMITS.points),
  series: z.array(chartSeries).min(1).max(UI_LIMITS.series),
  valueSuffix: z.string().trim().max(20).optional(),
}).strict().superRefine((value, context) => {
  value.series.forEach((series, index) => {
    if (series.values.length !== value.labels.length) {
      context.addIssue({
        code: "custom",
        path: ["series", index, "values"],
        message: "Количество значений должно совпадать с количеством labels",
      });
    }
  });
});

const tableCell = z.union([z.string().max(UI_LIMITS.text), z.number().finite()]);

export const tableBlock = z.object({
  type: z.literal("table"),
  id: blockId,
  title: optionalText,
  columns: z.array(label).min(1).max(UI_LIMITS.columns),
  rows: z.array(z.array(tableCell).min(1).max(UI_LIMITS.columns)).min(1).max(UI_LIMITS.rows),
}).strict().superRefine((value, context) => {
  value.rows.forEach((row, index) => {
    if (row.length !== value.columns.length) {
      context.addIssue({
        code: "custom",
        path: ["rows", index],
        message: "Количество ячеек должно совпадать с количеством columns",
      });
    }
  });
});

export const diffBlock = z.object({
  type: z.literal("diff"),
  id: blockId,
  title: optionalText,
  path: z.string().trim().max(400).refine(value => !isSecretProjectPath(value), { message: "Путь к секретному файлу не показывается" }).optional(),
  before: z.string().max(UI_LIMITS.code),
  after: z.string().max(UI_LIMITS.code),
}).strict();

const previewImage = z.object({
  label,
  path: uiAssetPath,
  alt: z.string().trim().max(300).optional(),
}).strict();

export const previewBlock = z.object({
  type: z.literal("preview"),
  id: blockId,
  title: optionalText,
  description: optionalText,
  images: z.array(previewImage).min(1).max(UI_LIMITS.images),
}).strict();

export const uiBlockSchema = z.discriminatedUnion("type", [
  choiceBlock,
  formBlock,
  actionsBlock,
  chartBlock,
  tableBlock,
  diffBlock,
  previewBlock,
]);

export const uiRenderSchema = z.object({
  blocks: z.array(uiBlockSchema).min(1).max(UI_LIMITS.blocks),
}).strict();

export type UiBlock = z.infer<typeof uiBlockSchema>;
export type UiRenderInput = z.infer<typeof uiRenderSchema>;

/** Первая понятная ошибка вместо простыни из zod: модель читает её и исправляет вызов. */
export function uiValidationError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Некорректный UI-блок";
  const where = issue.path.length ? issue.path.join(".") + ": " : "";
  return where + issue.message;
}

/** JSON Schema для описания инструмента: без неё модель угадывает форму и тратит шаг. */
export const uiRenderJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["blocks"],
  properties: {
    blocks: {
      type: "array",
      minItems: 1,
      maxItems: UI_LIMITS.blocks,
      description: "1–6 интерактивных блоков. Обязательные поля: choice — title+options; form — title+fields; actions — title+actions; chart — title+labels+series; table — columns+rows; diff — before+after; preview — images.",
      items: {
        type: "object",
        required: ["type"],
        properties: {
          type: { type: "string", enum: ["choice", "form", "actions", "chart", "table", "diff", "preview"] },
          id: { type: "string", description: "Необязательный стабильный id блока" },
          title: { type: "string" },
          description: { type: "string" },
          multiple: { type: "boolean", description: "choice: разрешить несколько вариантов" },
          options: {
            type: "array",
            description: "choice: объекты {label, description?, prompt?}; form select: строки вариантов",
            items: {
              anyOf: [
                {
                  type: "object",
                  required: ["label"],
                  properties: {
                    label: { type: "string" },
                    description: { type: "string" },
                    prompt: { type: "string", description: "Готовый запрос, который уйдёт агенту при выборе" },
                  },
                },
                { type: "string" },
              ],
            },
          },
          fields: {
            type: "array",
            description: "form: поля ввода",
            items: {
              type: "object",
              required: ["name", "label"],
              properties: {
                name: { type: "string", description: "Латинское имя поля: project_name" },
                label: { type: "string" },
                type: { type: "string", enum: ["text", "textarea", "select"] },
                placeholder: { type: "string" },
                required: { type: "boolean" },
                options: { type: "array", items: { type: "string" } },
              },
            },
          },
          submitLabel: { type: "string" },
          submitPrompt: { type: "string", description: "form: текст перед значениями полей" },
          actions: {
            type: "array",
            description: "actions: кнопки с готовым запросом агенту",
            items: {
              type: "object",
              required: ["label", "prompt"],
              properties: {
                label: { type: "string" },
                prompt: { type: "string" },
                variant: { type: "string", enum: ["primary", "secondary", "danger"] },
              },
            },
          },
          kind: { type: "string", enum: ["bar", "line"], description: "chart: тип графика" },
          labels: { type: "array", items: { type: "string" }, description: "chart: подписи точек" },
          series: {
            type: "array",
            description: "chart: ряды данных; длина values равна длине labels",
            items: {
              type: "object",
              required: ["label", "values"],
              properties: {
                label: { type: "string" },
                values: { type: "array", items: { type: "number" } },
                color: { type: "string", description: "HEX-цвет, например #cab898" },
              },
            },
          },
          valueSuffix: { type: "string" },
          columns: { type: "array", items: { type: "string" }, description: "table: заголовки" },
          rows: {
            type: "array",
            description: "table: строки; длина строки равна длине columns",
            items: { type: "array", items: { type: ["string", "number"] } },
          },
          path: { type: "string", description: "diff/preview: путь к файлу проекта" },
          before: { type: "string", description: "diff: старый текст" },
          after: { type: "string", description: "diff: новый текст" },
          images: {
            type: "array",
            description: "preview: готовые снимки из проекта",
            items: {
              type: "object",
              required: ["label", "path"],
              properties: {
                label: { type: "string" },
                path: { type: "string", description: "Относительный путь внутри проекта" },
                alt: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
} as const;
