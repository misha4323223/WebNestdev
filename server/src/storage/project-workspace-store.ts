import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getTable, initializeStorage, isYdbEnabled, ydbQuery } from "./pg.js";
import { getProject, type Project } from "../project-store.js";

/**
 * Метаданные локального workspace: последний snapshot и поколение проекта.
 *
 * `workspace_epoch` — fencing. После переноса на другую ноду старый процесс не должен иметь
 * возможности записать файлы в уже перемещённый проект; миграция увеличивает epoch, а операции,
 * которые её проверяют, отказываются работать со старым значением.
 */

export type ProjectWorkspaceMeta = {
  id: string;
  userId: string;
  node: string;
  workspaceMode: "shared" | "local";
  workspaceEpoch: number;
  snapshotKey: string;
  snapshotAt: string | null;
  workspaceBytes: number;
};

function projectFile(projectId: string) {
  const dataDir = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
  return path.join(dataDir, "projects", projectId + ".json");
}

async function writeProjectFile(project: Project) {
  const file = projectFile(project.id);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(project, null, 2), { mode: 0o600 });
  try {
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function metaOf(project: Project): ProjectWorkspaceMeta {
  return {
    id: project.id,
    userId: project.userId,
    node: project.node?.trim() ?? "",
    workspaceMode: project.workspaceMode === "local" ? "local" : "shared",
    workspaceEpoch: Math.max(0, Math.trunc(project.workspaceEpoch ?? 0)),
    snapshotKey: project.snapshotKey ?? "",
    snapshotAt: project.snapshotAt ?? null,
    workspaceBytes: Math.max(0, Math.trunc(project.workspaceBytes ?? 0)),
  };
}

export async function getProjectWorkspaceMeta(projectId: string): Promise<ProjectWorkspaceMeta | null> {
  const project = await getProject(projectId);
  return project ? metaOf(project) : null;
}

/** Сохранить указатель на последний горячий snapshot; рабочая папка при этом не трогается. */
export async function saveProjectSnapshotMeta(
  projectId: string,
  snapshot: { key: string; at: string; bytes: number },
): Promise<void> {
  if (!isYdbEnabled()) {
    const project = await getProject(projectId);
    if (!project) throw new Error("Проект не найден");
    await writeProjectFile({ ...project, snapshotKey: snapshot.key, snapshotAt: snapshot.at, workspaceBytes: snapshot.bytes });
    return;
  }
  await initializeStorage();
  const table = ydbQuery().identifier(getTable("projects"));
  await ydbQuery()`
    UPDATE ${table}
       SET snapshot_key = ${snapshot.key},
           snapshot_at = ${snapshot.at},
           workspace_bytes = ${snapshot.bytes},
           updated_at = ${new Date().toISOString()}
     WHERE id = ${projectId}`;
}

export async function clearProjectSnapshotMeta(projectId: string): Promise<void> {
  if (!isYdbEnabled()) {
    const project = await getProject(projectId);
    if (!project) return;
    await writeProjectFile({ ...project, snapshotKey: "", snapshotAt: undefined });
    return;
  }
  await initializeStorage();
  const table = ydbQuery().identifier(getTable("projects"));
  await ydbQuery()`
    UPDATE ${table}
       SET snapshot_key = '',
           snapshot_at = NULL
     WHERE id = ${projectId}`;
}

/**
 * Сменить владельца и увеличить epoch одной операцией. `expectedEpoch` не даёт двум миграциям
 * одновременно перевести проект на разные ноды.
 */
export async function moveProjectWorkspace(
  projectId: string,
  node: string,
  expectedEpoch?: number,
): Promise<ProjectWorkspaceMeta> {
  const now = new Date().toISOString();
  if (!isYdbEnabled()) {
    const project = await getProject(projectId);
    if (!project) throw new Error("Проект не найден");
    const current = Math.max(0, Math.trunc(project.workspaceEpoch ?? 0));
    if (expectedEpoch !== undefined && current !== expectedEpoch) {
      throw new Error("Поколение проекта изменилось: миграция отменена");
    }
    const next = current + 1;
    await writeProjectFile({ ...project, node, workspaceEpoch: next, updatedAt: now });
    const updated = await getProject(projectId);
    if (!updated) throw new Error("Проект исчез во время миграции");
    return metaOf(updated);
  }
  await initializeStorage();
  const table = ydbQuery().identifier(getTable("projects"));
  const [rows] = expectedEpoch === undefined
    ? await ydbQuery()<Array<{ workspace_epoch: number | string }>>`
        UPDATE ${table}
           SET node = ${node},
               workspace_epoch = workspace_epoch + 1,
               updated_at = ${now}
         WHERE id = ${projectId}
         RETURNING workspace_epoch`
    : await ydbQuery()<Array<{ workspace_epoch: number | string }>>`
        UPDATE ${table}
           SET node = ${node},
               workspace_epoch = workspace_epoch + 1,
               updated_at = ${now}
         WHERE id = ${projectId} AND workspace_epoch = ${expectedEpoch}
         RETURNING workspace_epoch`;
  if (!rows[0]) throw new Error("Проект не найден или поколение изменилось: миграция отменена");
  const updated = await getProject(projectId);
  if (!updated) throw new Error("Проект исчез во время миграции");
  return metaOf(updated);
}
