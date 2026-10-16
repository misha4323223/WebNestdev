/**
 * Документ платформы и всё, что несёт код, никогда не отдаётся из кэша — и это правило живёт в одном
 * месте, потому что его цена видна пользователю как «после выкатки показывается старая версия».
 *
 * Одного `no-store` на index.html оказалось мало. Кэш посредника (обратный прокси, корпоративный
 * прокси, кэш браузера в режиме ревалидации) продолжает жить, пока у ответа есть валидатор: на
 * условный запрос с `If-None-Match` можно ответить `304 Not Modified`, и вкладка остаётся на
 * документе прошлой сборки. А вместе с документом остаются ссылки на ассеты прошлой сборки: у них в
 * имени хэш, они лежат в кэше 30 дней и продолжают работать — поэтому старая версия не просто
 * мелькает, она выглядит совершенно исправной и живёт так до ручной очистки данных сайта.
 *
 * Отсюда правило: валидаторы кэша (`etag`, `last-modified`) убираются вместе с `no-store`. Без них
 * подтвердить старую копию нечем, и посредник обязан взять тело заново. Правило применяется к
 * HTML-документу (см. routes/health.ts — там же `/api/version`, по которому открытая вкладка
 * замечает новую сборку) и ко всему, что отдаёт прокси предпросмотра (см. routes/preview.ts):
 * у живого предпросмотра «новое» — единственная правильная версия.
 */

export const NO_STORE_HEADERS: Readonly<Record<string, string>> = {
  // `must-revalidate` — для посредников, которые считают `no-cache` рекомендацией; `pragma` и
  // `expires` — для старых прокси, которые читают только их.
  "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
  pragma: "no-cache",
  expires: "0",
};

/** Валидаторы кэша: с ними посредник имеет право ответить 304 и оставить старую версию. */
export const CACHE_VALIDATORS = ["etag", "last-modified"] as const;

/** То же правило для заголовков ответа, собранных как `Headers` (так отвечает прокси предпросмотра). */
export function applyNoStore(headers: Headers): Headers {
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) headers.set(name, value);
  for (const name of CACHE_VALIDATORS) headers.delete(name);
  return headers;
}

/** И для ответа Fastify: документ панели и SPA-фолбэк на любой путь. */
export function applyNoStoreToReply(reply: { header: (name: string, value: string) => unknown; removeHeader: (name: string) => unknown }): void {
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) reply.header(name, value);
  for (const name of CACHE_VALIDATORS) reply.removeHeader(name);
}

/** Несёт ли ответ код или документ, который обязан быть свежим при каждом открытии вкладки. */
export function isFreshOnlyResponse(contentType: string | null | undefined): boolean {
  const type = (contentType ?? "").toLowerCase();
  return type.includes("text/html");
}
