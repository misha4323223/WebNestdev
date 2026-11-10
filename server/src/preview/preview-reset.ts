import type { SandboxHost } from "../sandbox/host.js";
import { resolveSandboxHost } from "../sandbox/host.js";
import { clearPreviewSecrets } from "../secrets/preview-secrets.js";
import { clearPreviewReservation } from "./preview-reservation.js";
import { flushPreviewWrites, removePreview } from "./preview-store.js";
import { stopStaticPreview } from "./static-preview.js";
import { PREVIEW_LABEL } from "./types.js";

/**
 * Ручной сброс предпросмотра для внешней админки.
 *
 * Автоматическая защита закрывает только те случаи, где контейнер уже существует: его можно
 * принять по метке или убрать при остановке. Остаются зависшая бронь без контейнера, потерянная
 * строка состояния, контейнер на прежнем узле и упавший между шагами запуск. Здесь оператор
 * получает один идемпотентный путь: снять все контейнеры проекта, убрать строку реестра, снять
 * бронь и удалить временные env-файлы. Следующий запуск начинает с чистого состояния.
 *
 * Сначала контейнеры, потом состояние и бронь: если Docker недоступен, ошибка попадает в
 * `warnings`, но бронь всё равно снимается — иначе ручка не решала бы свою главную задачу.
 */

export type PreviewResetResult = {
  removedContainers: string[];
  remainingContainers: string[];
  stateRemoved: boolean;
  reservationCleared: boolean;
  warnings: string[];
};

export type PreviewResetDeps = {
  resolveHost: (node: string) => Promise<SandboxHost>;
  removeState: (projectId: string) => void;
  /** Статический preview живёт слушателем в процессе, а не контейнером. */
  stopStatic: (projectId: string) => Promise<void>;
  flushWrites: (projectId: string) => Promise<void>;
  clearReservation: (projectId: string) => Promise<boolean>;
  clearSecrets: (projectId: string) => Promise<void>;
};

const defaultDeps: PreviewResetDeps = {
  resolveHost: node => resolveSandboxHost(node),
  removeState: projectId => removePreview(projectId),
  stopStatic: projectId => stopStaticPreview(projectId),
  flushWrites: projectId => flushPreviewWrites(projectId),
  clearReservation: projectId => clearPreviewReservation(projectId),
  clearSecrets: projectId => clearPreviewSecrets(projectId),
};

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function resetProjectPreview(
  projectId: string,
  nodes: string[],
  overrides: Partial<PreviewResetDeps> = {},
): Promise<PreviewResetResult> {
  const deps: PreviewResetDeps = { ...defaultDeps, ...overrides };
  const uniqueNodes = [...new Set(nodes.filter(Boolean))];
  const found = new Set<string>();
  const removed = new Set<string>();
  const warnings: string[] = [];

  for (const node of uniqueNodes) {
    try {
      const host = await deps.resolveHost(node);
      const listed = await host.docker(
        ["ps", "-aq", "--filter", "label=" + PREVIEW_LABEL + "=" + projectId],
        10_000,
      );
      if (listed.code !== 0) {
        warnings.push("узел " + node + ": Docker не отдал список контейнеров: " + listed.stderr.trim());
        continue;
      }
      const ids = listed.stdout.split(/\s+/).filter(Boolean);
      for (const id of ids) found.add(id);
      for (const id of ids) {
        const result = await host.docker(["rm", "-f", id], 20_000).catch(error => ({
          code: -1,
          stdout: "",
          stderr: describeError(error),
        }));
        if (result.code === 0) removed.add(id);
        else warnings.push("узел " + node + ": контейнер " + id.slice(0, 12) + " не удалён: " + result.stderr.trim());
      }
    } catch (error) {
      warnings.push("узел " + node + ": " + describeError(error));
    }
  }

  // Статический preview не имеет контейнера: его слушатель нужно закрыть отдельно.
  try {
    await deps.stopStatic(projectId);
  } catch (error) {
    warnings.push("статический предпросмотр: " + describeError(error));
  }

  // Локальная карта и общий реестр: removePreview ставит удаление в очередь, flush ждёт, пока
  // строка действительно исчезнет, — иначе следующий запуск мог бы прочитать её из базы.
  deps.removeState(projectId);
  try {
    await deps.flushWrites(projectId);
  } catch (error) {
    warnings.push("общий реестр: " + describeError(error));
  }

  const reservationCleared = await deps.clearReservation(projectId);
  if (!reservationCleared) warnings.push("бронь запуска снять не удалось");

  try {
    await deps.clearSecrets(projectId);
  } catch (error) {
    warnings.push("временные env-файлы: " + describeError(error));
  }

  return {
    removedContainers: [...removed],
    remainingContainers: [...found].filter(id => !removed.has(id)),
    stateRemoved: true,
    reservationCleared,
    warnings,
  };
}
