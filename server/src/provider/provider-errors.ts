/**
 * What went wrong on the provider side, in terms the runtime can act on.
 *
 * A gateway answers a failed request with a status, and the useful part — is the key wrong, is the
 * model rate-limited, is the context too long, is the message list too long — is in the body. Two
 * codes have a recovery path inside a run (send less and try the step again): `CONTEXT_OVERFLOW`
 * for the size of the prompt and `TOO_MANY_MESSAGES` for the length of the `messages` array, which
 * a validating gateway refuses on its own — a hundred short messages are small and still refused.
 * Everything else is reported to the user as a clear sentence instead of a wall of JSON.
 */
export type ProviderErrorCode = "CONTEXT_OVERFLOW" | "TOO_MANY_MESSAGES" | "AUTH" | "RATE_LIMIT" | "UNAVAILABLE" | "BAD_REQUEST";

/** The numbers a refusal carries, when the gateway spells them out. */
export type ProviderErrorNumbers = { inputTokens?: number; limitTokens?: number; limitMessages?: number };

const CONTEXT_PATTERN = /context[_ ]?(window|length)|maximum context|too many tokens|token limit|contextwindowexceeded|prompt is too long|input is too long/i;
const INPUT_TOKENS_PATTERN = /\((\d{2,})\s*tokens?\)/i;
const LIMIT_TOKENS_PATTERN = /(?:context (?:length|window)|limit)(?:\s*is)?\s*\(?\s*(\d{2,})\s*\)?\s*tokens?/i;
/**
 * A gateway that validates the body before it calls the model. The one this platform talks to
 * answers `[{"origin":"array","code":"too_big","maximum":100,"path":["messages"]}]`; others say
 * "at most 100 items" or "too many messages". Only the count of the `messages` array is meant here —
 * `too_big` on its own could be about anything, so it counts only together with `messages`.
 */
const MESSAGE_COUNT_PATTERN = /"code"\s*:\s*"too[_ ]?big"[\s\S]{0,200}?"path"\s*:\s*\[\s*"messages"|expected array to have|too many messages|at most \d+ (?:items|messages)|maximum of \d+ (?:items|messages)/i;
const MAX_MESSAGES_PATTERN = /"maximum"\s*:\s*(\d+)|at most (\d+)\s+(?:items|messages)|maximum of (\d+)\s+(?:items|messages)/i;
/**
 * The two ways a gateway says "come back later": the standard header, and the same number inside the
 * body, which is what the routers this platform talks to actually send. A rate-limited step waits
 * that long before it tries again (provider-retry.ts), so the hint is worth reading.
 */
const RETRY_AFTER_SECONDS_PATTERN = /"retry[_ ]?after"\s*:\s*"?(\d+(?:\.\d+)?)"?/i;
const RETRY_AFTER_MILLIS_PATTERN = /"retry[_ ]?after_ms"\s*:\s*"?(\d+)"?/i;
const RETRY_AFTER_PHRASE_PATTERN = /retry[^0-9]{0,20}(\d+)\s*(?:sec|second|s\b)|повторите[^0-9]{0,20}(\d+)\s*сек/i;

/**
 * `Retry-After` in milliseconds, from either of its two forms: a number of seconds or an HTTP date.
 * `undefined` means the gateway said nothing useful, and the caller falls back to its own backoff.
 */
export function parseRetryAfterHeader(value:string|null|undefined,now=Date.now()):number|undefined {
  const trimmed=(value??"").trim();
  if(!trimmed)return undefined;
  if(/^\d+(\.\d+)?$/.test(trimmed))return Math.max(0,Math.ceil(Number(trimmed)*1000));
  const date=Date.parse(trimmed);
  return Number.isFinite(date)?Math.max(0,date-now):undefined;
}

/** The same hint when it is written in the JSON body instead of the headers. */
export function parseRetryAfterHint(body:string):number|undefined {
  const millis=RETRY_AFTER_MILLIS_PATTERN.exec(body);
  if(millis)return Math.max(0,Number(millis[1]));
  const seconds=RETRY_AFTER_SECONDS_PATTERN.exec(body);
  if(seconds)return Math.max(0,Math.ceil(Number(seconds[1])*1000));
  const phrase=RETRY_AFTER_PHRASE_PATTERN.exec(body);
  const fromPhrase=phrase?Number(phrase[1]??phrase[2]):NaN;
  return Number.isFinite(fromPhrase)?Math.max(0,fromPhrase*1000):undefined;
}

export function classifyProviderError(status: number, body: string): ProviderErrorCode {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 429) return "RATE_LIMIT";
  if (status >= 500) return "UNAVAILABLE";
  if (MESSAGE_COUNT_PATTERN.test(body)) return "TOO_MANY_MESSAGES";
  if (CONTEXT_PATTERN.test(body)) return "CONTEXT_OVERFLOW";
  return "BAD_REQUEST";
}

