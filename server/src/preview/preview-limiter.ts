import os from "node:os";
import { listPreviews } from "./preview-store.js";
import { isRuntimePreviewMode, type PreviewState } from "./types.js";
import {
  describeRuntimeCapacity,
  runtimeCapacityRefusal,
  runtimeModeOf,
  type RuntimeLimits,
  type RuntimePreviewMode,
} from "./preview-capacity.js";

/**
 * Сколько runtime-предпросмотров держит один аккаунт.
 *
 * Правило продукта: **один**. Второй предпросмотр того же пользователя останавливает его же
 * прежний — так счёт за память понятен каждому, а два проекта одного человека не борются за
 * хост. Static-предпросмотр (слушатель в процессе сервера, ~0.5 МБ) этот лимит не занимает:
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
 * Потолок **чистых Docker-preview** на одной ноде.
 *
 * Раньше это был общий потолок для container и hybrid. Теперь hybrid считается отдельно:
 * обычный dev-server стоит нескольких hybrid, поэтому общий бюджет ноды считается в
 * hybrid-слотах (см. `preview-capacity.ts`), а этот лимит запрещает подменять 8 hybrid
 * восемью Docker-контейнерами.
 *
 * По умолчанию число выводится из памяти машины (примерно по 1 ГБ на контейнер, не больше 8).
 * Явное `PREVIEW_MAX_CONTAINERS` важнее; `0` снимает ограничение.
 */
export function runtimePreviewLimit() {
  const raw = process.env.PREVIEW_MAX_CONTAINERS?.trim();
  if (raw === "0") return 0;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return Math.max(1, Math.min(8, Math.floor(os.totalmem() / 1024 / 1024 / 1024)));
}

/** Потолок hybrid-preview на ноде; по умолчанию совпадает с потолком Docker. */
export function hybridPreviewLimit() {
  const raw = process.env.PREVIEW_MAX_HYBRID?.trim();
  if (raw === "0") return 0;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return runtimePreviewLimit();
}

/**
 * Общий бюджет ноды в hybrid-слотах.
 *
 * 12 — измеренный максимум hybrid на одной ноде. Если переменная не задана, сохраняется
 * прежнее поведение: бюджет равен большему из двух потолков, а Docker весит один слот.
 */
export function runtimeHostUnits() {
  const raw = process.env.PREVIEW_HOST_UNITS?.trim();
  if (raw === "0") return 0;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  const container = runtimePreviewLimit();
  const hybrid = hybridPreviewLimit();
  if (container === 0 || hybrid === 0) return 0;
  return Math.max(container, hybrid);
}

/**
 * Сколько hybrid-слотов занимает чистый Docker-preview.
 *
 * Замер: 12 hybrid — максимум ноды, 2 Docker занимают почти всю ноду. Поэтому один Docker
 * весит 6 hybrid-слотов. Значение задаётся явно, чтобы на другой ВМ можно было пересчитать
 * бюджет без изменения кода.
 */
export function containerRuntimeUnits() {
  const raw = process.env.PREVIEW_CONTAINER_UNITS?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  // Если задан только hybrid-потолок, выводим вес Docker так, чтобы два Docker занимали
  // весь production-бюджет, а не оставляли место для hybrid. Это безопасный default:
  // точные 12/6 всё равно задаются явно в production-конфиге.
  const hybrid = hybridPreviewLimit();
  const container = runtimePreviewLimit();
  return hybrid > 0 && container > 0 ? Math.max(1, Math.ceil(hybrid / container)) : 1;
}

export function previewRuntimeLimits(): RuntimeLimits {
  return {
    containerLimit: runtimePreviewLimit(),
    hybridLimit: hybridPreviewLimit(),
    hostUnits: runtimeHostUnits(),
    containerUnits: containerRuntimeUnits(),
  };
}

/** Live runtime previews right now, cheapest source of truth for the cap and for /api/health. */
export function liveRuntimePreviews(): PreviewState[] {
  return listPreviews().filter(state => isRuntimePreviewMode(state.mode));
}

/** Live static previews: a listener each, for the same health line. */
export function liveStaticPreviews(): PreviewState[] {
  return listPreviews().filter(state => state.mode === "static");
}

export type LiveRuntimePreview = {
  projectId: string;
  userId?: string;
  lastUsedAt: number;
  node?: string;
  mode?: PreviewState["mode"];
};
export type RuntimeStartDecision = { ok: true; stopProjectId?: string } | { ok: false; reason: string };

/**
 * Whether one more runtime preview fits. The account rule comes first, the host brake second:
 *
 * - у пользователя уже есть свой предпросмотр (и лимит на аккаунт = 1) — останавливаем его же
 *   самый старый и запускаем новый;
 * - предпросмотр без известного владельца чужому не приписывается и не останавливается;
 * - если на ноде нет места по потолку своего режима или по общему бюджету — отказ с причиной,
 *   а не остановка чужого приложения за спиной.
 */
export function decideRuntimePreviewStart(input: {
  live: LiveRuntimePreview[];
  projectId: string;
  userId: string;
  /** Какой режим запускается: Docker и hybrid считаются по-разному. */
  mode?: RuntimePreviewMode;
  /** Узел, для которого считается бюджет. */
  node?: string;
  /** Лимит на аккаунт; по умолчанию `perUserPreviewLimit()`. */
  perUser?: number;
  /** Потолки и веса; по умолчанию из окружения. */
  limits?: RuntimeLimits;
}): RuntimeStartDecision {
  const perUser = input.perUser ?? perUserPreviewLimit();
  const limits = input.limits ?? previewRuntimeLimits();
  const startingMode = input.mode ?? "container";
  const others = input.live.filter(preview => preview.projectId !== input.projectId);
  // Только предпросмотр с известным владельцем может быть «своим»: запрос без владельца ничего
  // не присваивает, а чужое приложение не останавливается ни при каких условиях.
  const own = (input.userId ? others.filter(preview => preview.userId === input.userId) : [])
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  const stop = perUser > 0 && own.length >= perUser ? own[0] : undefined;
  const refusal = runtimeCapacityRefusal({
    live: input.live,
    projectId: input.projectId,
    startingMode,
    limits,
    node: input.node,
    ignoreProjectIds: stop ? [stop.projectId] : [],
  });
  if (refusal) return { ok: false, reason: refusal };
  return stop ? { ok: true, stopProjectId: stop.projectId } : { ok: true };
}

/**
 * Printed once at startup, so the host's real ceilings are visible in the logs next to the
 * preview mode. The idle timeout is logged by the sweeper, which owns that number.
 */
export function describePreviewLimits() {
  const perUser = perUserPreviewLimit();
  return (
    "предпросмотров на аккаунт: " + (perUser > 0 ? perUser : "без ограничения") +
    "; " + describeRuntimeCapacity(previewRuntimeLimits())
  );
}

/** Для health: сколько слотов занято прямо сейчас, с учётом веса Docker. */
export function runtimeUnitsInUse(states: PreviewState[], limits = previewRuntimeLimits()): number {
  return states
    .filter(state => isRuntimePreviewMode(state.mode))
    .reduce(
      (sum, state) =>
        sum + (runtimeModeOf(state.mode) === "container" ? Math.max(1, limits.containerUnits) : 1),
      0,
    );
}
