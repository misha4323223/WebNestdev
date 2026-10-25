import { positiveInt } from "../concurrency.js";
import type { ChatMessage } from "../types.js";

/**
 * One place that decides how big the conversation sent to the model may get.
 *
 * It exists because the agent's message list grows with every step: tool output is appended as it
 * arrives and is never re-read by the previous compaction, so a run that reads files, installs
 * packages and runs a build collects hundreds of thousands of characters. The provider answers such
 * a request with `ContextWindowExceededError` and the run dies — and the fix belongs here, not in
 * twenty call sites.
 *
 * A gateway enforces two independent limits, and only bounding the first one is a mistake we made:
 *
 * - **size** — `AGENT_CONTEXT_TOKENS` (default 120000) is the largest prompt this platform is willing
 *   to send, `AGENT_CONTEXT_OUTPUT_RESERVE` (default 8192) is subtracted for the answer, and the
 *   ratio of characters per token is calibrated during a run from the provider's own usage report;
 * - **count** — many OpenAI-compatible routers validate the body and refuse a `messages` array past
 *   a fixed number of entries. The gateway this platform talks to answers
 *   `[{"origin":"array","code":"too_big","maximum":100,"path":["messages"]}]`, and a run
 *   collects two messages per step plus a verification round of five, so forty steps alone cross a
 *   hundred. `AGENT_CONTEXT_MAX_MESSAGES` (default 80) keeps a request under such a cap; what is
 *   dropped for it is the same old history the token budget drops.
 */

/** Characters per token for English text with code. Calibrated from real usage during a run. */
/**
 * Characters per token for English text with code, and the range a measured ratio is clamped to.
 * The clamp only keeps one bad measurement from making the estimate absurd; a Russian-heavy prompt
 * genuinely sits below 2.5, so the floor is low enough to accept that.
 */
export const DEFAULT_CHARS_PER_TOKEN = 3.6;
export const MIN_CHARS_PER_TOKEN = 1.5;
export const MAX_CHARS_PER_TOKEN = 8;

/** How many of the newest messages are never dropped: the model needs the current step in full. */
const KEEP_RECENT_MESSAGES = 8;
/**
 * Messages one request may carry by default. A gateway cap that is smaller than this is discovered
 * from its own refusal and the run continues with a reduced cap (see `step-runner.ts`).
 */
export const DEFAULT_MAX_MESSAGES = 80;
/** A cap below this leaves no room for the prompt, the notes and the current step. */
export const MIN_MAX_MESSAGES = 8;
/** Room kept for the leading system block and the note that explains a cut. */
const COUNT_HEADROOM = 5;
/**
 * Верхний предел заметки о сокращённой истории. Разделы внутри ограничены своими квотами, а это —
 * страховка: заметка уезжает в каждый следующий запрос, поэтому она не имеет права расти бесконечно.
 */
export const CUT_NOTE_CHARS = 3400;
/** A user message may carry a pasted file; its own cap keeps that from eating the whole budget. */
const USER_MESSAGE_CHARS = 4000;
const USER_MESSAGE_TAIL_CHARS = 1000;

const COMPACT_HEAD_CHARS = 1200;
const COMPACT_TAIL_CHARS = 400;
const SQUEEZE_HEAD_CHARS = 600;
const SQUEEZE_TAIL_CHARS = 200;

/**
 * What one tool result may add to the context, keyed by tool name. A file the agent is reading is
 * worth more of the budget than a build log it only needs the tail of; every other tool gets the
 * default, which is a few kilobytes of diagnostics.
 */
const TOOL_OUTPUT_CHARS: Record<string, number> = {
  "fs.read": 24000,
  "terminal.exec": 6000,
  "npm.install": 6000,
  "browser.runtime": 6000,
  "browser.scenario": 8000,
  "git.diff": 8000,
  // Явный запрос логов и истории: модель сама попросила этот кусок, и обрезать его до общего
  // минимума — значит заставить её повторять тот же вызов.
  "preview.logs": 12000,
  "chat.history": 12000,
};
const DEFAULT_TOOL_OUTPUT_CHARS = 4000;

