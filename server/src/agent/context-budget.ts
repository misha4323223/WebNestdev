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
 * Three numbers, all overridable:
 * `AGENT_CONTEXT_TOKENS` (default 120000) is the largest prompt this platform is willing to send,
 * `AGENT_CONTEXT_OUTPUT_RESERVE` (default 8192) is subtracted for the answer, and the ratio of
 * characters per token is calibrated during a run from the provider's own usage report.
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
};
const DEFAULT_TOOL_OUTPUT_CHARS = 4000;

export type ContextBudgetReport = {
  /** Everything the prompt carries: the messages plus the tool schemas (`overheadChars`). */
  chars: number;
  /** The part of `chars` that the tool definitions take — they are sent with every request. */
  overheadChars: number;
  estimatedTokens: number;
  budgetTokens: number;
  /** Messages whose content was shortened in place. */
  compacted: number;
  /** Messages removed entirely (whole request/answer groups only). */
  dropped: number;
};

/**
 * Thrown when even a fully compacted conversation does not fit. Sending the request anyway is what
 * produced a raw 400 from the gateway, so the run stops with a sentence the user can act on.
 */
export class ContextBudgetError extends Error {
  readonly code = "CONTEXT_OVERFLOW";
  constructor(readonly estimatedTokens: number, readonly budgetTokens: number) {
    super(`Контекст запуска не помещается в лимит модели: примерно ${estimatedTokens} токенов при бюджете ${budgetTokens}. Начните новый диалог или разделите задачу на части.`);
    this.name = "ContextBudgetError";
  }
}

/** The prompt budget: what may be sent, once the space for the answer is set aside. */
export function contextBudgetTokens() {
  const total = positiveInt(process.env.AGENT_CONTEXT_TOKENS, 120_000);
  const reserve = positiveInt(process.env.AGENT_CONTEXT_OUTPUT_RESERVE, 8_192);
  return Math.max(4_000, total - reserve);
}

/** Printed once at startup, next to the other limits, so an operator sees what bounds a run. */
export function describeContextBudget() {
  return "бюджет контекста на шаг: " + contextBudgetTokens() + " токенов" +
    " (AGENT_CONTEXT_TOKENS " + positiveInt(process.env.AGENT_CONTEXT_TOKENS, 120_000) +
    ", резерв на ответ " + positiveInt(process.env.AGENT_CONTEXT_OUTPUT_RESERVE, 8_192) + ")";
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
 * Fits the conversation into the budget, cheapest change first:
 *
 * 1. compact an oversized user message (a pasted file) — user words are never dropped, only clipped;
 * 2. shorten the content of every non-recent answer and tool result, keeping its beginning and end;
 * 3. drop the oldest request/answer groups whole, leaving a system note that earlier steps were cut;
 * 4. shorten even the recent ones;
 * 5. if it still does not fit, refuse with `ContextBudgetError` instead of sending a doomed request.
 *
 * System and user messages survive all four rounds, so the task and the project context are always
 * in front of the model.
 */
export function trimMessagesToBudget(
  messages: ChatMessage[],
  options: { budgetTokens: number; charsPerToken?: number; keepRecent?: number; overheadChars?: number },
): { messages: ChatMessage[]; report: ContextBudgetReport } {
  const charsPerToken = options.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const budgetTokens = options.budgetTokens;
  const keepRecent = Math.max(2, options.keepRecent ?? KEEP_RECENT_MESSAGES);
  const overheadChars = Math.max(0, options.overheadChars ?? 0);
  let working: ChatMessage[] = messages.map(message => ({ ...message }));
  let compacted = 0;
  let dropped = 0;

  // The tool definitions travel with every request, so what the conversation may spend is the budget
  // minus their size — the mistake that let a "120000 token" budget send far more than that.
  const messageCharsOf = (list: ChatMessage[]) => messageChars(list);
  const promptChars = () => messageCharsOf(working) + overheadChars;
  const overBudget = () => Math.ceil(promptChars() / charsPerToken) > budgetTokens;
  const done = (): { messages: ChatMessage[]; report: ContextBudgetReport } => ({
    messages: working,
    report: { chars: promptChars(), overheadChars, estimatedTokens: Math.ceil(promptChars() / charsPerToken), budgetTokens, compacted, dropped },
  });

  if (!overBudget()) return done();

  // 1 — a user message can be a pasted file; it stays, but at a readable size.
  working = working.map(message => {
    if (message.role !== "user" || message.content.length <= USER_MESSAGE_CHARS + USER_MESSAGE_TAIL_CHARS) return message;
    compacted++;
    return { ...message, content: clip(message.content, USER_MESSAGE_CHARS, USER_MESSAGE_TAIL_CHARS, "сообщение сокращено") };
  });
  if (!overBudget()) return done();

  // 2 — old answers and tool results keep their beginning and end.
  const recentStart = Math.max(0, working.length - keepRecent);
  for (let i = 0; i < recentStart && overBudget(); i++) {
    const message = working[i];
    if (message.role === "user" || message.role === "system") continue;
    if (message.content.length <= COMPACT_HEAD_CHARS + COMPACT_TAIL_CHARS) continue;
    working[i] = { ...message, content: clip(message.content, COMPACT_HEAD_CHARS, COMPACT_TAIL_CHARS, "старый шаг сокращён") };
    compacted++;
  }
  if (!overBudget()) return done();

  // 3 — drop the oldest whole groups. The newest `keepRecent` messages and everything the user or
  // the system said are never touched.
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
    dropped += group.messages.length;
  }
  if (remove.size) {
    // One note where the cut begins, so the model knows the history is not complete. It goes after
    // the system messages: the prompt and the project context always stay first.
    let insertAt = 0;
    while (insertAt < working.length && working[insertAt].role === "system" && !remove.has(working[insertAt])) insertAt++;
    working = [...working.filter(message => !remove.has(message))];
    working.splice(insertAt, 0, { role: "system", content: "[более ранние шаги этого запуска сокращены: " + remove.size + " сообщений — их выводы уже учтены в следующих шагах]" });
  }
  if (!overBudget()) return done();

  // 4 — last resort: shorten what is left, newest included.
  for (let i = 0; i < working.length && overBudget(); i++) {
    const message = working[i];
    if (message.role === "user" || message.role === "system") continue;
    if (message.content.length <= SQUEEZE_HEAD_CHARS + SQUEEZE_TAIL_CHARS) continue;
    working[i] = { ...message, content: clip(message.content, SQUEEZE_HEAD_CHARS, SQUEEZE_TAIL_CHARS, "сокращено до предела") };
    compacted++;
  }
  if (overBudget()) {
    throw new ContextBudgetError(Math.ceil(promptChars() / charsPerToken), budgetTokens);
  }
  return done();
}
