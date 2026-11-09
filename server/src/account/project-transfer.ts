import { isRunActiveAnywhere } from "../agent/run-activity.js";
import { getUser } from "../auth/auth-store.js";
import { listProjects, transferProjectOwners } from "../project-store.js";
import { transferSiteOwners } from "../hosting/site-store.js";
import { transferProjectStorage } from "./storage-quota.js";
import { transferArchiveOwners } from "../storage/project-archive-state.js";
import { getTable, initializeStorage, isYdbEnabled, ydbQuery } from "../storage/ydb.js";
import type { YdbQueryTag } from "../storage/pg.js";

/**
 * Перенос проектов между аккаунтами — аварийное действие администратора.
 *
 * Типичный случай: человек потерял доступ к старому входу (например, телефонному аккаунту
 * без почты для восстановления), а проекты нужны на новом. Удалять и создавать заново нельзя:
 * в проекте остались диалоги, секреты, репозиторий и опубликованный сайт.
 *
 * Поэтому меняется только владелец. Всё, что привязано к `projectId` — песочница, диалоги,
 * провайдеры, секреты, — переезжает само собой, потому что путь и ключ не зависят от userId.
 * Владельца приходится явно менять у записей, где `user_id` продублирован: проект, сайт,
 * релизы, размер проекта, отметка холодного яруса и счётчик проектов.
 *
 * Что не переносится намеренно: тариф, платежи, купленные кредиты, расход по моделям и
 * подключения аккаунта (GitHub, GitLab, облака, домены). Это свойства человека, а не проекта;
 * тихая передача подписки или чужого GitHub-доступа была бы подарком за счёт платформы.
 *
 * В PostgreSQL всё меняется одной транзакцией: админка не должна увидеть проект у нового
 * владельца, пока его сайт ещё принадлежит старому. JSON-режим (разработка и тесты) делает
 * те же шаги последовательно — там одна реплика и нет конкурентных читателей между шагами.
 */

export type ProjectTransferInput = {
  fromUserId: string;
  toUserId: string;
  /** Пусто — перенести все проекты источника. Иначе только перечисленные. */
  projectIds?: string[];
};

export type ProjectTransferResult = {
  from: { id: string; email: string };
  to: { id: string; email: string };
  transferred: Array<{ id: string; name: string }>;
  counts: { from: number; to: number };
  /** Сколько связанных записей реально сменило владельца; идёт в журнал, не в ответ. */
  moved: { projects: number; sites: number; releases: number; sizes: number; archives: number };
};

export type ProjectTransferErrorCode =
  | "SAME_USER"
  | "USER_NOT_FOUND"
  | "PROJECT_NOT_FOUND"
  | "NO_PROJECTS"
  | "PROJECT_BUSY"
  | "PROJECT_CHANGED";

export class ProjectTransferError extends Error {
  constructor(
    readonly code: ProjectTransferErrorCode,
    message: string,
    readonly statusCode: number,
    /** Проекты, из-за которых действие отменено: админка подсветит их в списке. */
    readonly projects: Array<{ id: string; name: string }> = [],
  ) {
    super(message);
    this.name = "ProjectTransferError";
  }
}

/** Счётчики проектов пересчитываются из таблицы, а не инкрементом: так они не «уплывают». */
async function refreshProjectCounters(tx: YdbQueryTag, fromUserId: string, toUserId: string) {
  const projects = tx.identifier(getTable("projects"));
  const counters = tx.identifier(getTable("project_counters"));
  await tx`
    INSERT INTO ${counters} (user_id, project_count)
    SELECT user_id, COUNT(*)
      FROM ${projects}
     WHERE user_id IN (${fromUserId}, ${toUserId})
     GROUP BY user_id
    ON CONFLICT (user_id) DO UPDATE SET project_count = EXCLUDED.project_count
  `;
  await tx`
    DELETE FROM ${counters}
     WHERE user_id = ${fromUserId}
       AND NOT EXISTS (SELECT 1 FROM ${projects} WHERE user_id = ${fromUserId})
  `;
}