export type ContextBudgetReport = {
  /** Everything the prompt carries: the messages plus the tool schemas (`overheadChars`). */
  chars: number;
  /** The part of `chars` that the tool definitions take — they are sent with every request. */
  overheadChars: number;
  estimatedTokens: number;
  budgetTokens: number;
  /** Messages left in the prompt after trimming. */
  messages: number;
  /** The cap `messages` is measured against. */
  maxMessages: number;
  /** Messages whose content was shortened in place. */
  compacted: number;
  /** Messages removed entirely (whole request/answer groups only). */
  dropped: number;
};

/** The count form of the same refusal: the provider refused this many messages, whatever their size. */
export type MessageCountLimit = { messages: number; maxMessages: number };

/**
 * Thrown when even a fully compacted conversation does not fit. Sending the request anyway is what
 * produced a raw 400 from the gateway, so the run stops with a sentence the user can act on.
 */
export class ContextBudgetError extends Error {
  readonly code = "CONTEXT_OVERFLOW";
  constructor(readonly estimatedTokens: number, readonly budgetTokens: number, readonly count?: MessageCountLimit) {
    // The two limits are told apart in the sentence, because the fix is not the same: one is "too much
    // material", the other is "too many steps", and the number of the cap is only quoted when it is
    // known to be below what the provider actually refused.
    super(count
      ? "Провайдер отказался принять запрос из " + count.messages + " сообщений" +
        (count.maxMessages < count.messages ? ": его предел — " + count.maxMessages : " — это больше, чем он принимает") +
        ". Начните новый диалог или разделите задачу на части."
      : `Контекст запуска не помещается в лимит модели: примерно ${estimatedTokens} токенов при бюджете ${budgetTokens}. Начните новый диалог или разделите задачу на части.`);
    this.name = "ContextBudgetError";
  }
}

/** The prompt budget: what may be sent, once the space for the answer is set aside. */
export function contextBudgetTokens() {
  const total = positiveInt(process.env.AGENT_CONTEXT_TOKENS, 120_000);
  const reserve = positiveInt(process.env.AGENT_CONTEXT_OUTPUT_RESERVE, 8_192);
  return Math.max(4_000, total - reserve);
}

/**
 * How many messages one request may carry, whatever their size. The count a provider accepts is not
 * a token question: a hundred messages of ten characters each are tiny and still refused.
 */
export function contextMaxMessages() {
  return Math.max(MIN_MAX_MESSAGES, positiveInt(process.env.AGENT_CONTEXT_MAX_MESSAGES, DEFAULT_MAX_MESSAGES));
}

/** Printed once at startup, next to the other limits, so an operator sees what bounds a run. */
export function describeContextBudget() {
  return "бюджет контекста на шаг: " + contextBudgetTokens() + " токенов и " + contextMaxMessages() + " сообщений" +
    " (AGENT_CONTEXT_TOKENS " + positiveInt(process.env.AGENT_CONTEXT_TOKENS, 120_000) +
    ", резерв на ответ " + positiveInt(process.env.AGENT_CONTEXT_OUTPUT_RESERVE, 8_192) +
    ", AGENT_CONTEXT_MAX_MESSAGES " + positiveInt(process.env.AGENT_CONTEXT_MAX_MESSAGES, DEFAULT_MAX_MESSAGES) + ")";
}

/** Keeps a run's estimate honest: the provider's own token count beats any character count. */
export function calibrateCharsPerToken(chars: number, reportedTokens: number) {
  if (chars <= 0 || reportedTokens <= 0) return DEFAULT_CHARS_PER_TOKEN;
  return Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, chars / reportedTokens));
}

