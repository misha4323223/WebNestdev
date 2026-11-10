import { chown, lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { SANDBOX_GID, SANDBOX_UID } from "./permissions.js";

/**
 * Рекурсивная нормализация владельца дерева проекта.
 *
 * Зачем отдельно от `openTreeForSandbox`: тот обходит проект перед каждой командой контейнера и
 * намеренно не заходит в `node_modules` — слишком дорого для Gluster. Если же внутри пакетов
 * остались каталоги `root:root` (старые сборки от root, распакованный архив, восстановленный
 * дамп), `npm install` падает с `EACCES ... unlink .../node_modules/...`: удалять файл можно
 * только при праве записи на его каталог. Такой ремонт — редкая операция, её запускает либо
 * host-таймер `webnestdev-sandbox-ownership`, либо админ вручную.
 *
 * Символические ссылки не трогаем: `chown` по умолчанию идёт по ссылке и сменил бы владельца
 * цели за пределами проекта. Ошибки отдельных файлов не прерывают обход — они считаются и
 * возвращаются, чтобы админ видел, что ремонт неполный.
 */
export type OwnershipRepair = {
  /** Каталога проекта нет на общем storage — чинить нечего. */
  missing?: boolean;
  entries: number;
  repaired: number;
  failed: number;
  /** Обход упёрся в потолок и не покрыл всё дерево. */
  truncated: boolean;
};

const DEFAULT_LIMIT = 200_000;

export async function repairProjectOwnership(
  root: string,
  options: { uid?: number; gid?: number; limit?: number } = {},
): Promise<OwnershipRepair> {
  const uid = options.uid ?? SANDBOX_UID;
  const gid = options.gid ?? SANDBOX_GID;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const result: OwnershipRepair = { entries: 0, repaired: 0, failed: 0, truncated: false };

  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) return { ...result, missing: true };

  const stack = [path.resolve(root)];
  while (stack.length) {
    if (result.entries >= limit) {
      result.truncated = true;
      break;
    }
    const current = stack.pop() as string;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => null);
    if (!entries) {
      result.failed += 1;
      continue;
    }
    for (const entry of entries) {
      if (result.entries >= limit) {
        result.truncated = true;
        break;
      }
      result.entries += 1;
      const full = path.join(current, entry.name);
      const entryInfo = await lstat(full).catch(() => null);
      if (!entryInfo || entryInfo.isSymbolicLink()) continue;
      if (entryInfo.uid !== uid || entryInfo.gid !== gid) {
        try {
          await chown(full, uid, gid);
          result.repaired += 1;
        } catch {
          result.failed += 1;
        }
      }
      if (entryInfo.isDirectory()) stack.push(full);
    }
  }
  return result;
}
