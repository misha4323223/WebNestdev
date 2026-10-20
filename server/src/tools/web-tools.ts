import { z } from "zod";
import { registerTool } from "../tool-registry.js";
import { accountPlanFor } from "../billing/store.js";
import { createLimiter, positiveInt, type Slot } from "../concurrency.js";
import { searchWeb } from "../web/search.js";
import { readWebPage } from "../web/read-url.js";
import type { WebSearchErrorCode, WebSearchResponse } from "../web/web-types.js";

/**
 * Инструменты внешнего мира: `web.search` и `web.read`.
 *
 * Поиск идёт через сервер, а не через песочницу проекта: у песочницы нет сети, и это осознанное
 * правило платформы, а не ограничение. Поэтому ключи провайдеров остаются на сервере, расход
 * считается по тарифу аккаунта, а модель получает только результат.
 *
 * Провайдер выбирается тарифом внутри `web/search.ts`, а модель получает уже обезличенный ответ:
 * ни имени сервиса, ни заметок о резервных провайдерах. Агент не должен объяснять пользователю,
 * «через что» платформа ищет — для него это просто функция поиска в интернете. Детали остаются
 * в серверном логе.
 *
 * Поиск включается кнопкой рядом с полем ввода и по умолчанию выключен. Флаг приходит с запуском;
 * при выключенном поиске оба инструмента возвращают `ok:false, code:"disabled"` с просьбой включить
 * кнопку — это не ошибка сервера, а ответ человеку через модель. Сеть в этом случае не трогается.
 */

const SEARCH_OFF_ERROR =
  "Поиск в интернете выключен: пользователь не включил его в меню «Режимы» у поля ввода. " +
  "Не отвечай по памяти так, будто поиск выполнен. Скажи пользователю одной фразой, что поиск в интернете выключен и его нужно включить в меню «Режимы» (по умолчанию он выключен), затем повтори запрос.";

const READ_OFF_ERROR =
  "Чтение страниц выключено вместе с поиском в интернете: пользователь не включил его в меню «Режимы» у поля ввода. " +
  "Скажи пользователю одной фразой, что для открытия ссылок нужно включить поиск в этом меню, и не пересказывай содержание страницы по памяти.";

/**
 * Причина отказа вместо текста провайдера. Сообщения провайдеров содержат их названия и детали
 * инфраструктуры, а модели нужен только смысл: лимит, блокировка, недоступность. Квоту
 * отдаём как есть — в ней есть цифры и нет названий сервисов.
 */
const SEARCH_FAILURE_TEXT: Record<WebSearchErrorCode, string> = {
  disabled: SEARCH_OFF_ERROR,
  quota: "",
  blocked: "Поиск в интернете вернул проверку на робота вместо результатов. Попробуй переформулировать запрос или открой нужную страницу по прямой ссылке.",
  not_configured: "Поиск в интернете временно недоступен на платформе. Продолжай с тем, что даёт проект, и не выдумывай факты.",
  unavailable: "Поиск в интернете сейчас недоступен: сервис не ответил. Продолжай с тем, что даёт проект, и не выдумывай факты.",
};

/** Ответ инструмента без служебных полей: ни провайдера, ни заметок о нём модель не видит. */
function publicSearchResponse(response: WebSearchResponse) {
  const results = response.results.map(({ title, url, snippet }) => ({ title, url, snippet }));
  if (response.ok) {
    return { ok: true as const, query: response.query, results, ...(response.cached ? { cached: true } : {}) };
  }
  const code = response.code ?? "unavailable";
  const error = code === "quota" && response.error ? response.error : SEARCH_FAILURE_TEXT[code];
  return { ok: false as const, query: response.query, results: [], code, error };
}

const searchSchema = z.object({
  query: z.string().min(1).max(400),
  limit: z.number().int().min(1).max(20).optional(),
});

const readSchema = z.object({
  url: z.string().min(1).max(2000),
  maxChars: z.number().int().min(500).max(20_000).optional(),
});

/**
 * Чтение страниц тоже ограничено по параллельности: каждая загрузка — это чужой сервер, который не
 * должен получить десять запросов сразу только потому, что модель вызвала инструмент пять раз.
 */
const readLimiter = createLimiter(() => ({
  limit: positiveInt(process.env.WEB_READ_MAX_CONCURRENT, 3),
  queueLimit: positiveInt(process.env.WEB_READ_MAX_QUEUE, 8),
  waitTimeoutMs: positiveInt(process.env.WEB_READ_QUEUE_TIMEOUT_MS, 30_000),
  busyLabel: "Чтение страниц",
}));

registerTool({
  name: "web.search",
  description:
    "Search the public web from the platform server and return a short list of results with title, url and snippet. " +
    "Use it for facts you cannot read from the project: library versions and APIs, release notes, error messages from other projects, " +
    "pricing, service documentation, standards. Input: {query:string, limit?:1..20}. " +
    "How search is routed is a platform detail: never name a provider, a service or a key in the answer. " +
    "Internet search is a switch in the «Режимы» menu next to the user's message box and is off by default: when it is off the call returns code 'disabled' without touching the network, " +
    "and the right answer is to ask the user to turn it on in that menu, not to answer from memory. " +
    "A result with ok:false is a real failure with a reason (blocked, quota, disabled, unavailable) — never report it as 'the internet has nothing', " +
    "and never answer from memory as if the search succeeded. Read a page from the results with web.read.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query, in the language of the best sources for the topic." },
      limit: { type: "integer", maximum: 20, minimum: 1, description: "How many results to return. Default 8." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    const { query, limit } = searchSchema.parse(input ?? {});
    if (context.webSearchEnabled !== true) {
      return { ok: false, query, results: [], code: "disabled", error: SEARCH_OFF_ERROR };
    }
    const response = await searchWeb({
      userId: context.userId,
      plan: await accountPlanFor(context.userId),
      query,
      ...(limit ? { limit } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (!response.ok) console.error("[web] поиск не удался (" + response.provider + ", " + response.code + "): " + response.error);
    return publicSearchResponse(response);
  },
});

registerTool({
  name: "web.read",
  description:
    "Open one public http(s) page from the platform server and return its readable text (bounded), title, final url and status. " +
    "Use it after web.search when the snippet is not enough, or when the user gave a link. Input: {url:string, maxChars?:500..20000}. " +
    "Only ports 80 and 443 are allowed and internal/private addresses are refused, so a page on localhost or inside the project must be checked with preview.start and browser.* instead. " +
    "Reading pages belongs to the same internet switch as web.search and is off by default: a call while it is off returns code 'disabled' and asks the user to turn the switch on in the «Режимы» menu. " +
    "The text is bounded: if truncated is true, the page continues beyond what you received.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL of the page to read." },
      maxChars: { type: "integer", minimum: 500, maximum: 20000, description: "Text limit. Default 8000 characters." },
    },
    required: ["url"],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    const { url, maxChars } = readSchema.parse(input ?? {});
    if (context.webSearchEnabled !== true) {
      return { ok: false, url, status: 0, contentType: null, title: "", text: "", truncated: false, code: "disabled", error: READ_OFF_ERROR };
    }
    const slot: Slot = await readLimiter.acquire(context.signal);
    try {
      const page = await readWebPage(url, { ...(maxChars ? { maxChars } : {}), ...(context.signal ? { signal: context.signal } : {}) });
      if (!page.ok) console.error("[web] чтение не удалось (" + (page.code ?? "unavailable") + "): " + page.url);
      return page;
    } finally {
      slot.release();
    }
  },
});
