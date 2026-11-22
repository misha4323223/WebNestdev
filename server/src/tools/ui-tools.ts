import { registerTool } from "../tool-registry.js";
import { uiRenderJsonSchema, uiRenderSchema, uiValidationError } from "../agent/ui-schema.js";

/** Границы на весь ответ: UI не должен превращаться в мегабайт аргументов в истории. */
const MAX_SERIALIZED_UI = 36_000;

/**
 * `ui.render` — интерактивный ответ вместо длинного текста.
 *
 * Инструмент не выполняет код и не пишет HTML. Он принимает только блоки из
 * `agent/ui-schema.ts`; клиент рендерит их нативными компонентами, а кнопки и формы
 * возвращаются агенту обычным сообщением пользователя. Поэтому здесь нет отдельного
 * канала выполнения произвольных действий.
 */
registerTool({
  name: "ui.render",
  description:
    "Render a small interactive interface in the chat instead of a wall of prose. Use it proactively when the answer is a choice between options, a short form, a review checklist, a set of next actions, a small chart, a comparison table, a code diff, or viewport screenshots the user should switch between. Prefer one compact block over a long description; a genuine fork in the work should be asked as a choice, and a finished visible result should end with preview screenshots plus 2–4 next actions. Pass {blocks:[...]} with 1–6 blocks of type choice, form, actions, checklist, chart, table, diff, or preview. A button/form action/checklist item must contain a ready-to-send `prompt` for you — the user's click sends that prompt as their next message; never put HTML, JavaScript, shell commands, or arbitrary URLs in a block. Use `preview` for snapshots returned by browser.screenshot (paths like `.webnestdev/screenshots/…`); the block also renders a link to the running page. Blocks are persisted with the tool call, so they survive a reload. If the schema rejects the call, fix the exact field named in the error and call again; do not fall back to HTML. Example: {blocks:[{type:'choice',title:'Выберите стек',options:[{label:'React + Vite',prompt:'Сделай проект на React + Vite'},{label:'Next.js',prompt:'Сделай проект на Next.js'}]}]}.",
  parameters: uiRenderJsonSchema,
  execute: async input => {
    const parsed = uiRenderSchema.safeParse(input ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        code: "invalid_ui",
        error: "UI-блок не прошёл проверку: " + uiValidationError(parsed.error),
        hint: "Исправьте поле из ошибки и вызовите ui.render снова. Не вставляйте HTML и не заменяйте блок текстом, если интерактивность действительно нужна.",
      };
    }
    const serialized = JSON.stringify(parsed.data);
    if (serialized.length > MAX_SERIALIZED_UI) {
      return {
        ok: false,
        code: "ui_too_large",
        error: "Интерактивный ответ слишком большой (" + serialized.length + " символов).",
        hint: "Сократите diff, таблицу или текст блоков; оставьте только то, что нужно для решения.",
      };
    }
    return {
      ok: true,
      rendered: true,
      blocks: parsed.data.blocks.length,
      types: parsed.data.blocks.map(block => block.type),
      note: "Интерфейс показан в чате. Действия пользователя придут следующим сообщением.",
    };
  },
});