export async function transferProjects(input: ProjectTransferInput): Promise<ProjectTransferResult> {
  const { fromUserId, toUserId } = input;
  if (fromUserId === toUserId) {
    throw new ProjectTransferError("SAME_USER", "Источник и получатель совпадают", 400);
  }

  const [source, target] = await Promise.all([getUser(fromUserId), getUser(toUserId)]);
  if (!source) {
    throw new ProjectTransferError("USER_NOT_FOUND", "Аккаунт-источник не найден", 404);
  }
  if (!target) {
    throw new ProjectTransferError("USER_NOT_FOUND", "Аккаунт-получатель не найден", 404);
  }

  // Список читается до транзакции: имена нужны в ответе и в журнале, а `projectIds` —
  // для выбора подмножества. Владение повторно проверяется в UPDATE по `user_id`.
  const sourceProjects = await listProjects(fromUserId);
  const byId = new Map(sourceProjects.map(project => [project.id, project]));
  let selected = sourceProjects;
  if (input.projectIds) {
    const unique = [...new Set(input.projectIds)];
    const missing = unique.filter(id => !byId.has(id));
    if (missing.length) {
      throw new ProjectTransferError(
        "PROJECT_NOT_FOUND",
        "У аккаунта-источника нет проектов: " + missing.slice(0, 10).join(", ") +
          (missing.length > 10 ? " и ещё " + (missing.length - 10) : ""),
        404,
        missing.map(id => ({ id, name: "" })),
      );
    }
    selected = unique.map(id => byId.get(id)!);
  }

  if (!selected.length) {
    throw new ProjectTransferError("NO_PROJECTS", "У аккаунта-источника нет проектов для переноса", 409);
  }

  // Работающий агент пишет в проект от имени старого владельца. Перенос посреди запуска
  // оставил бы часть файлов и сообщений за прежним аккаунтом, поэтому сначала ждём завершения.
  const busy = [];
  for (const project of selected) {
    if (await isRunActiveAnywhere(project.id)) busy.push(project);
  }
  if (busy.length) {
    throw new ProjectTransferError(
      "PROJECT_BUSY",
      "Агент ещё работает над " +
        (busy.length === 1 ? "проектом «" + busy[0].name + "»" : busy.length + " проектами") +
        " — дождитесь завершения и повторите",
      409,
      busy.map(project => ({ id: project.id, name: project.name })),
    );
  }

  const ids = selected.map(project => project.id);
  const moved = { projects: 0, sites: 0, releases: 0, sizes: 0, archives: 0 };

  if (isYdbEnabled()) {
    await initializeStorage();
    await ydbQuery().transaction({ idempotent: true }, async tx => {
      moved.projects = await transferProjectOwners(ids, fromUserId, toUserId, tx);
      if (moved.projects !== ids.length) {
        // Проект удалили между чтением списка и UPDATE. Откатываем всю передачу: частичный
        // перенос оставил бы часть выбранных проектов у старого владельца без объяснения.
        throw new ProjectTransferError(
          "PROJECT_CHANGED",
          "Список проектов изменился во время переноса — обновите карточку и повторите",
          409,
        );
      }
      const hosting = await transferSiteOwners(ids, fromUserId, toUserId, tx);
      moved.sites = hosting.sites;
      moved.releases = hosting.releases;
      moved.sizes = await transferProjectStorage(ids, fromUserId, toUserId, tx);
      moved.archives = await transferArchiveOwners(ids, fromUserId, toUserId, tx);
      await refreshProjectCounters(tx, fromUserId, toUserId);
    });
  } else {
    moved.projects = await transferProjectOwners(ids, fromUserId, toUserId);
    if (moved.projects !== ids.length) {
      throw new ProjectTransferError(
        "PROJECT_CHANGED",
        "Список проектов изменился во время переноса — обновите карточку и повторите",
        409,
      );
    }
    const hosting = await transferSiteOwners(ids, fromUserId, toUserId);
    moved.sites = hosting.sites;
    moved.releases = hosting.releases;
    moved.sizes = await transferProjectStorage(ids, fromUserId, toUserId);
    moved.archives = await transferArchiveOwners(ids, fromUserId, toUserId);
  }

  const [fromProjects, toProjects] = await Promise.all([listProjects(fromUserId), listProjects(toUserId)]);
  return {
    from: { id: source.id, email: source.email },
    to: { id: target.id, email: target.email },
    transferred: selected.map(project => ({ id: project.id, name: project.name })),
    counts: { from: fromProjects.length, to: toProjects.length },
    moved,
  };
}