export function messageChars(messages: ChatMessage[]) {
  return messages.reduce((sum, message) => sum + message.content.length + (message.role === "assistant" ? JSON.stringify(message.tool_calls ?? []).length : 0), 0);
}

export function estimateTokens(messages: ChatMessage[], charsPerToken = DEFAULT_CHARS_PER_TOKEN) {
  return Math.ceil(messageChars(messages) / charsPerToken);
}

/** Head and tail of a long text, with what was cut stated in the middle. */
export function clip(text: string, head: number, tail: number, label: string) {
  if (text.length <= head + tail) return text;
  const cut = text.length - head - tail;
  return text.slice(0, head) + "\n…[" + label + ": " + cut + " символов]…\n" + text.slice(-tail);
}

export function toolOutputChars(name: string) {
  return TOOL_OUTPUT_CHARS[name] ?? DEFAULT_TOOL_OUTPUT_CHARS;
}

/**
 * The tool result as it enters the conversation. Bounding it here — rather than only when the
 * context is already too big — is what keeps a run from ever reaching the limit: a build log is
 * read once and stays in the history for the rest of the run.
 */
export function boundToolOutput(name: string, output: unknown) {
  let text: string;
  try {
    text = JSON.stringify(output ?? null) ?? "null";
  } catch {
    text = String(output);
  }
  const limit = toolOutputChars(name);
  return clip(text, Math.round(limit * 0.6), Math.round(limit * 0.4), "вывод " + name + " сокращён");
}

type MessageGroup = { messages: ChatMessage[]; index: number };

/**
 * Request/answer groups, because an assistant turn with `tool_calls` and the tool results that
 * answer it may only be added or removed together — a provider rejects a tool result whose call is
 * missing (and a call whose result is missing).
 */
export function groupMessages(messages: ChatMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const ids = message.role === "assistant" ? new Set((message.tool_calls ?? []).map(call => call.id)) : null;
    const collected: ChatMessage[] = [message];
    if (ids && ids.size) {
      while (i + 1 < messages.length) {
        const next = messages[i + 1];
        if (next.role !== "tool" || !ids.has(next.tool_call_id)) break;
        collected.push(next);
        i++;
      }
    }
    groups.push({ messages: collected, index: i - collected.length + 1 });
  }
  return groups;
}

/**
 * What one tool call's arguments may take in the context. A written file arrives here whole, and the
 * arguments of every past step are re-sent with every request: `messageChars` counts them, but a
 * size cut had nothing to shorten — content was clipped and arguments were not, so one big
 * `fs.write` could make the next step overflow a budget no phase could reduce.
 */
export const TOOL_ARGS_CHARS = 2000;

/**
 * The same call with its arguments cut to a valid JSON object. The call keeps its id and its name, so
 * the result that answers it stays paired: a provider refuses a result whose call disappeared, and a
 * call whose arguments no longer parse.
 */
export function clipToolCallArgs(call: { id: string; name: string; arguments: Record<string, unknown> }) {
  const args = JSON.stringify(call.arguments ?? {});
  if (args.length <= TOOL_ARGS_CHARS) return call;
  return {
    ...call,
    arguments: {
      _note: "аргументы вызова сокращены до лимита контекста (было " + args.length + " символов)",
      _preview: args.slice(0, TOOL_ARGS_CHARS),
    },
  };
}

/** The message with its calls' arguments shortened, or null when nothing needed shortening. */
function clipCallArgs(message: ChatMessage): ChatMessage | null {
  if (message.role !== "assistant" || !message.tool_calls?.length) return null;
  const calls = message.tool_calls.map(clipToolCallArgs);
  if (calls.every((call, index) => call === message.tool_calls?.[index])) return null;
  return { ...message, tool_calls: calls };
}

