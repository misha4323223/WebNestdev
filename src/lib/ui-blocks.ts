/**
 * Клиентский контракт интерактивных блоков. Он повторяет серверную схему
 * (`server/src/agent/ui-schema.ts`), но остаётся защитным: блоки из старой истории,
 * live-событий или чужого ответа рендерятся только после этой проверки.
 *
 * Никакого HTML здесь нет и быть не должно: каждый блок — данные для нашего
 * React-компонента, а действия — обычный текст следующего сообщения агенту.
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

export type UiChoiceOption = { label: string; description?: string; prompt?: string };
export type UiChoiceBlock = {
  type: "choice";
  id?: string;
  title: string;
  description?: string;
  multiple?: boolean;
  options: UiChoiceOption[];
};
export type UiFormField = {
  name: string;
  label: string;
  type?: "text" | "textarea" | "select";
  placeholder?: string;
  required?: boolean;
  options?: string[];
};
export type UiFormBlock = {
  type: "form";
  id?: string;
  title: string;
  description?: string;
  submitLabel?: string;
  submitPrompt?: string;
  fields: UiFormField[];
};
export type UiAction = { label: string; prompt: string; variant?: "primary" | "secondary" | "danger" };
export type UiActionsBlock = { type: "actions"; id?: string; title: string; description?: string; actions: UiAction[] };
export type UiChartSeries = { label: string; values: number[]; color?: string };
export type UiChartBlock = {
  type: "chart";
  id?: string;
  title: string;
  description?: string;
  kind?: "bar" | "line";
  labels: string[];
  series: UiChartSeries[];
  valueSuffix?: string;
};
export type UiTableBlock = {
  type: "table";
  id?: string;
  title?: string;
  columns: string[];
  rows: Array<Array<string | number>>;
};
export type UiDiffBlock = { type: "diff"; id?: string; title?: string; path?: string; before: string; after: string };
export type UiPreviewImage = { label: string; path: string; alt?: string };
export type UiPreviewBlock = {
  type: "preview";
  id?: string;
  title?: string;
  description?: string;
  images: UiPreviewImage[];
};
export type UiBlock =
  | UiChoiceBlock
  | UiFormBlock
  | UiActionsBlock
  | UiChartBlock
  | UiTableBlock
  | UiDiffBlock
  | UiPreviewBlock;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tableCell(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return typeof value === "string" && value.length <= UI_LIMITS.text ? value : null;
}

function text(value: unknown, max: number = UI_LIMITS.text): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function optionalText(value: unknown, max: number = UI_LIMITS.text): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

function idValue(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(value) ? value : undefined;
}

function arrayValue(value: unknown, max: number): unknown[] | null {
  return Array.isArray(value) && value.length > 0 && value.length <= max ? value : null;
}

/** Путь к файлу проекта: только относительный, без выхода наверх и без URL-схемы. */
export function isSafeUiAssetPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.trim().replace(/\\/g, "/");
  return Boolean(normalized)
    && normalized.length <= 400
    && !normalized.startsWith("/")
    && !normalized.split("/").includes("..")
    && !/^[a-z][a-z0-9+.-]*:/i.test(normalized)
    && !isSecretPath(normalized);
}

function parseChoice(value: Record<string, unknown>): UiChoiceBlock | null {
  const title = text(value.title);
  const options = arrayValue(value.options, UI_LIMITS.options);
  if (!title || !options) return null;
  const parsed = options.map(option => {
    if (!isRecord(option)) return null;
    const label = text(option.label, 160);
    if (!label) return null;
    return {
      label,
      ...(optionalText(option.description) ? { description: optionalText(option.description) } : {}),
      ...(text(option.prompt, UI_LIMITS.prompt) ? { prompt: text(option.prompt, UI_LIMITS.prompt)! } : {}),
    };
  });
  if (parsed.some(option => !option)) return null;
  return {
    type: "choice",
    ...(idValue(value.id) ? { id: idValue(value.id) } : {}),
    title,
    ...(optionalText(value.description) ? { description: optionalText(value.description) } : {}),
    ...(value.multiple === true ? { multiple: true } : {}),
    options: parsed as UiChoiceOption[],
  };
}

