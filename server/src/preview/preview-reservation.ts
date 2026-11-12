import { randomUUID } from "node:crypto";
import { nodeId } from "../nodes/identity.js";
import { getTable, initializeStorage, isYdbEnabled, ydbQuery } from "../storage/pg.js";

/**
 * Бронь на запуск container-preview. Проверка лимита и сам старт не атомарны: между чтением
 * общего реестра и появлением в нём новой строки проходит время установки зависимостей и
 * запуска контейнера. Две реплики в это окно видят одно и то же число и обе разрешают старт.
 *
 * Бронь закрывает окно: она появляется в PostgreSQL до старта, считается вместе с живыми
 * preview и снимается после записи состояния (или ошибки). Падение процесса не оставляет
 * вечную бронь — у неё есть TTL.
 */

export type LivePreviewRef = { projectId: string; userId: string; lastUsedAt: number; node?: string };
export type ActiveReservationRef = { projectId: string; userId: string; node?: string };

export function previewReservationTtlMs(): number {
  const raw = process.env.PREVIEW_RESERVATION_TTL_MS?.trim();
  if (!raw) return 15 * 60_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 60_000 ? Math.floor(parsed) : 15 * 60_000;
}

export type ReservationDecision =
  | { ok: true; stopProjectIds: string[] }
  | { ok: false; reason: string };

/**
 * Чистое решение по снимку состояния. SQL-бэкенд собирает снимок под коротким advisory-локом
 * и вызывает эту функцию, поэтому правило проверяется unit-тестами без PostgreSQL.
 */
export function decidePreviewReservation(input: {
  projectId: string;
  userId: string;
  /** Узел, для которого считается потолок контейнеров. */
  node?: string;
  perUser: number;
  hostLimit: number;
  live: LivePreviewRef[];
  reservations: ActiveReservationRef[];
}): ReservationDecision {
  const ownReservation = input.reservations.some(
    reservation => reservation.projectId !== input.projectId && reservation.userId === input.userId,
  );
  if (input.perUser > 0 && input.userId && ownReservation) {
    // Второй запуск того же аккаунта не должен обгонять первый: пока контейнер не появился в
    // реестре, остановить «старый» нельзя — его ещё нет. Клиент повторит запрос.
    return {
      ok: false,
      reason: "Предпросмотр этого аккаунта уже запускается — подождите несколько секунд и повторите",
    };
  }

  const own = input.live
    .filter(preview => preview.projectId !== input.projectId && input.userId && preview.userId === input.userId)
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
  const stopProjectIds =
    input.perUser > 0 && own.length >= input.perUser
      ? own.slice(0, own.length - input.perUser + 1).map(preview => preview.projectId)
      : [];

  // Останавливаемые preview освободят слот до старта нового, поэтому в проверке потолка хоста
  // они не считаются. Если остановка не удастся, новый контейнер просто не запустится.
  const stopping = new Set(stopProjectIds);
  // Потолок хоста — про память одной машины. Preview и брони другой реплики живут в общем
  // реестре, но места на этом хосте не занимают. Строку без узла считаем своей: лучше
  // перестраховаться, чем разрешить лишний контейнер на неизвестной реплике.
  const onThisNode = (node: string | undefined) => !input.node || !node || node === input.node;
  const hostLive = input.live.filter(
    preview =>
      preview.projectId !== input.projectId &&
      !stopping.has(preview.projectId) &&
      onThisNode(preview.node),
  );
  const hostReserved = input.reservations.filter(
    reservation => reservation.projectId !== input.projectId && onThisNode(reservation.node),
  );
  if (input.hostLimit > 0 && hostLive.length + hostReserved.length >= input.hostLimit) {
    return {
      ok: false,
      reason:
        "На этом хосте одновременно работают " + input.hostLimit + " серверных предпросмотров (PREVIEW_MAX_CONTAINERS): " +
        "остановите предпросмотр другого проекта или поднимите лимит. Готовые статические проекты этот лимит не занимают.",
    };
  }

  return { ok: true, stopProjectIds };
}

export type PreviewReservation = {
  release: () => Promise<void>;
};

