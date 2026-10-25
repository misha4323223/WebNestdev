import { randomBytes } from "node:crypto";

/**
 * Одноразовые «пропуска» между шагами админского входа.
 *
 * Пароль проверен, но второй фактор ещё нет — клиенту нужно чем-то доказать, что он продолжает тот
 * же вход. Пропуск живёт в памяти процесса, как и счётчики попыток входа: попытки кода надо считать
 * на сервере, иначе клиент мог бы предъявлять один и тот же пропуск бесконечно и перебрать миллион
 * шестизначных кодов в обход лимита.
 *
 * Цена решения — перезапуск сервера обрывает незаконченный вход (нужно повторить пароль), а при
 * нескольких репликах пропуск обязан вернуться на ту же реплику. Сервер и так держит счётчики
 * попыток и очередь песочниц в памяти, поэтому отдельного хранилища здесь не появилось.
 */

/** Сколько у человека есть на ввод кода, прежде чем пропуск истечёт. */
const DEFAULT_TTL_MS = 10 * 60 * 1000;
/** Сколько раз можно ошибиться в коде в рамках одного входа. */
export const MAX_CHALLENGE_ATTEMPTS = 5;
/** Потолок одновременных пропусков: вход администратора — редкое событие, больше не нужно. */
const MAX_ENTRIES = 5_000;

export type AdminChallengeStage = "enroll" | "verify";

export type AdminChallengeState = {
  adminId: string;
  stage: AdminChallengeStage;
  /** Base32-секрет, который ещё не подтверждён кодом (только для stage=enroll). */
  secret: string;
  attempts: number;
  expiresAt: number;
};

const challenges = new Map<string, AdminChallengeState>();

function ttlMs() {
  const raw = Number(process.env.ADMIN_CHALLENGE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TTL_MS;
}

function sweep(now: number) {
  for (const [id, state] of challenges) {
    if (state.expiresAt <= now) challenges.delete(id);
  }
}

export function createAdminChallenge(input: { adminId: string; stage: AdminChallengeStage; secret?: string }, now = Date.now()): string {
  sweep(now);
  if (challenges.size >= MAX_ENTRIES) {
    const oldest = challenges.keys().next().value;
    if (oldest !== undefined) challenges.delete(oldest);
  }
  const id = randomBytes(24).toString("base64url");
  challenges.set(id, {
    adminId: input.adminId,
    stage: input.stage,
    secret: input.secret ?? "",
    attempts: 0,
    expiresAt: now + ttlMs(),
  });
  return id;
}

export function readAdminChallenge(id: string, now = Date.now()): AdminChallengeState | null {
  const value = (id ?? "").trim();
  if (!value) return null;
  const state = challenges.get(value);
  if (!state) return null;
  if (state.expiresAt <= now) {
    challenges.delete(value);
    return null;
  }
  return state;
}

/**
 * Ошибка в коде: считаем её на сервере. Возвращает, сколько попыток осталось; ноль означает, что
 * пропуск уже уничтожен и вход надо начинать с пароля.
 */
export function recordAdminChallengeFailure(id: string): number {
  const state = challenges.get(id);
  if (!state) return 0;
  state.attempts += 1;
  if (state.attempts >= MAX_CHALLENGE_ATTEMPTS) {
    challenges.delete(id);
    return 0;
  }
  return MAX_CHALLENGE_ATTEMPTS - state.attempts;
}

export function dropAdminChallenge(id: string): void {
  challenges.delete(id);
}

export function clearAdminChallenges(): void {
  challenges.clear();
}