function parseFormField(value: unknown): UiFormField | null {
  if (!isRecord(value)) return null;
  const name = text(value.name, 40);
  const label = text(value.label, 160);
  if (!name || !/^[a-z][a-z0-9_]*$/.test(name) || !label) return null;
  const type = value.type === "textarea" || value.type === "select" ? value.type : "text";
  const options = type === "select" ? arrayValue(value.options, UI_LIMITS.options)?.map(item => text(item, 160)) : undefined;
  if (type === "select" && (!options || options.some(option => !option))) return null;
  return {
    name,
    label,
    type,
    ...(optionalText(value.placeholder, 200) ? { placeholder: optionalText(value.placeholder, 200) } : {}),
    ...(value.required === true ? { required: true } : {}),
    ...(options ? { options: options as string[] } : {}),
  };
}

function parseForm(value: Record<string, unknown>): UiFormBlock | null {
  const title = text(value.title);
  const fields = arrayValue(value.fields, UI_LIMITS.fields);
  if (!title || !fields) return null;
  const parsed = fields.map(parseFormField);
  if (parsed.some(field => !field)) return null;
  return {
    type: "form",
    ...(idValue(value.id) ? { id: idValue(value.id) } : {}),
    title,
    ...(optionalText(value.description) ? { description: optionalText(value.description) } : {}),
    ...(text(value.submitLabel, 80) ? { submitLabel: text(value.submitLabel, 80)! } : {}),
    ...(text(value.submitPrompt, UI_LIMITS.prompt) ? { submitPrompt: text(value.submitPrompt, UI_LIMITS.prompt)! } : {}),
    fields: parsed as UiFormField[],
  };
}

function parseActions(value: Record<string, unknown>): UiActionsBlock | null {
  const title = text(value.title);
  const actions = arrayValue(value.actions, UI_LIMITS.actions);
  if (!title || !actions) return null;
  const parsed = actions.map(action => {
    if (!isRecord(action)) return null;
    const label = text(action.label, 160);
    const prompt = text(action.prompt, UI_LIMITS.prompt);
    if (!label || !prompt) return null;
    const variant = action.variant === "secondary" || action.variant === "danger" ? action.variant : "primary";
    return { label, prompt, variant };
  });
  if (parsed.some(action => !action)) return null;
  return {
    type: "actions",
    ...(idValue(value.id) ? { id: idValue(value.id) } : {}),
    title,
    ...(optionalText(value.description) ? { description: optionalText(value.description) } : {}),
    actions: parsed as UiAction[],
  };
}

