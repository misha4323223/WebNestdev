import { timingSafeEqual } from "node:crypto";

/** Тот же внутренний токен, что у owner-door и owner-router. Значение не логируется. */
export function internalToken(env: NodeJS.ProcessEnv = process.env): string {
  return env.WEBNESTDEV_INTERNAL_TOKEN?.trim() ?? "";
}

export function validInternalToken(received: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  const expected = internalToken(env);
  const value = typeof received === "string" ? received : "";
  if (expected.length < 32 || value.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(value), Buffer.from(expected));
  } catch {
    return false;
  }
}
