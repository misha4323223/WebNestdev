/**
 * What went wrong on the provider side, in terms the runtime can act on.
 *
 * A gateway answers a failed request with a status, and the useful part — is the key wrong, is the
 * model rate-limited, is the context too long — is in the body. Only `CONTEXT_OVERFLOW` has a
 * recovery path inside a run (the runtime sends a smaller context and tries the step again), so it
 * is worth separating from the rest; everything else is reported to the user as a clear sentence
 * instead of a wall of JSON.
 */
export type ProviderErrorCode = "CONTEXT_OVERFLOW" | "AUTH" | "RATE_LIMIT" | "UNAVAILABLE" | "BAD_REQUEST";

/** The two numbers a context-overflow body carries, when the gateway spells them out. */
export type ContextOverflowNumbers = { inputTokens?: number; limitTokens?: number };

const CONTEXT_PATTERN = /context[_ ]?(window|length)|maximum context|too many tokens|token limit|contextwindowexceeded|prompt is too long|input is too long/i;
const INPUT_TOKENS_PATTERN = /\((\d{2,})\s*tokens?\)/i;
const LIMIT_TOKENS_PATTERN = /(?:context (?:length|window)|limit)(?:\s*is)?\s*\(?\s*(\d{2,})\s*\)?\s*tokens?/i;

export function classifyProviderError(status: number, body: string): ProviderErrorCode {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 429) return "RATE_LIMIT";
  if (status >= 500) return "UNAVAILABLE";
  if (CONTEXT_PATTERN.test(body)) return "CONTEXT_OVERFLOW";
  return "BAD_REQUEST";
}

/** Reads the numbers out of a body like "The input (932489 tokens) is longer than the model's context length (524288 tokens)". */
export function parseContextOverflow(body: string): ContextOverflowNumbers {
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

  constructor(status: number, body: string) {
    const code = classifyProviderError(status, body);
    const numbers = code === "CONTEXT_OVERFLOW" ? parseContextOverflow(body) : {};
    const detail = body.trim().replace(/\s+/g, " ").slice(0, 500);
    super(describeProviderError(status, code, numbers, detail));
    this.name = "ProviderHttpError";
    this.code = code;
    this.status = status;
    this.detail = detail;
    this.inputTokens = numbers.inputTokens;
    this.limitTokens = numbers.limitTokens;
  }
}

export function describeProviderError(status: number, code: ProviderErrorCode, numbers: ContextOverflowNumbers, detail: string) {
  const size = numbers.inputTokens && numbers.limitTokens
    ? `: ${numbers.inputTokens} токенов при лимите модели ${numbers.limitTokens}`
    : "";
  switch (code) {
    case "CONTEXT_OVERFLOW":
      return `Модель отказалась принять контекст${size}. Агент сокращает историю и повторяет шаг; если это повторяется, начните новый диалог — в старом уже слишком много материала.`;
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
