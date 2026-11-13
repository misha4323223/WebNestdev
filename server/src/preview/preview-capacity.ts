import type { PreviewMode } from "./types.js";

/**
 * Сколько места на ноде занимает runtime-preview.
 *
 * Hybrid и container — не равные единицы. Hybrid держит в контейнере только backend, а
 * статику отдаёт listener в процессе API; обычный preview держит целый dev-server. Поэтому
 * общий бюджет ноды считается в «hybrid-слотах»: hybrid = 1, Docker = `containerUnits`.
 *
 * Замер на одной ноде: 12 hybrid — максимум, а 2 обычных Docker занимают почти всю ноду.
 * Отсюда бюджет 12 и вес Docker 6. Hybrid отдельно ограничен 8, чтобы в production оставался
 * запас, даже когда Docker не запущен.
 */
export type RuntimeLimits = {
  /** Максимум чистых Docker-preview на ноде; 0 — без ограничения. */
  containerLimit: number;
  /** Максимум hybrid-preview на ноде; 0 — без ограничения. */
  hybridLimit: number;
  /** Общий бюджет ноды в hybrid-слотах; 0 — без общего бюджета. */
  hostUnits: number;
  /** Сколько hybrid-слотов занимает один чистый Docker-preview. */
  containerUnits: number;
};

export type RuntimePreviewMode = "container" | "hybrid";

export type RuntimePreviewRef = {
  projectId: string;
  mode?: PreviewMode;
  node?: string;
};

export function runtimeModeOf(mode: PreviewMode | undefined): RuntimePreviewMode {
  return mode === "hybrid" ? "hybrid" : "container";
}

export function runtimeModeUnits(mode: RuntimePreviewMode, limits: RuntimeLimits): number {
  return mode === "container" ? Math.max(1, limits.containerUnits) : 1;
}

export function runtimeModeLimit(mode: RuntimePreviewMode, limits: RuntimeLimits): number {
  return mode === "container" ? limits.containerLimit : limits.hybridLimit;
}

function modeLabel(mode: RuntimePreviewMode): string {
  return mode === "container" ? "контейнерных" : "hybrid";
}

function modeLimitName(mode: RuntimePreviewMode): string {
  return mode === "container" ? "PREVIEW_MAX_CONTAINERS" : "PREVIEW_MAX_HYBRID";
}

/**
 * Причина, по которой новый runtime-preview не помещается на ноду, или null.
 *
 * Проверяются два независимых ограничения:
 * 1. потолок своего режима — чтобы 8 hybrid не превратились в 8 Docker;
 * 2. общий бюджет в hybrid-слотах — чтобы 8 hybrid не запускались одновременно с двумя
 *    Docker, которые уже заняли всю ноду.
 *
 * Preview и брони другой реплики видны в общем реестре, но место на этой ноде не занимают.
 * `ignoreProjectIds` — preview, которые будут остановлены до старта нового: их слоты
 * освободятся, поэтому в проверке они не участвуют.
 */
export function runtimeCapacityRefusal(input: {
  live: RuntimePreviewRef[];
  reservations?: RuntimePreviewRef[];
  projectId: string;
  startingMode: RuntimePreviewMode;
  limits: RuntimeLimits;
  node?: string;
  ignoreProjectIds?: Iterable<string>;
}): string | null {
  const ignore = new Set(input.ignoreProjectIds ?? []);
  ignore.add(input.projectId);
  const onThisNode = (node: string | undefined) => !input.node || !node || node === input.node;
  // Один проект может быть одновременно в живом реестре и в брони: state записывается до
  // снятия брони. Считать его дважды нельзя, иначе нода выглядит занятой без причины. Ключ
  // включает узел: при переезде проекта старая строка на другой ноде не должна прятать
  // свежую бронь на этой.
  const nodeKey = (node: string | undefined) => node || input.node || "";
  const combined = new Map<string, RuntimePreviewRef>();
  for (const preview of [...input.live, ...(input.reservations ?? [])]) {
    const key = preview.projectId + "\u0000" + nodeKey(preview.node);
    if (!combined.has(key)) combined.set(key, preview);
  }
  const host = [...combined.values()].filter(
    preview => !ignore.has(preview.projectId) && onThisNode(preview.node),
  );

  const sameMode = host.filter(preview => runtimeModeOf(preview.mode) === input.startingMode);
  const modeLimit = runtimeModeLimit(input.startingMode, input.limits);
  if (modeLimit > 0 && sameMode.length >= modeLimit) {
    return (
      "На этом хосте уже работают " + modeLimit + " " + modeLabel(input.startingMode) +
      " предпросмотров (" + modeLimitName(input.startingMode) + "): остановите предпросмотр " +
      "другого проекта или поднимите лимит."
    );
  }

  if (input.limits.hostUnits <= 0) return null;
  const used = host.reduce(
    (sum, preview) => sum + runtimeModeUnits(runtimeModeOf(preview.mode), input.limits),
    0,
  );
  const need = runtimeModeUnits(input.startingMode, input.limits);
  if (used + need > input.limits.hostUnits) {
    return (
      "На этом хосте занято " + used + " из " + input.limits.hostUnits + " слотов предпросмотров " +
      "(Docker = " + Math.max(1, input.limits.containerUnits) + ", hybrid = 1). Новому " +
      modeLabel(input.startingMode) + " предпросмотру нужно ещё слотов: " + need + ". " +
      "Остановите предпросмотр другого проекта или поднимите PREVIEW_HOST_UNITS."
    );
  }
  return null;
}

export function describeRuntimeCapacity(limits: RuntimeLimits): string {
  const container = limits.containerLimit > 0 ? String(limits.containerLimit) : "без ограничения";
  const hybrid = limits.hybridLimit > 0 ? String(limits.hybridLimit) : "без ограничения";
  const units = limits.hostUnits > 0 ? String(limits.hostUnits) : "без ограничения";
  return (
    "Docker: " + container + " (вес " + Math.max(1, limits.containerUnits) + "); " +
    "hybrid: " + hybrid + "; слотов на ноде: " + units
  );
}