export type PreviewReservationResult =
  | { kind: "disabled" }
  | { kind: "acquired"; stopProjectIds: string[]; reservation: PreviewReservation }
  | { kind: "busy"; reason: string };

type ReserveInput = {
  projectId: string;
  userId: string;
  node: string;
  perUser: number;
  hostLimit: number;
};

type BackendReserveResult =
  | { kind: "acquired"; reservationId: string; stopProjectIds: string[] }
  | { kind: "busy"; reason: string };

export type PreviewReservationInfo = {
  projectId: string;
  ownerUserId: string;
  node: string;
  createdAt: number;
  expiresAt: number;
};

export type PreviewReservationBackend = {
  enabled: () => boolean;
  reserve: (input: ReserveInput) => Promise<BackendReserveResult>;
  release: (input: { projectId: string; reservationId: string }) => Promise<void>;
  /** Снять бронь, потерявшую владельца: контейнер уже принят из Docker или его остановили. */
  clear?: (projectId: string) => Promise<void>;
  /** Активная бронь проекта — для карточки проекта во внешней админке. */
  get?: (projectId: string, now: number) => Promise<PreviewReservationInfo | null>;
};

type PreviewRow = { project_id: string; owner_user_id: string | null; node: string | null; last_used_at: number | string };
type ReservationRow = {
  project_id: string;
  owner_user_id: string | null;
  node: string | null;
  created_at: number | string;
  expires_at: number | string;
};