/** One line, whitespace collapsed: what a digest entry is made of. */
function digestHead(content: string, limit: number) {
  const text = content.replace(/\s+/g, " ").trim();
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

/** Начало и конец одной строкой: итог решения обычно в хвосте, а тема — в голове. */
function digestEdges(content: string, head: number, tail: number) {
  const text = content.replace(/\s+/g, " ").trim();
  if (text.length <= head + tail) return text;
  return text.slice(0, head) + " … " + text.slice(-tail);
}

/**
 * What the part of the history that left the window is worth to the model.
 *
 * Dropping messages is the cheapest way to fit a budget, but the bulk of a run is tool output while
 * its meaning lives in a few short lines: what the user asked for, what the agent concluded, and
 * which files and commands it already touched. The digest keeps those and drops the rest, so a long
 * chat continues from knowledge — «I already did this» — instead of from a count of messages.
 */
type CutCollector = { requests: string[]; answers: string[]; actions: string[]; toolResults: number };

/**
 * Просьба пользователя — это требование, а не пересказ: она хранится почти целиком (до 1200 знаков)
 * и режется по краям, только если длиннее. Договорённости живут в словах пользователя («тёмная
 * палитра, шрифт Inter, второй вариант отвергнут»), а не в пересказе агента.
 */
const DIGEST_REQUEST_CHARS = 1200;
/**
 * У ответа агента важен и заход, и итог: «Итого: берём вариант B» стоит последним абзацем, поэтому
 * срез берёт голову и хвост, а не только начало, как раньше.
 */
const DIGEST_ANSWER_HEAD_CHARS = 150;
const DIGEST_ANSWER_TAIL_CHARS = 150;
const DIGEST_ACTION_CHARS = 90;
/** Квоты разделов: они делят одну заметку, а не конкурируют за неё. */
const DIGEST_REQUESTS_QUOTA = 1500;
const DIGEST_ANSWERS_QUOTA = 900;
const DIGEST_ACTIONS_QUOTA = 500;
const DIGEST_MAX_REQUESTS = 12;
const DIGEST_MAX_ANSWERS = 12;
const DIGEST_MAX_ACTIONS = 20;

/** The one thing a tool call says about itself: the path, command or route it worked on. */
export function toolCallTarget(input: unknown) {
  if (!input || typeof input !== "object") return "";
  const values = input as Record<string, unknown>;
  for (const key of ["path", "to", "command", "url", "route", "query"]) {
    const value = values[key];
    if (typeof value === "string" && value.trim()) return digestHead(value, DIGEST_ACTION_CHARS);
  }
  return "";
}

function collectCut(collector: CutCollector, message: ChatMessage) {
  if (message.role === "user") {
    collector.requests.push(digestEdges(message.content, DIGEST_REQUEST_CHARS - 300, 300));
    return;
  }
  if (message.role === "tool") {
    collector.toolResults++;
    return;
  }
  if (message.role !== "assistant") return;
  // An answer that carries calls has no conclusion of its own; one without calls is exactly the
  // conclusion the cut would otherwise lose.
  if (message.content.trim()) collector.answers.push(digestEdges(message.content, DIGEST_ANSWER_HEAD_CHARS, DIGEST_ANSWER_TAIL_CHARS));
  for (const call of message.tool_calls ?? []) {
    const target = toolCallTarget(call.arguments);
    collector.actions.push(target ? call.name + " " + target : call.name);
  }
}

/** The newest entries are the ones a continued task needs, and one note cannot carry all of them. */
function newest<T>(list: T[], limit: number) {
  return list.slice(Math.max(0, list.length - limit));
}

/**
 * What the user asked, thinned to what the note can carry. The **first** request of the dialog is
 * kept whatever else is dropped: it frames the whole project («сделай лендинг для клиники»), and
 * without it a continued chat answers the latest message in a void. The rest of the list is the
 * newest requests — the ones the current step continues from.
 */
function requestDigest(requests: string[]) {
  if (requests.length <= DIGEST_MAX_REQUESTS) return requests;
  return [requests[0], ...newest(requests.slice(1), DIGEST_MAX_REQUESTS - 1)];
}

/**
 * Сколько записей раздела влезает в его квоту. Самое новое важнее старого, но первый запрос
 * диалога остаётся всегда: без него продолжение отвечает на последнюю реплику в пустоте.
 */
function fitSection(entries: string[], quota: number, keepFirst: boolean): string[] {
  if (!entries.length) return [];
  if (entries.join(" ").length <= quota) return entries;
  const first = keepFirst ? entries[0] : undefined;
  const rest = keepFirst ? entries.slice(1) : entries;
  const kept: string[] = [];
  let used = first ? first.length + 1 : 0;
  for (let index = rest.length - 1; index >= 0; index--) {
    const cost = rest[index].length + 1;
    if (used + cost > quota) break;
    kept.unshift(rest[index]);
    used += cost;
  }
  return first ? [first, ...kept] : kept;
}

function cutNote(collector: CutCollector, dropped: number) {
  const parts = ["ранние шаги сокращены до лимита контекста: выброшено сообщений — " + dropped];
  const requests = fitSection(requestDigest(collector.requests), DIGEST_REQUESTS_QUOTA, true);
  const answers = fitSection(newest(collector.answers, DIGEST_MAX_ANSWERS), DIGEST_ANSWERS_QUOTA, false);
  const actions = fitSection([...new Set(newest(collector.actions, DIGEST_MAX_ACTIONS))], DIGEST_ACTIONS_QUOTA, false);
  if (requests.length) parts.push("пользователь уже просил: " + requests.map(item => "«" + item + "»").join(" "));
  // Честно про потери: если часть старых просьб не поместилась, модель это знает, а не считает срез полным.
  const skipped = collector.requests.length - requests.length;
  if (skipped > 0) parts.push("ещё " + skipped + " более ранних просьб не поместились в срез — если факта нет в проекте, прочитай файлы, а не переспрашивай");
  if (answers.length) parts.push("агент уже отвечал: " + answers.map(item => "«" + item + "»").join(" "));
  if (actions.length) parts.push("уже сделано с проектом: " + actions.join(", "));
  if (collector.toolResults) parts.push("вывод инструментов выброшен (" + collector.toolResults + " результатов) — читай файлы и запускай команды заново, если он нужен");
  const note = "[" + parts.join(". ") + "]";
  return note.length > CUT_NOTE_CHARS ? note.slice(0, CUT_NOTE_CHARS) + "…]" : note;
}

/**
 * Old user messages a count cut may fold: those before the protected window, except the newest one,
 * which is the task the model is working on right now.
 */
export function foldableUserMessages(messages: ChatMessage[], keepRecent: number) {
  const recentStart = Math.max(0, messages.length - keepRecent);
  const lastUserIndex = messages.reduce((last, message, index) => (message.role === "user" ? index : last), -1);
  const result: ChatMessage[] = [];
  for (let i = 0; i < recentStart; i++) {
    const message = messages[i];
    if (message.role === "user" && i < lastUserIndex) result.push(message);
  }
  return result;
}

/**
 * Fits the conversation into both limits a provider enforces — the token budget and the number of
 * messages — cheapest change first:
 *
 * 1. compact an oversized user message (a pasted file) — user words are never dropped, only clipped;
 * 2. shorten the content and the tool-call arguments of every non-recent answer and tool result,
 *    keeping their beginning and end;
 * 3. drop the oldest request/answer groups whole;
 * 4. if the count is still too high, fold the oldest user messages into the same note: the
 *    requirement stays readable, the array gets shorter;
 * 5. shorten even the recent ones;
 * 6. if it still does not fit, refuse with `ContextBudgetError` instead of sending a doomed request.
 *
 * The system prompt and the project context survive every round, the newest `keepRecent` messages are
 * never touched, and what left the window is not lost silently: one note where the cut begins carries
 * the requests, the conclusions and the touched files of the dropped part (`cutNote`).
 */
export function trimMessagesToBudget(
  messages: ChatMessage[],
  options: { budgetTokens: number; charsPerToken?: number; keepRecent?: number; overheadChars?: number; maxMessages?: number },
): { messages: ChatMessage[]; report: ContextBudgetReport } {
  const charsPerToken = options.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const budgetTokens = options.budgetTokens;
  const maxMessages = Math.max(2, options.maxMessages ?? DEFAULT_MAX_MESSAGES);
  // Protecting more newest messages than the cap has room for would make the cap unreachable, so the
  // protected window shrinks with the cap.
  const keepRecent = Math.max(2, Math.min(options.keepRecent ?? KEEP_RECENT_MESSAGES, maxMessages - COUNT_HEADROOM));
  const overheadChars = Math.max(0, options.overheadChars ?? 0);
  let working: ChatMessage[] = messages.map(message => ({ ...message }));
  let compacted = 0;
  let dropped = 0;
  // What the cut owes the model, collected until it is written as one note.
  const cut: CutCollector = { requests: [], answers: [], actions: [], toolResults: 0 };
  // The note is a real message only once it is in `working`; until then it is a reserved place.
  let noteWritten = false;
  // The size is carried along instead of being summed again on every question: the trim asks
  // "does it fit?" inside its own loops, and a stored conversation can hold thousands of messages, so
  // recounting there would make trimming quadratic in the length of the chat. Every place that
  // changes a message has to keep this number in step (`setContent`, the removals and the note).
  let totalChars = messageChars(working);

  // The tool definitions travel with every request, so what the conversation may spend is the budget
  // minus their size — the mistake that let a "120000 token" budget send far more than that.
  const promptChars = () => totalChars + overheadChars;
  const overTokens = () => Math.ceil(promptChars() / charsPerToken) > budgetTokens;
  // A note that explains a cut is one more system message, so the count keeps a place for it until it
  // exists: trimming to the cap and *then* explaining the cut would cross the cap again.
  const overCount = () => working.length > maxMessages - (noteWritten ? 0 : 1);
  const overBudget = () => overTokens() || overCount();
  const dropMessage = (message: ChatMessage) => { totalChars -= messageChars([message]); };
  const setContent = (index: number, message: ChatMessage, content: string) => {
    totalChars += content.length - message.content.length;
    working[index] = { ...message, content };
  };
  /** Replaces a whole message — used where a cut changes more than the text (the call arguments). */
  const setMessage = (index: number, message: ChatMessage) => {
    totalChars += messageChars([message]) - messageChars([working[index]]);
    working[index] = message;
  };
  const done = (): { messages: ChatMessage[]; report: ContextBudgetReport } => {
    // Cheap self-check outside production: the incremental total is what the phases above decided
    // with, and a drift would mean answering a budget question with a wrong number.
    if (process.env.NODE_ENV !== "production") {
      const actual = messageChars(working) + overheadChars;
      if (actual !== promptChars()) console.error("[agent] размер контекста посчитан неверно: " + promptChars() + " вместо " + actual);
    }
    return {
      messages: working,
      report: { chars: promptChars(), overheadChars, estimatedTokens: Math.ceil(promptChars() / charsPerToken), budgetTokens, messages: working.length, maxMessages, compacted, dropped },
    };
  };

  if (!overBudget()) return done();

  // 1 — a user message can be a pasted file; it stays, but at a readable size. Only size pressure asks
  // for this: a count that is too high is fixed by removing messages, not by shortening them.
  if (overTokens()) {
    for (let i = 0; i < working.length; i++) {
      const message = working[i];
      if (message.role !== "user" || message.content.length <= USER_MESSAGE_CHARS + USER_MESSAGE_TAIL_CHARS) continue;
      setContent(i, message, clip(message.content, USER_MESSAGE_CHARS, USER_MESSAGE_TAIL_CHARS, "сообщение сокращено"));
      compacted++;
    }
  }
  if (!overBudget()) return done();

  // 2 — old answers and tool results keep their beginning and end.
  if (overTokens()) {
    const recentStart = Math.max(0, working.length - keepRecent);
    for (let i = 0; i < recentStart && overTokens(); i++) {
      const message = working[i];
      if (message.role === "user" || message.role === "system") continue;
      const withCalls = clipCallArgs(message);
      if (withCalls) {
        setMessage(i, withCalls);
        compacted++;
        // Enough was cut already: shortening the text of this whole step on top of it would cost
        // the model an old conclusion for nothing.
        if (!overTokens()) break;
      }
      const current = working[i];
      if (current.content.length <= COMPACT_HEAD_CHARS + COMPACT_TAIL_CHARS) continue;
      setContent(i, current, clip(current.content, COMPACT_HEAD_CHARS, COMPACT_TAIL_CHARS, "старый шаг сокращён"));
      compacted++;
    }
  }
  if (!overBudget()) return done();

  // 3 — drop the oldest whole groups. The newest `keepRecent` messages and everything the user or
  // the system said are never touched here.
  // The newest messages are protected by position, so they are computed before the cut.
  const protectedIndexes = new Set<number>();
  for (let i = Math.max(0, working.length - keepRecent); i < working.length; i++) protectedIndexes.add(i);
  const groups = groupMessages(working);
  const remove = new Set<ChatMessage>();
  for (const group of groups) {
    if (!overBudget()) break;
    const indexes = group.messages.map((_, offset) => group.index + offset);
    if (indexes.some(index => protectedIndexes.has(index))) continue;
    if (group.messages.some(message => message.role === "user" || message.role === "system")) continue;
    for (const message of group.messages) remove.add(message);
  }
  if (remove.size) {
    // Collected in the order they arrived, so the digest reads as the story of the run.
    for (const message of working) if (remove.has(message)) { collectCut(cut, message); dropMessage(message); }
    working = working.filter(message => !remove.has(message));
    dropped += remove.size;
  }

  // 4 — the count is still too high. Everything removable as a group is gone, so the oldest user
  // messages are folded into the same note, each keeping its beginning: the requirement stays readable
  // and the array gets shorter, which is exactly what such a cap refuses.
  if (overCount()) {
    for (const message of foldableUserMessages(working, keepRecent)) {
      if (!overCount()) break;
      collectCut(cut, message);
      dropMessage(message);
      working = working.filter(item => item !== message);
      dropped++;
    }
  }

  // One note where the cut begins, so the model knows the history is not complete but keeps what it
  // was about. It goes after the system messages: the prompt and the project context always stay first.
  if (dropped) {
    const note = cutNote(cut, dropped);
    let insertAt = 0;
    while (insertAt < working.length && working[insertAt].role === "system") insertAt++;
    working.splice(insertAt, 0, { role: "system", content: note });
    totalChars += note.length;
    noteWritten = true;
  }
  if (!overBudget()) return done();

  // 5 — last resort: shorten what is left, newest included.
  if (overTokens()) {
    for (let i = 0; i < working.length && overTokens(); i++) {
      const message = working[i];
      if (message.role === "user" || message.role === "system") continue;
      const withCalls = clipCallArgs(message);
      if (withCalls) {
        setMessage(i, withCalls);
        compacted++;
        if (!overTokens()) break;
      }
      const current = working[i];
      if (current.content.length <= SQUEEZE_HEAD_CHARS + SQUEEZE_TAIL_CHARS) continue;
      setContent(i, current, clip(current.content, SQUEEZE_HEAD_CHARS, SQUEEZE_TAIL_CHARS, "сокращено до предела"));
      compacted++;
    }
  }
  if (overBudget()) {
    throw new ContextBudgetError(
      Math.ceil(promptChars() / charsPerToken),
      budgetTokens,
      overCount() ? { messages: working.length, maxMessages } : undefined,
    );
  }
  return done();
}
