import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { hostPathFor, sandboxRootDir } from "../sandbox/config.js";
import { openDirForSandbox, openFileForSandbox } from "../sandbox/permissions.js";
import type { SandboxConfig } from "../sandbox/sandbox-types.js";
import { encodeEnvValue } from "./env-value.js";
import { isProjectSecretFile, loadProjectSecretFiles } from "./project-secrets.js";

/**
 * Временные env-файлы для предпросмотра.
 *
 * Секреты лежат зашифрованными вне проекта. Контейнеру предпросмотра они нужны как обычные
 * файлы `.env.local` / `.env.production`: приложение читает их своим загрузчиком (Vite,
 * Next.js, dotenv). Поэтому на время предпросмотра из хранилища собирается файл в соседнем с
 * проектом каталоге `.secret-runtime/<projectId>/` и монтируется read-only поверх
 * `/workspace/<file>`.
 *
 * Каталог не входит в рабочую область: агент, файловый API, git и архив проекта его не видят.
 * Файлы удаляются при остановке предпросмотра и на старте сервера (после падения).
 */
const RUNTIME_DIR = ".secret-runtime";

export type PreviewSecretMounts = {
  mounts: string[];
  cleanup: () => Promise<void>;
};

function runtimeProjectDir(projectId: string) {
  return path.join(sandboxRootDir(), RUNTIME_DIR, projectId.replace(/[^A-Za-z0-9._-]/g, "_"));
}

export async function previewSecretMounts(config: SandboxConfig): Promise<PreviewSecretMounts> {
  const files = await loadProjectSecretFiles(config.projectId, config.root);
  const entries = Object.entries(files).filter(([, variables]) => Object.keys(variables).length);
  if (!entries.length) {
    // Предыдущий запуск мог оставить файл, а секреты с тех пор удалили: он не должен пережить
    // остановку предпросмотра.
    await clearPreviewSecrets(config.projectId);
    return { mounts: [], cleanup: async () => {} };
  }

  const dir = runtimeProjectDir(config.projectId);
  await mkdir(dir, { recursive: true });
  await openDirForSandbox(dir);

  const mounts: string[] = [];
  try {
    for (const [relative, variables] of entries) {
      // Ключи пришли из рабочей области при миграции; проверка не даёт смонтировать что-то
      // за пределы `/workspace`, даже если хранилище когда-нибудь будет записано иначе.
      if (
        !isProjectSecretFile(path.posix.basename(relative)) ||
        relative.startsWith("/") ||
        relative.split("/").includes("..") ||
        relative.includes(":") ||
        relative.includes(",")
      ) {
        throw new Error("Невозможно смонтировать секретный файл " + relative + " в предпросмотр");
      }

      // Docker монтирует файл поверх цели, которая уже существует. Без этой пустой заготовки
      // на месте удалённого `.env.local` он создал бы каталог и запуск упал бы с «not a
      // directory». Содержимого в заготовке нет, поэтому рабочая область по-прежнему не хранит
      // ни одного значения.
      const projectTarget = path.join(config.root, relative);
      await mkdir(path.dirname(projectTarget), { recursive: true });
      const existing = await lstat(projectTarget).catch(() => null);
      if (existing) {
        if (!existing.isFile() || existing.size > 0) {
          throw new Error(
            "Файл " + relative + " снова появился в проекте с содержимым — запуск остановлен, чтобы значения не остались в рабочей области",
          );
        }
      } else {
        await writeFile(projectTarget, "", { encoding: "utf8", mode: 0o600 });
      }
      await openFileForSandbox(projectTarget);

      const target = path.join(dir, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await openDirForSandbox(path.dirname(target));
      const content = Object.entries(variables)
        .map(([name, value]) => name + "=" + encodeEnvValue(value))
        .join("\n") + "\n";
      await writeFile(target, content, { encoding: "utf8", mode: 0o600 });
      // Владелец-контейнер (uid 1000) и 600: читает только предпросмотр.
      await openFileForSandbox(target);
      mounts.push("-v", hostPathFor(target) + ":/workspace/" + relative + ":ro");
    }
  } catch (error) {
    // Неудачный запуск не должен оставлять открытый текст в `.secret-runtime`.
    await clearPreviewSecrets(config.projectId);
    throw error;
  }

  return {
    mounts,
    cleanup: () => clearPreviewSecrets(config.projectId),
  };
}

/** Убирает временные файлы одного проекта: предпросмотр остановлен. */
export async function clearPreviewSecrets(projectId: string) {
  await rm(runtimeProjectDir(projectId), { recursive: true, force: true });
}

/** Убирает всё, что осталось после падения сервера: в этих файлах лежит открытый текст. */
export async function clearAllPreviewSecrets() {
  await rm(path.join(sandboxRootDir(), RUNTIME_DIR), { recursive: true, force: true });
}
