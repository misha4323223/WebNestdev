import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import path from "node:path";
import { requireProjectUser } from "../auth/auth.js";
import { getSandbox } from "../sandbox-manager.js";
import { writeFileInside } from "../sandbox/path-guard.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { readPalette, normalizePaletteValue, patchPaletteValue, readPaletteFile, type Palette, type PaletteKind } from "../design/palette.js";
import { FONT_OPTIONS } from "../design/theme.js";
import { refreshStaticPreview } from "../preview/static-preview.js";

/**
 * Палитра проекта для панели предпросмотра.
 *
 * Панель показывает и правит переменные, которые проект объявил сам, — где бы они ни лежали:
 * у проекта по контракту это `theme.css` с `--color-…`, у проекта постарше — свои `--bg`/`--ink`
 * в `styles.css`. Раньше панель знала только контракт и вместо настоящих цветов показывала
 * значения по умолчанию: человек видел «совсем другую» палитру, а правка писала переменную,
 * которую страница не читает. Значение каждого токена проверяется по его виду (`design/palette.ts`),
 * сюда приходит уже безопасный текст.
 */

function themeReply(palette: Palette) {
  return {
    present: palette.tokens.length > 0,
    /** Файл темы по контракту, если он есть: панель называет его в подписи. */
    file: palette.themeFile ?? palette.tokens[0]?.file ?? null,
    themeFile: palette.themeFile,
    tokens: Object.fromEntries(palette.tokens.map(token => [token.variable, token.value])),
    /** Строки панели: подпись, вид, значение, файл и читает ли страница эту переменную. */
    fields: palette.tokens.map(token => ({
      ...token,
      // Готовые шрифтовые пары — из того же списка, что у агента: панель не придумывает свои.
      ...(token.kind === "font" ? { options: FONT_OPTIONS.map(option => ({ value: option.value, label: option.label })) } : {}),
    })),
    /** Читается ли палитра страницей хотя бы одной переменной. */
    used: palette.tokens.some(token => token.used),
  };
}

/**
 * Зависимости маршрутов: тест подставляет свой каталог проекта и свой способ авторизации, а
 * прод берёт настоящие (докер-песочница, сессия аккаунта, пересборка предпросмотра).
 */
export type ThemeRouteDeps = {
  authorize: (request: FastifyRequest, reply: FastifyReply, projectId: string) => Promise<{ id: string } | null>;
  getSandbox: (projectId: string, userId: string) => Promise<{ root: string }>;
  refreshPreview: (projectId: string) => Promise<boolean>;
};

const defaultDeps: ThemeRouteDeps = {
  authorize: requireProjectUser,
  getSandbox: (projectId, userId) => getSandbox(projectId, userId),
  refreshPreview: refreshStaticPreview,
};

export async function registerThemeRoutes(app: FastifyInstance, deps: ThemeRouteDeps = defaultDeps) {
  app.get("/api/projects/:id/theme", async (request, reply) => {
    const p = z.object({ id: z.string().min(1) }).parse(request.params);
    const user = await deps.authorize(request, reply, p.id);
    if (!user) return;
    applyNoStoreToReply(reply);
    const sandbox = await deps.getSandbox(p.id, user.id);
    return themeReply(await readPalette(sandbox.root));
  });

  /**
   * Запись палитры. Правится ровно объявление переменной в том файле, где она объявлена: файл
   * темы у проекта по контракту, `styles.css` у проекта со своими токенами. Переменную, которой
   * в проекте нет, записать нельзя — панель показывает только объявленное, поэтому такая запись
   * означала бы, что файл изменился между чтением и сохранением.
   *
   * После записи статический предпросмотр пересобирается: он отдаёт готовую сборку, и без новой
   * сборки сохранённый цвет не появится ни в кадре, ни по публичному адресу. Ждём её до ответа,
   * потому что панель перезагружает кадр сразу после ответа. Сбой пересборки запись не отменяет:
   * палитра сохранена, а предпросмотр честно останется без неё.
   */
  app.put("/api/projects/:id/theme", async (request, reply) => {
    const p = z.object({ id: z.string().min(1) }).parse(request.params);
    const user = await deps.authorize(request, reply, p.id);
    if (!user) return;
    const body = z.object({ tokens: z.record(z.string().min(1).max(80), z.string().min(1).max(300)) }).parse(request.body);
    const sandbox = await deps.getSandbox(p.id, user.id);
    const palette = await readPalette(sandbox.root);
    const known = new Map(palette.tokens.map(token => [token.variable, token]));

    const updates: Array<{ variable: string; value: string; file: string; kind: PaletteKind }> = [];
    for (const [variable, value] of Object.entries(body.tokens)) {
      const token = known.get(variable);
      if (!token) {
        return reply.code(409).send({
          error: "В проекте нет переменной " + variable + " — палитра изменилась, откройте её ещё раз.",
        });
      }
      try {
        updates.push({ variable, value: normalizePaletteValue(token.kind, value), file: token.file, kind: token.kind });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      }
    }

    // Правки группируются по файлам: перечитать и записать файл один раз дешевле, чем по разу
    // на переменную, и так же безопаснее — между чтениями файл не меняется нами же.
    const byFile = new Map<string, typeof updates>();
    for (const update of updates) {
      const list = byFile.get(update.file) ?? [];
      list.push(update);
      byFile.set(update.file, list);
    }
    for (const [file, list] of byFile) {
      let css = await readPaletteFile(sandbox.root, file);
      for (const update of list) css = patchPaletteValue(css, update.variable, update.kind, update.value);
      await writeFileInside(sandbox.root, path.join(sandbox.root, file), css);
    }

    await deps.refreshPreview(p.id).catch(error => console.warn("[theme] предпросмотр не пересобран", error));
    applyNoStoreToReply(reply);
    return themeReply(await readPalette(sandbox.root));
  });
}
