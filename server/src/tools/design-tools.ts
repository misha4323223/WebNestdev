import { z } from "zod";
import path from "node:path";
import { registerTool } from "../tool-registry.js";
import { getProject } from "../project-store.js";
import { getSandbox } from "../sandbox-manager.js";
import { writeFileInside } from "../sandbox/path-guard.js";
import { THEME_FIELDS, THEME_FILE, parseTheme, patchTheme, themeFile } from "../design/theme.js";
import { findThemeFile } from "../design/theme-file.js";

/**
 * Тема проекта — тот же файл, который правит панель «Тема» в предпросмотре.
 *
 * Инструмент нужен агенту по двум причинам. Первая: пользователь может попросить палитру
 * словами («сделай темнее», «акцент под бренд»), и тогда менять надо те же токены, а не
 * придумывать свои. Вторая: в старом проекте файла темы нет, и его надо собрать по контракту —
 * иначе панель не сможет ничего перекрасить. Значения проверяются в design/theme.ts.
 */

const tokensSchema = z.record(z.string().min(1).max(60), z.string().min(1).max(300));

registerTool({
  name: "design.theme",
  description:
    "Read or change the project's design tokens — the very file the «Тема» panel in the Preview edits. " +
    "Without input it returns the current palette (name, label, value and allowed options for every token). " +
    "With {tokens} it rewrites just those values in theme.css and returns the new palette. " +
    "With {create:true} it writes a theme.css with the default contract when the project has none yet — do that before " +
    "styling a new project, then import the file once in the app entry and use var(--color-…) instead of hardcoded hex. " +
    "Never invent token names: only the documented set is accepted.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      tokens: {
        type: "object",
        description: "Токены для записи, например {\"--color-accent\":\"#e0603c\"}. Без объекта — только чтение.",
        additionalProperties: { type: "string" },
      },
      create: { type: "boolean", description: "Создать theme.css с набором по умолчанию, если файла темы ещё нет" },
    },
  },
  execute: async (input, context) => {
    const body = z.object({ tokens: tokensSchema.optional(), create: z.boolean().optional() }).parse(input ?? {});
    const project = await getProject(context.projectId);
    if (!project || project.userId !== context.userId) throw new Error("Проект не найден или недоступен");
    const root = (await getSandbox(project.id, project.userId)).root;

    let found = await findThemeFile(root);
    let created = false;
    if (!found && body.create) {
      await writeFileInside(root, path.join(root, THEME_FILE), themeFile());
      found = await findThemeFile(root);
      created = true;
    }
    if (!found) {
      return {
        present: false,
        fields: THEME_FIELDS,
        hint:
          "В проекте нет theme.css. Вызовите design.theme с {\"create\":true}, затем подключите файл один раз " +
          "в точке входа приложения и переведите цвета на var(--color-…).",
      };
    }

    let css = found.css;
    if (body.tokens && Object.keys(body.tokens).length) {
      css = patchTheme(css, body.tokens);
      await writeFileInside(root, path.join(root, found.file), css);
    }
    const tokens = parseTheme(css);
    return {
      present: true,
      created,
      file: found.file,
      tokens,
      fields: THEME_FIELDS.map(field => ({ ...field, current: tokens[field.variable] ?? null })),
      hint:
        "Панель «Тема» в предпросмотре меняет эти же значения без участия модели. Компоненты должны брать цвета " +
        "только через var(--color-…) — иначе смена палитры не дойдёт до страницы.",
    };
  },
});
