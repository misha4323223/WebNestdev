import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { hostPathFor, sandboxRootDir } from "../sandbox/config.js";
import { openDirForSandbox, openFileForSandbox } from "../sandbox/permissions.js";
import type { SandboxConfig } from "../sandbox/sandbox-types.js";
import { loadProjectSecretFiles } from "../secrets/project-secrets.js";
import { encodeEnvValue } from "../secrets/env-value.js";
import { isPublicEnvName } from "./security.js";

export type PublicEnvMount = {
  mounts: string[];
  cleanup: () => Promise<void>;
  /** Имена переменных — для лога без значений. */
  names: string[];
};

function runtimeDir(projectId: string) {
  return path.join(
    sandboxRootDir(),
    ".hosting-public",
    projectId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120),
  );
}

/**
 * Публичные переменные для build.
 *
 * Приватные секреты проекта в контейнер не попадают вообще: они не монтируются, а исходные
 * `.env*` маскируются пустыми read-only файлами. Сгенерированный `.env.local` монтируется
 * последним и содержит только имена с публичными префиксами. Значение с приватным словом в
 * имени (`VITE_SECRET_KEY`) тоже не проходит — иначе «публичный префикс» стал бы способом
 * случайно опубликовать ключ.
 */
export async function publicEnvMounts(config: SandboxConfig): Promise<PublicEnvMount> {
  const files = await loadProjectSecretFiles(config.projectId, config.root);
  const values: Record<string, string> = {};
  for (const variables of Object.values(files)) {
    for (const [name, value] of Object.entries(variables)) {
      if (!isPublicEnvName(name)) continue;
      values[name] = value;
    }
  }
  const names = Object.keys(values).sort();
  if (!names.length) return { mounts: [], cleanup: async () => undefined, names };

  const targetInProject = path.join(config.root, ".env.local");
  await mkdir(path.dirname(targetInProject), { recursive: true });
  const placeholder = await lstat(targetInProject).catch(() => null);
  let createdPlaceholder = false;
  if (!placeholder) {
    // Docker bind-mount файла требует существующий source; target создаётся контейнером.
    // Заглушка в проекте нужна только как безопасная точка монтирования и удаляется после
    // сборки, чтобы публикация не меняла дерево проекта.
    await writeFile(targetInProject, "", { mode: 0o600 });
    await openFileForSandbox(targetInProject);
    createdPlaceholder = true;
  } else if (!placeholder.isFile() || placeholder.isSymbolicLink()) {
    throw new Error("Нельзя смонтировать публичные env: .env.local не является обычным файлом");
  }

  const dir = runtimeDir(config.projectId);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await openDirForSandbox(dir);
    const file = path.join(dir, ".env.local");
    const content = names.map(name => name + "=" + encodeEnvValue(values[name] ?? "")).join("\n") + "\n";
    await writeFile(file, content, { encoding: "utf8", mode: 0o600 });
    await openFileForSandbox(file);
    return {
      mounts: ["-v", hostPathFor(file) + ":/workspace/.env.local:ro"],
      cleanup: async () => {
        await rm(dir, { recursive: true, force: true });
        if (createdPlaceholder) await rm(targetInProject, { force: true }).catch(() => undefined);
      },
      names,
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    if (createdPlaceholder) await rm(targetInProject, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Для тестов и диагностики: только имена, без значений. */
export function describePublicEnv(names: string[]) {
  return names.length ? "публичные env: " + names.join(", ") : "публичных env нет";
}
