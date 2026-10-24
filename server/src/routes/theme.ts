import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import path from "node:path";
import { requireProjectUser } from "../auth/auth.js";
import { getSandbox } from "../sandbox-manager.js";
import { writeFileInside } from "../sandbox/path-guard.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { readPalette, normalizePaletteValue, patchPaletteValue, readPaletteFile, type Palette, type PaletteKind } from "../design/palette.js";
import { createProjectPalette } from "../design/palette-create.js";
import { FONT_OPTIONS } from "../design/theme.js";
import { refreshStaticPreview } from "../preview/static-preview.js";
import { getPreview } from "../preview/preview-store.js";
import { startPreview, stopPreview } from "../preview-manager.js";

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
  /**
   * Перезапуск живого dev-сервера, если палитра живёт в серверном JS. У такого проекта HTML
   * собран в памяти процесса: запись файла сама по себе не появится на странице, в отличие
   * от CSS с горячей перезагрузкой. Для статики и Vite ничего не делает.
   */
  restartPreview?: (projectId: string, userId: string) => Promise<boolean>;
};

/** Файл палитры — серверный скрипт, а не стиль: его правку видит только новый процесс. */
function liveScriptPalette(palette: Palette) {
  return palette.tokens.some(token => /\.(m?[jt]s|cjs)$/i.test(token.file));
}

async function restartServerPreview(projectId: string, userId: string) {
  const state = getPreview(projectId);
  if (!state || state.mode !== "container") return false;
  const config = await getSandbox(projectId, userId);
  await stopPreview(projectId);
  await startPreview(config);
  return true;
}

const defaultDeps: ThemeRouteDeps = {
  authorize: requireProjectUser,
  getSandbox: (projectId, userId) => getSandbox(projectId, userId),
  refreshPreview: refreshStaticPreview,
  restartPreview: restartServerPreview,
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
   * Создание палитры для проекта, где цвета вписаны в стили напрямую. Панель вызывает это сама
   * при открытии «Палитры»: собирает токены из фактических цветов страницы, пишет `theme.css` и
   * заменяет совпавшие литералы на `var(--color-…)`. Без этого шага человек видел пустой экран
   * и тратил шаг агента на одну и ту же механическую правку.
   *
   * Ответ 200 и при отказе: «создавать не из чего» — не сбой сервера, а объяснение, которое
   * панель показывает вместе с кнопкой агента. Уже существующая палитра не перезаписывается.
   */
  app.post("/api/projects/:id/theme", async (request, reply) => {
    const p = z.object({ id: z.string().min(1) }).parse(request.params);
    const user = await deps.authorize(request, reply, p.id);
    if (!user) return;
    const sandbox = await deps.getSandbox(p.id, user.id);
    const outcome = await createProjectPalette(sandbox.root);
    const palette = await readPalette(sandbox.root);
    if (outcome.created) {
      // Переписанные стили и новый файл темы попадают в статический предпросмотр только после
      // пересборки — ждём её до ответа, как и при сохранении палитры.
      await deps.refreshPreview(p.id).catch(error => console.warn("[theme] предпросмотр не пересобран", error));
      // У серверного проекта палитра объявлена в его же JS: старый процесс держит HTML в
      // памяти, поэтому без перезапуска новая палитра не появилась бы в кадре.
      if (liveScriptPalette(palette)) {
        try { await deps.restartPreview?.(p.id, user.id); }
        catch (error) { console.warn("[theme] предпросмотр не перезапущен", error); }
      }
    }
    applyNoStoreToReply(reply);
    return { ...themeReply(palette), created: outcome.created, ...(outcome.reason ? { reason: outcome.reason } : {}) };
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
    // Серверный HTML собирается процессом: чтобы новый цвет появился на странице, а не только
    // в файле, живой dev-сервер перезапускается. Статику и Vite это не касается.
    if (updates.some(update => /\.(m?[jt]s|cjs)$/i.test(update.file))) {
      try { await deps.restartPreview?.(p.id, user.id); }
      catch (error) { console.warn("[theme] предпросмотр не перезапущен", error); }
    }
    applyNoStoreToReply(reply);
    return themeReply(await readPalette(sandbox.root));
  });
}