function integer(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

const postgresBackend: PreviewReservationBackend = {
  enabled: () => isYdbEnabled(),
  async reserve(input) {
    await initializeStorage();
    const previews = ydbQuery().identifier(getTable("previews"));
    const reservationTable = ydbQuery().identifier(getTable("preview_reservations"));
    const now = Date.now();
    const reservationId = randomUUID();
    let result: BackendReserveResult | null = null;

    await ydbQuery().transaction({}, async tx => {
      // Один короткий лок на все брони: он сериализует только проверку и вставку, а не
      // многоминутный запуск контейнера. Без него два разных аккаунта могут одновременно
      // увидеть последний свободный слот хоста.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended('webnestdev:preview-reservation', 0))`;
      await tx`DELETE FROM ${reservationTable} WHERE expires_at <= ${now}`;

      const [liveRows] = await tx<PreviewRow[]>`
        SELECT project_id, owner_user_id, node, last_used_at
          FROM ${previews}
         WHERE mode IN ('container', 'hybrid') AND expires_at > ${now}
      `;
      const [reservedRows] = await tx<Array<{ project_id: string; owner_user_id: string | null; node: string | null }>>`
        SELECT project_id, owner_user_id, node
          FROM ${reservationTable}
         WHERE expires_at > ${now}
      `;

      if (reservedRows.some(row => row.project_id === input.projectId)) {
        result = {
          kind: "busy",
          reason: "Этот предпросмотр уже запускается — подождите завершения старта",
        };
        return;
      }

      const decision = decidePreviewReservation({
        projectId: input.projectId,
        userId: input.userId,
        node: input.node,
        perUser: input.perUser,
        hostLimit: input.hostLimit,
        live: liveRows.map(row => ({
          projectId: row.project_id,
          userId: row.owner_user_id ?? "",
          node: row.node ?? "",
          lastUsedAt: integer(row.last_used_at),
        })),
        reservations: reservedRows.map(row => ({
          projectId: row.project_id,
          userId: row.owner_user_id ?? "",
          node: row.node ?? "",
        })),
      });
      if (!decision.ok) {
        result = { kind: "busy", reason: decision.reason };
        return;
      }

      await tx`
        INSERT INTO ${reservationTable}
          (project_id, reservation_id, owner_user_id, node, created_at, expires_at)
        VALUES
          (${input.projectId}, ${reservationId}, ${input.userId}, ${input.node}, ${now}, ${now + previewReservationTtlMs()})
      `;
      result = { kind: "acquired", reservationId, stopProjectIds: decision.stopProjectIds };
    });

    return result ?? { kind: "busy", reason: "Не удалось забронировать запуск предпросмотра" };
  },
  async release(input) {
    await initializeStorage();
    const table = ydbQuery().identifier(getTable("preview_reservations"));
    await ydbQuery()`
      DELETE FROM ${table}
       WHERE project_id = ${input.projectId} AND reservation_id = ${input.reservationId}
    `;
  },
  async clear(projectId) {
    await initializeStorage();
    const table = ydbQuery().identifier(getTable("preview_reservations"));
    await ydbQuery()`DELETE FROM ${table} WHERE project_id = ${projectId}`;
  },
  async get(projectId, now) {
    await initializeStorage();
    const table = ydbQuery().identifier(getTable("preview_reservations"));
    const [rows] = await ydbQuery()<ReservationRow[]>`
      SELECT project_id, owner_user_id, node, created_at, expires_at
        FROM ${table}
       WHERE project_id = ${projectId} AND expires_at > ${now}
       LIMIT 1`;
    const row = rows[0];
    if (!row) return null;
    return {
      projectId: row.project_id,
      ownerUserId: row.owner_user_id ?? "",
      node: row.node ?? "",
      createdAt: integer(row.created_at),
      expiresAt: integer(row.expires_at),
    };
  },
};

let backend: PreviewReservationBackend = postgresBackend;

/** Подмена для unit-тестов: настоящий PostgreSQL в них не поднимается. */
export function setPreviewReservationBackendForTests(next: PreviewReservationBackend | null): void {
  backend = next ?? postgresBackend;
}

/**
 * Забронировать запуск. `disabled` — не ошибка: в JSON-режиме и при недоступной базе остаётся
 * прежняя локальная проверка, иначе панель перестала бы запускать preview во время сбоя БД.
 */
export async function reservePreviewStart(input: {
  projectId: string;
  userId: string;
  node?: string;
  perUser: number;
  hostLimit: number;
}): Promise<PreviewReservationResult> {
  if (!backend.enabled()) return { kind: "disabled" };
  try {
    const reserved = await backend.reserve({
      projectId: input.projectId,
      userId: input.userId,
      node: input.node || nodeId(),
      perUser: input.perUser,
      hostLimit: input.hostLimit,
    });
    if (reserved.kind === "busy") return reserved;
    const reservationId = reserved.reservationId;
    let released = false;
    return {
      kind: "acquired",
      stopProjectIds: reserved.stopProjectIds,
      reservation: {
        release: async () => {
          if (released) return;
          released = true;
          try {
            // DELETE по project_id + reservation_id идемпотентен и защищает от чужого release.
            await backend.release({ projectId: input.projectId, reservationId });
          } catch (error) {
            console.warn(
              "[preview] не удалось снять бронь запуска " + input.projectId + ": " + describeError(error),
            );
          }
        },
      },
    };
  } catch (error) {
    console.warn(
      "[preview] бронь запуска недоступна, остаюсь на локальной проверке: " + describeError(error),
    );
    return { kind: "disabled" };
  }
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Снять бронь проекта, когда старт уже не может быть активным: контейнер принят из Docker
 * или пользователь остановил предпросмотр. Без этого оставшаяся после прерванного запуска
 * строка продолжала бы отвечать «уже запускается» до истечения TTL.
 *
 * Возвращает `false`, только если база не приняла удаление: админке важно отличить «брони уже
 * нет» от «снять не удалось», иначе ручной разбор зависшего preview выглядел бы успешным.
 */
export async function clearPreviewReservation(projectId: string): Promise<boolean> {
  if (!backend.enabled()) return true;
  try {
    await backend.clear?.(projectId);
    return true;
  } catch (error) {
    console.warn("[preview] не удалось снять бронь запуска " + projectId + ": " + describeError(error));
    return false;
  }
}

/**
 * Активная бронь проекта. Ошибку базы не глотаем: админка должна показать «состояние
 * неизвестно», а не делать вид, что брони нет.
 */
export async function findPreviewReservation(projectId: string): Promise<PreviewReservationInfo | null> {
  if (!backend.enabled()) return null;
  return (await backend.get?.(projectId, Date.now())) ?? null;
}
