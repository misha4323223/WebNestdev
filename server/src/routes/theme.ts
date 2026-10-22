import type { FastifyInstance } from "fastify";
import { z } from "zod";
import path from "node:path";
import { requireProjectUser } from "../auth/auth.js";
import { getSandbox } from "../sandbox-manager.js";
import { writeFileInside } from "../sandbox/path-guard.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { THEME_FILE, THEME_FIELDS, parseTheme, patchTheme, themeFile } from "../design/theme.js";
import { findThemeFile, usesThemeTokens, type FoundTheme } from "../design/theme-file.js";
import { refreshStaticPreview } from "../preview/static-preview.js";

/**
 * Тема проекта для панели предпросмотра.
 *
 * Панель меняет палитру без модели: значения пишутся в файл темы, который проект уже
 * использует, поэтому правка доезжает и в предпросмотр, и в собранный сайт. Файл определяется
 * по контракту из `design/theme.ts`, значение каждого токена проверяется там же — сюда
 * приходит уже безопасный текст.
 */

function themeReply(found: FoundTheme | null, used = false, created = false) {
  return {
    present: Boolean(found),
    file: found?.file ?? null,
    tokens: found ? parseTheme(found.css) : {},
    fields: THEME_FIELDS,
    /** Читают ли стили и разметка проекта переменные темы: без этого палитра ничего не перекрасит. */
    used,
    /** Файл только что создан этим запросом — панель говорит это словами, а не догадкой. */
    created,
  };
}

export async function registerThemeRoutes(app: FastifyInstance) {
  app.get("/api/projects/:id/theme", async (request, reply) => {
    const p = z.object({ id: z.string().min(1) }).parse(request.params);
    const user = await requireProjectUser(request, reply, p.id);
    if (!user) return;
    applyNoStoreToReply(reply);
    const sandbox = await getSandbox(p.id, user.id);
    const found = await findThemeFile(sandbox.root);
    return themeReply(found, found ? await usesThemeTokens(sandbox.root) : false);
  });

  /**
   * Создание файла темы. Панель вызывает это сама, когда открывают «Палитру» у проекта без
   * `theme.css`: без файла панели нечего править, а отправлять человека к агенту за одной
   * таблицей значений — лишний прогон модели. Существующий файл не перезаписывается никогда:
   * ответ отдаёт текущую тему, поэтому нажатие не может стереть чужие правки.
   */
  app.post("/api/projects/:id/theme", async (request, reply) => {
    const p = z.object({ id: z.string().min(1) }).parse(request.params);
    const user = await requireProjectUser(request, reply, p.id);
    if (!user) return;
    const sandbox = await getSandbox(p.id, user.id);
    const existing = await findThemeFile(sandbox.root);
    if (existing) {
      applyNoStoreToReply(reply);
      return themeReply(existing, await usesThemeTokens(sandbox.root));
    }
    await writeFileInside(sandbox.root, path.join(sandbox.root, THEME_FILE), themeFile());
    // Статический предпросмотр отдаёт сборку: новый файл попадёт в неё только после пересборки,
    // иначе добавленный токен не появится на странице до перезапуска предпросмотра.
    await refreshStaticPreview(p.id).catch(error => console.warn("[theme] предпросмотр не пересобран", error));
    const created = await findThemeFile(sandbox.root);
    applyNoStoreToReply(reply);
    return themeReply(created, created ? await usesThemeTokens(sandbox.root) : false, true);
  });

  /**
   * Запись палитры. Отказ, когда файла темы нет, — честный ответ, а не создание пустого файла:
   * переменные, которые никто не использует, ничего не перекрасят, и «сохранилось» было бы
   * ложью. Такой проект получает в панели кнопку «Создать палитру» (см. POST выше).
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
        error: "В проекте нет файла темы (theme.css) — откройте «Палитру» ещё раз, файл создастся сам.",
      });
    }
    let css: string;
    try {
      css = patchTheme(found.css, body.tokens);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    await writeFileInside(sandbox.root, path.join(sandbox.root, found.file), css);
    // Статический предпросмотр отдаёт готовую сборку: без новой сборки сохранённый цвет не
    // появится ни в кадре, ни по публичному адресу. Ждём её здесь, до ответа, потому что панель
    // перезагружает кадр сразу после ответа — и должна застать уже новый CSS. Сбой пересборки не
    // отменяет запись файла: палитра сохранена, а предпросмотр честно останется без неё.
    await refreshStaticPreview(p.id).catch(error => console.warn("[theme] предпросмотр не пересобран", error));
    applyNoStoreToReply(reply);
    return themeReply({ file: found.file, css }, await usesThemeTokens(sandbox.root));
  });
}