function parseChart(value: Record<string, unknown>): UiChartBlock | null {
  const title = text(value.title);
  const labels = arrayValue(value.labels, UI_LIMITS.points)?.map(label => text(label, 160));
  const series = arrayValue(value.series, UI_LIMITS.series);
  if (!title || !labels || labels.some(label => !label) || !series) return null;
  const parsed = series.map(item => {
    if (!isRecord(item)) return null;
    const label = text(item.label, 160);
    if (!label || !Array.isArray(item.values) || item.values.length !== labels.length) return null;
    const values = item.values.map(value => typeof value === "number" && Number.isFinite(value) ? value : NaN);
    if (values.some(value => Number.isNaN(value))) return null;
    return {
      label,
      values,
      ...(typeof item.color === "string" && /^#[0-9a-f]{3,8}$/i.test(item.color) ? { color: item.color } : {}),
    };
  });
  if (parsed.some(item => !item)) return null;
  return {
    type: "chart",
    ...(idValue(value.id) ? { id: idValue(value.id) } : {}),
    title,
    ...(optionalText(value.description) ? { description: optionalText(value.description) } : {}),
    ...(value.kind === "line" ? { kind: "line" as const } : { kind: "bar" as const }),
    labels: labels as string[],
    series: parsed as UiChartSeries[],
    ...(optionalText(value.valueSuffix, 20) ? { valueSuffix: optionalText(value.valueSuffix, 20) } : {}),
  };
}

function parseTable(value: Record<string, unknown>): UiTableBlock | null {
  const columns = arrayValue(value.columns, UI_LIMITS.columns)?.map(item => text(item, 160));
  const rows = arrayValue(value.rows, UI_LIMITS.rows);
  if (!columns || columns.some(item => !item) || !rows) return null;
  const parsed = rows.map(row => {
    if (!Array.isArray(row) || row.length !== columns.length) return null;
    return row.map(tableCell);
  });
  if (parsed.some(row => !row || row.some(cell => cell === null))) return null;
  return {
    type: "table",
    ...(idValue(value.id) ? { id: idValue(value.id) } : {}),
    ...(optionalText(value.title) ? { title: optionalText(value.title) } : {}),
    columns: columns as string[],
    rows: parsed as Array<Array<string | number>>,
  };
}

function isSecretPath(value: unknown) {
  if (typeof value !== "string") return false;
  const basename = value.replace(/\\/g, "/").split("/").pop() ?? "";
  return /^\.env(?:$|\.)/i.test(basename) && !/^\.env\.(?:example|sample|template)$/i.test(basename);
}

function parseDiff(value: Record<string, unknown>): UiDiffBlock | null {
  if (typeof value.before !== "string" || typeof value.after !== "string") return null;
  if (value.before.length > UI_LIMITS.code || value.after.length > UI_LIMITS.code) return null;
  return {
    type: "diff",
    ...(idValue(value.id) ? { id: idValue(value.id) } : {}),
    ...(optionalText(value.title) ? { title: optionalText(value.title) } : {}),
    ...(optionalText(value.path, 400) && !isSecretPath(value.path) ? { path: optionalText(value.path, 400) } : {}),
    before: value.before,
    after: value.after,
  };
}

function parsePreview(value: Record<string, unknown>): UiPreviewBlock | null {
  const images = arrayValue(value.images, UI_LIMITS.images);
  if (!images) return null;
  const parsed = images.map(image => {
    if (!isRecord(image)) return null;
    const label = text(image.label, 160);
    if (!label || !isSafeUiAssetPath(image.path)) return null;
    return {
      label,
      path: image.path.trim(),
      ...(optionalText(image.alt, 300) ? { alt: optionalText(image.alt, 300) } : {}),
    };
  });
  if (parsed.some(image => !image)) return null;
  return {
    type: "preview",
    ...(idValue(value.id) ? { id: idValue(value.id) } : {}),
    ...(optionalText(value.title) ? { title: optionalText(value.title) } : {}),
    ...(optionalText(value.description) ? { description: optionalText(value.description) } : {}),
    images: parsed as UiPreviewImage[],
  };
}

function parseBlock(value: unknown): UiBlock | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "choice": return parseChoice(value);
    case "form": return parseForm(value);
    case "actions": return parseActions(value);
    case "chart": return parseChart(value);
    case "table": return parseTable(value);
    case "diff": return parseDiff(value);
    case "preview": return parsePreview(value);
    default: return null;
  }
}

/** Разбирает аргумент инструмента `ui.render`: `{ blocks: [...] }` или сам массив. */
export function parseUiBlocks(input: unknown): UiBlock[] | null {
  const raw = Array.isArray(input) ? input : isRecord(input) ? input.blocks : null;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > UI_LIMITS.blocks) return null;
  const parsed = raw.map(parseBlock);
  return parsed.some(block => !block) ? null : parsed as UiBlock[];
}

/** Текст запроса при выборе одного или нескольких вариантов. */
export function choicePrompt(block: UiChoiceBlock, labels: string[]) {
  const selected = block.options.filter(option => labels.includes(option.label));
  if (!selected.length) return "";
  const values = selected.map(option => option.prompt ?? option.label);
  return selected.length === 1
    ? values[0]
    : block.title + ":\n" + values.map(value => "- " + value).join("\n");
}

/** Текст запроса из формы: заголовок, подсказка и только заполненные поля. */
export function formPrompt(block: UiFormBlock, values: Record<string, string>) {
  const lines = block.fields
    .map(field => {
      const value = (values[field.name] ?? "").trim();
      return value ? "- " + field.label + ": " + value : "";
    })
    .filter(Boolean);
  if (!lines.length) return "";
  return (block.submitPrompt?.trim() || block.title) + "\n" + lines.join("\n");
}
