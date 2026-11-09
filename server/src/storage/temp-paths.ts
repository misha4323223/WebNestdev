import path from "node:path";
import { nodeId } from "../nodes/identity.js";

/**
 * Временные файлы архивации и распаковки принадлежат процессу, который их создал. Пока API
 * один, это было неважно; с несколькими репликами на общем диске стартовая уборка одной
 * реплики не должна удалять свежие файлы другой.
 *
 * Поэтому имя узла входит в путь (`tmp/<node>`) и в имя сторожащего каталога
 * (`.restore-<node>-…`). Старые файлы без узла остаются как есть: удалить их «на всякий случай»
 * значило бы вернуть ту же гонку, от которой мы уходим.
 */
export function nodeFileNamespace(id: string = nodeId()): string {
  const cleaned = id.trim().replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^[.-]+/, "").slice(0, 60);
  return cleaned || "local";
}

/** Каталог временных tar-архивов этой реплики. */
export function storageTempDir(env: NodeJS.ProcessEnv = process.env): string {
  const dataDir = env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
  return path.join(dataDir, "tmp", nodeFileNamespace(env.WEBNESTDEV_NODE_ID ?? "local"));
}

/** Префикс каталога, в который распаковывается архив до атомарной замены рабочей папки. */
export function restoreStagingPrefix(id: string = nodeId()): string {
  return ".restore-" + nodeFileNamespace(id) + "-";
}

/** Принадлежит ли имя каталога распаковки этой реплике. */
export function isRestoreStagingName(name: string, id: string = nodeId()): boolean {
  return name.startsWith(restoreStagingPrefix(id));
}
