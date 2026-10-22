import type { FastifyInstance } from "fastify";
import { z } from "zod";
import path from "node:path";
import { requireProjectUser } from "../auth/auth.js";
import { getSandbox } from "../sandbox-manager.js";
import { writeFileInside } from "../sandbox/path-guard.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { THEME_FIELDS, parseTheme, patchTheme } from "../design/theme.js";
import { findThemeFile } from "../design/theme-file.js";

/**
 * Тема проекта для панели предпросмотра.
 *
 * Панель меняет палитру без модели: значения пишутся в файл темы, который проект уже
 * использует, поэтому правка доезжает и в предпросмотр, и в собранный сайт. Файл определяется
 * по контракту из `design/theme.ts`, значение каждого токена проверяется там же — сюда
 * приходит уже безопасный текст.
 */

function themeReply(found: { file: string; css: string } | null) {
  return {
    present: Boolean(found),
    file: found?.file ?? null,
    tokens: found ? parseTheme(found.css) : {},
    fields: THEME_FIELDS,
  };
}

export async function registerThemeRoutes(app: FastifyInstance) {
  app.get("/api/projects/:id/theme", async (request, reply) => {
    const p = z.object({ id: z.string().min(1) }).parse(request.params);
    const user = await requireProjectUser(request, reply, p.id);
    if (!user) return;
    applyNoStoreToReply(reply);
    const sandbox = await getSandbox(p.id, user.id);
    return themeReply(await findThemeFile(sandbox.root));
  });

  /**
   * Запись палитры. Отказ, когда файла темы нет, — честный ответ, а не создание пустого файла:
   * переменные, которые никто не использует, ничего не перекрасят, и «сохранилось» было бы
   * ложью. Такой проект получает в панели кнопку «Собрать тему» — это работа агента.
   */
  app.put("/api/projects/:id/theme", async (request, reply) => {
    const p = z.object({ id: z.string().min(1) }).parse(request.params);
    const user = await requireProjectUser(request, reply, p.id);
    if (!user) return;
    const body = z.object({ tokens: z.record(z.string().min(1).max(60), z.string().min(1).max(300)) }).parse(request.body);
    const sandbox = await getSandbox(p.id, user.id);
    const found = await findThemeFile(sandbox.root);
    if (!found) {
      return reply.code(409).send({
        error: "В проекте нет файла темы (theme.css) — попросите агента собрать тему, а затем меняйте палитру здесь.",
      });
    }
    let css: string;
    try {
      css = patchTheme(found.css, body.tokens);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    await writeFileInside(sandbox.root, path.join(sandbox.root, found.file), css);
    applyNoStoreToReply(reply);
    return themeReply({ file: found.file, css });
  });
}
