import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { applyNoStoreToReply,isFreshOnlyResponse } from "./cache-headers.js";

/**
 * Раздача собранной панели — и единственное место, где решается, что можно кэшировать.
 *
 * Здесь это вынесено из index.ts не ради красоты: «после выкатки показывается старая версия» —
 * ошибка в этих нескольких строках, и её нужно уметь проверить тестом (см. panel-static.test.ts),
 * а не глазами на ВМ. Проверка идёт настоящими запросами к настоящему Fastify, только без порта.
 *
 * Правила:
 * - `index.html` (и SPA-фолбэк на произвольный адрес, который отдаёт тот же документ) — без кэша и
 *   **без валидаторов**: с `etag` посредник имеет право ответить `304 Not Modified`, и вкладка
 *   остаётся на документе прошлой сборки вместе со ссылками на её ассеты. Именно так «старая
 *   версия» и переживала выкатки;
 * - файлы сборки в `assets/` — наоборот, надолго и с `immutable`: у них хэш в имени, поэтому новая
 *   сборка приходит с новыми именами, а старые остаются валидными и не перекачиваются;
 * - всё остальное (иконки и прочее без хэша в имени) — `no-cache`: хранить можно, но спрашивать
 *   сервер при каждой загрузке.
 */
export async function registerPanelFiles(app: FastifyInstance, rootDir: string): Promise<boolean> {
  if (!existsSync(rootDir)) return false;

  // Валидаторы кэша снимаются на самой отправке: заголовки документа ставятся и внутри sendFile,
  // поэтому правило должно срабатывать позже них — здесь. Этот же хук защищает документ предпросмотра,
  // если приложение внутри него отдаёт HTML напрямую (прокси ещё и ставит no-store сам).
  app.addHook("onSend", async (_request, reply) => {
    if (isFreshOnlyResponse(String(reply.getHeader("content-type") ?? ""))) applyNoStoreToReply(reply);
  });

  await app.register(fastifyStatic, {
    root: rootDir,
    maxAge: "30d",
    immutable: true,
    setHeaders: (reply, filePath) => {
      if (filePath.endsWith(".html")) {
        applyNoStoreToReply(reply);
        return;
      }
      if (!filePath.includes(path.sep + "assets" + path.sep)) {
        reply.header("cache-control", "no-cache");
      }
    },
  });

  app.setNotFoundHandler((request, reply) => {
    const url = request.raw.url ?? "";
    if (request.method === "GET" && !url.startsWith("/api")) {
      // Тот же документ, что и по корню: без кэша и без валидаторов, иначе браузер (или посредник)
      // закрепит старую сборку вместе со ссылками на её ассеты.
      applyNoStoreToReply(reply);
      return reply.sendFile("index.html", { maxAge: 0, immutable: false, etag: false, lastModified: false });
    }
    return reply.code(404).send({ error: "Not Found" });
  });

  return true;
}
