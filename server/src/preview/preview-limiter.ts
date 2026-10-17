import { listPreviews } from "./preview-store.js";
import type { PreviewState } from "./types.js";

/**
 * Сколько контейнерных предпросмотров держит один аккаунт.
 *
 * Правило продукта: **один**. Второй предпросмотр того же пользователя останавливает его же
 * прежний — так счёт за память понятен каждому, а два проекта одного человека не борются за
 * хост. Статический предпросмотр (слушатель в процессе сервера, ~0.5 МБ) этот лимит не занимает:
 * он не контейнер и памяти почти не стоит.
 *
 * `PREVIEW_MAX_PER_USER=0` снимает ограничение — тот же приём, что у `PREVIEW_IDLE_MS=0`.
 */
export function perUserPreviewLimit() {
  const raw = process.env.PREVIEW_MAX_PER_USER?.trim();
  if (!raw) return 1;
  const parsed = Number(raw);
  // Здесь `0` — значение, а не опечатка: «без ограничения».
  if (!Number.isFinite(parsed) || parsed < 0) return 1;
  return Math.floor(parsed);
}

/**
 * Необязательный предохранитель на весь хост: сколько контейнерных предпросмотров живёт
 * одновременно у всех пользователей вместе.
 *
 * По умолчанию его нет (`0`): счёт ведётся на аккаунт, а не на машину, иначе сто пользователей
 * делят три места. Предохранитель остаётся доступным для тесного хоста — `PREVIEW_MAX_CONTAINERS=4`
 * ограничивает сумму, не меняя правило «один на аккаунт».
 */
export function runtimePreviewLimit() {
  const raw = process.env.PREVIEW_MAX_CONTAINERS?.trim();
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

/** Live runtime previews right now, cheapest source of truth for the cap and for /api/health. */
export function liveRuntimePreviews(): PreviewState[] {
  return listPreviews().filter(state => state.mode === "container");
}

/** Live static previews: a listener each, for the same health line. */
export function liveStaticPreviews(): PreviewState[] {
  return listPreviews().filter(state => state.mode === "static");
}

export type LiveRuntimePreview = { projectId: string; userId?: string; lastUsedAt: number };
export type RuntimeStartDecision = { ok: true; stopProjectId?: string } | { ok: false; reason: string };

/**
 * Whether one more runtime preview fits. The account rule comes first, the host brake second:
 *
 * - у пользователя уже есть свой предпросмотр (и лимит на аккаунт = 1) — останавливаем его же
 *   самый старый и запускаем новый: это то, что человек сделал бы сам, и его второй проект не
 *   получает отказ из-за его же первого;
 * - предпросмотр без известного владельца чужому не приписывается и не останавливается;
 * - если хост ограничен (`PREVIEW_MAX_CONTAINERS` > 0) и места нет — отказ с причиной, а не
 *   остановка чужого приложения за спиной.
 */
export function decideRuntimePreviewStart(input: {
  live: LiveRuntimePreview[];
  projectId: string;
  userId: string;
  /** Лимит на аккаунт; по умолчанию `perUserPreviewLimit()`. */
  perUser?: number;
  /** Предохранитель хоста; по умолчанию `runtimePreviewLimit()` (0 — без предохранителя). */
  limit?: number;
}): RuntimeStartDecision {
  const perUser = input.perUser ?? perUserPreviewLimit();
  const hostLimit = input.limit ?? runtimePreviewLimit();
  const others = input.live.filter(preview => preview.projectId !== input.projectId);
  // Только предпросмотр с известным владельцем может быть «своим»: запрос без владельца ничего
  // не присваивает, а чужое приложение не останавливается ни при каких условиях.
  const own = (input.userId ? others.filter(preview => preview.userId === input.userId) : [])
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  if (perUser > 0 && own.length >= perUser) return { ok: true, stopProjectId: own[0].projectId };
  if (hostLimit > 0 && others.length >= hostLimit) {
    return {
      ok: false,
      reason:
        "На этом хосте одновременно работают " + hostLimit + " серверных предпросмотров (PREVIEW_MAX_CONTAINERS): " +
        "остановите предпросмотр другого проекта или поднимите лимит. Готовые статические проекты этот лимит не занимают.",
    };
  }
  return { ok: true };
}

/**
 * Printed once at startup, so the host's real ceilings are visible in the logs next to the
 * preview mode. The idle timeout is logged by the sweeper, which owns that number.
 */
export function describePreviewLimits() {
  const perUser = perUserPreviewLimit();
  const host = runtimePreviewLimit();
  return (
    "предпросмотров на аккаунт: " + (perUser > 0 ? perUser : "без ограничения") +
    "; одновременно на хосте: " + (host > 0 ? host : "без ограничения")
  );
}
