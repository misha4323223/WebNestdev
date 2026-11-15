import { previewDoorApiBase } from "./door-client.js";
import { previewDoorToken } from "./door-token.js";
import { previewOwnerTarget } from "./preview-owner.js";
import type { PreviewStartProgress } from "./types.js";

/**
 * Логи предпросмотра — это состояние процесса, который держит preview, а не общая строка в
 * реестре. У static/hybrid вывод сборки и backend живут в памяти ноды-владельца, поэтому запрос
 * `preview.logs` на другой реплике раньше видел пустую локальную карту `runs`.
 *
 * Здесь два коротких внутренних запроса:
 *
 * - API-реплика → дверь владельца (`ownerAddress` из общего реестра);
 * - отдельный процесс двери → API своего узла (если дверь вынесена).
 *
 * Оба закрыты тем же токеном, что и остальной внутренний канал двери: он выводится из общего
 * ключа шифрования, поэтому не требует новой переменной окружения и не даёт читать логи без
 * доступа к кластеру. Публичный ticket здесь не подходит: он открывает приложение проекта, а не
 * служебный вывод платформы.
 */

export const PREVIEW_LOGS_DOOR_PATH = "/__internal/preview/logs";
export const PREVIEW_LOGS_API_PATH = "/api/internal/preview/logs";

export type PreviewLogsSnapshot = {
  running: boolean;
  logs: string;
  starting?: PreviewStartProgress;
};

export type PreviewLogsClientOptions = {
  /** База API для второго плеча (дверь → API). */
  base?: string;
  token?: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function validProgress(value: unknown): value is PreviewStartProgress {
  if (typeof value !== "object" || value === null) return false;
  const progress = value as Partial<PreviewStartProgress>;
  return typeof progress.phase === "string"
    && typeof progress.message === "string"
    && typeof progress.startedAt === "number"
    && typeof progress.updatedAt === "number";
}

function parseSnapshot(value: unknown): PreviewLogsSnapshot {
  if (typeof value !== "object" || value === null) {
    throw new Error("Владелец предпросмотра вернул некорректный ответ логов");
  }
  const body = value as { running?: unknown; logs?: unknown; starting?: unknown };
  if (typeof body.running !== "boolean" || typeof body.logs !== "string") {
    throw new Error("Владелец предпросмотра вернул некорректный ответ логов");
  }
  return {
    running: body.running,
    logs: body.logs,
    ...(validProgress(body.starting) ? { starting: body.starting } : {}),
  };
}

function ownerBase(ownerAddress: string): string {
  const target = previewOwnerTarget(ownerAddress);
  if (!target) throw new Error("Некорректный адрес двери-владельца предпросмотра");
  const host = target.host.includes(":") ? "[" + target.host + "]" : target.host;
  return "http://" + host + ":" + target.port;
}

async function requestSnapshot(url: string, projectId: string, options: PreviewLogsClientOptions): Promise<PreviewLogsSnapshot> {
  const token = options.token === undefined ? previewDoorToken() : options.token;
  if (!token) {
    throw new Error("Логи удалённого предпросмотра недоступны: WEBNESTDEV_ENCRYPTION_KEY не задан");
  }
  const id = projectId.trim();
  if (!id) throw new Error("Нужен projectId для логов предпросмотра");
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + token,
      },
      body: JSON.stringify({ projectId: id }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
    });
  } catch (error) {
    throw new Error("Владелец предпросмотра не ответил за логами: " + describeError(error));
  }
  if (!response.ok) {
    let detail = "";
    try {
      const error = (await response.json()) as { error?: unknown };
      if (typeof error?.error === "string" && error.error.trim()) detail = ": " + error.error.trim();
    } catch {
      // Тело ошибки не обязательно JSON; важен хотя бы HTTP-статус.
    }
    throw new Error("Владелец предпросмотра не отдал логи: HTTP " + response.status + detail);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Владелец предпросмотра вернул не JSON с логами");
  }
  return parseSnapshot(body);
}

/** Логи с двери ноды-владельца. */
export async function fetchPreviewLogsFromOwner(
  projectId: string,
  ownerAddress: string,
  options: PreviewLogsClientOptions = {},
): Promise<PreviewLogsSnapshot> {
  return requestSnapshot(ownerBase(ownerAddress) + PREVIEW_LOGS_DOOR_PATH, projectId, options);
}

/** Логи из API этого же узла — нужны вынесенной двери. */
export async function fetchPreviewLogsFromApi(
  projectId: string,
  options: PreviewLogsClientOptions = {},
): Promise<PreviewLogsSnapshot> {
  const base = (options.base ?? previewDoorApiBase()).replace(/\/+$/, "");
  return requestSnapshot(base + PREVIEW_LOGS_API_PATH, projectId, options);
}