/** Reads the cap out of a body like `"maximum":100` or "at most 100 items". */
export function parseMaxMessages(body: string): number | undefined {
  const match = MAX_MESSAGES_PATTERN.exec(body);
  const value = match ? Number(match.slice(1).find(Boolean)) : NaN;
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Reads the numbers out of a body like "The input (932489 tokens) is longer than the model's context length (524288 tokens)". */
export function parseContextOverflow(body: string): ProviderErrorNumbers {
  const input = INPUT_TOKENS_PATTERN.exec(body);
  const limit = LIMIT_TOKENS_PATTERN.exec(body);
  return {
    ...(input ? { inputTokens: Number(input[1]) } : {}),
    ...(limit ? { limitTokens: Number(limit[1]) } : {}),
  };
}

/**
 * A failed provider request. `message` is what the user reads, so it names the problem and the fix;
 * `detail` keeps the gateway's own text for the log, bounded so one error cannot flood it.
 */
export class ProviderHttpError extends Error {
  readonly code: ProviderErrorCode;
  readonly status: number;
  readonly detail: string;
  readonly inputTokens?: number;
  readonly limitTokens?: number;
  /** The `messages` cap the gateway stated, when it refused on the length of the array. */
  readonly limitMessages?: number;
  /** How long the gateway itself asked to wait, when it said so (`Retry-After`, or the same in the body). */
  readonly retryAfterMs?: number;

  constructor(status: number, body: string, retryAfterMs?: number) {
    const code = classifyProviderError(status, body);
    const numbers: ProviderErrorNumbers = code === "CONTEXT_OVERFLOW" ? parseContextOverflow(body)
      : code === "TOO_MANY_MESSAGES" ? { limitMessages: parseMaxMessages(body) }
      : {};
    const detail = body.trim().replace(/\s+/g, " ").slice(0, 500);
    super(describeProviderError(status, code, numbers, detail));
    this.name = "ProviderHttpError";
    this.code = code;
    this.status = status;
    this.detail = detail;
    this.inputTokens = numbers.inputTokens;
    this.limitTokens = numbers.limitTokens;
    this.limitMessages = numbers.limitMessages;
    const wait = retryAfterMs ?? parseRetryAfterHint(detail);
    this.retryAfterMs = wait && wait > 0 ? wait : undefined;
  }
}

export function describeProviderError(status: number, code: ProviderErrorCode, numbers: ProviderErrorNumbers, detail: string) {
  const size = numbers.inputTokens && numbers.limitTokens
    ? `: ${numbers.inputTokens} токенов при лимите модели ${numbers.limitTokens}`
    : "";
  switch (code) {
    case "CONTEXT_OVERFLOW":
      return `Модель отказалась принять контекст${size}. Агент сокращает историю и повторяет шаг; если это повторяется, начните новый диалог — в старом уже слишком много материала.`;
    case "TOO_MANY_MESSAGES":
      return "Провайдер принимает не больше " + (numbers.limitMessages ?? "ограниченного числа") + " сообщений в одном запросе (HTTP " + status + "). Агент сокращает историю и повторяет шаг; если это повторяется, начните новый диалог — в старом слишком много шагов.";
    case "AUTH":
      return "Провайдер отклонил ключ доступа (HTTP " + status + "). Проверьте ключ модели в настройках проекта или платформы.";
    case "RATE_LIMIT":
      return "Провайдер ограничил частоту запросов (HTTP 429). Подождите минуту и повторите запуск.";
    case "UNAVAILABLE":
      return "Провайдер недоступен (HTTP " + status + "). Это на его стороне — повторите запуск через минуту.";
    default:
      return "Провайдер отклонил запрос (HTTP " + status + ")" + (detail ? ": " + detail : ".");
  }
}

/** The log-friendly one-liner: status, code and the gateway's own words. */
export function describeProviderFailure(error: ProviderHttpError) {
  return `HTTP ${error.status} (${error.code}): ${error.detail}`;
}
