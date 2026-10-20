import { z } from "zod";
import { registerTool } from "../tool-registry.js";
import { accountPlanFor } from "../account/plans.js";
import { createLimiter, positiveInt, type Slot } from "../concurrency.js";
import { providerForPlan, searchWeb } from "../web/search.js";
import { readWebPage } from "../web/read-url.js";

/**
 * Инструменты внешнего мира: `web.search` и `web.read`.
 *
 * Поиск идёт через сервер, а не через песочницу проекта: у песочницы нет сети, и это осознанное
 * правило платформы, а не ограничение. Поэтому ключи провайдеров остаются на сервере, расход
 * считается по тарифу аккаунта, а модель получает только результат.
 *
 * Провайдер выбирается тарифом (`web/search.ts`): бесплатный — DuckDuckGo, платный — Yandex Search
 * API. Инструмент один и тот же: агенту не нужно знать, кто отвечает, иначе он начнёт выбирать
 * провайдера в тексте ответа вместо работы.
 *
 * Поиск включается кнопкой рядом с полем ввода и по умолчанию выключен. Флаг приходит с запуском;
 * при выключенном поиске оба инструмента возвращают `ok:false, code:"disabled"` с просьбой включить
 * кнопку — это не ошибка сервера, а ответ человеку через модель. Сеть в этом случае не трогается.
 */

const SEARCH_OFF_ERROR =
  "Поиск в интернете выключен: пользователь не включил кнопку «Поиск» рядом с полем ввода. " +
  "Не отвечай по памяти так, будто поиск выполнен. Скажи пользователю одной фразой, что поиск в интернете выключен и его нужно включить кнопкой «Поиск» у поля ввода (по умолчанию она выключена), затем повтори запрос.";

const READ_OFF_ERROR =
  "Чтение страниц выключено вместе с поиском в интернете: пользователь не включил кнопку «Поиск» рядом с полем ввода. " +
  "Скажи пользователю одной фразой, что для открытия ссылок нужно включить эту кнопку, и не пересказывай содержание страницы по памяти.";

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
    "The provider depends on the account plan (free plan searches DuckDuckGo, paid plans search Yandex), so do not name a provider or a key in the answer. " +
    "Internet search is a switch next to the user's message box and is off by default: when it is off the call returns code 'disabled' without touching the network, " +
    "and the right answer is to ask the user to turn on the «Поиск» button, not to answer from memory. " +
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
      return { ok: false, provider: providerForPlan(accountPlanFor(context.userId)), query, results: [], code: "disabled", error: SEARCH_OFF_ERROR };
    }
    const response = await searchWeb({
      userId: context.userId,
      plan: accountPlanFor(context.userId),
      query,
      ...(limit ? { limit } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (!response.ok) console.error("[web] поиск не удался (" + response.provider + ", " + response.code + "): " + response.error);
    return response;
  },
});

registerTool({
  name: "web.read",
  description:
    "Open one public http(s) page from the platform server and return its readable text (bounded), title, final url and status. " +
    "Use it after web.search when the snippet is not enough, or when the user gave a link. Input: {url:string, maxChars?:500..20000}. " +
    "Only ports 80 and 443 are allowed and internal/private addresses are refused, so a page on localhost or inside the project must be checked with preview.start and browser.* instead. " +
    "Reading pages belongs to the same internet switch as web.search and is off by default: a call while it is off returns code 'disabled' and asks the user to turn on the «Поиск» button. " +
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
