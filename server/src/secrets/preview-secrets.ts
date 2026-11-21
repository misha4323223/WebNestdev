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
      // Docker создаёт отсутствующий source bind-mount каталогом, и такой каталог может
      // остаться на месте файла. Пока он наш, убираем его сами; root-owned уберёт таймер
      // владельцев, а здесь останется понятная причина вместо EISDIR.
      const targetInfo = await lstat(target).catch(() => null);
      if (targetInfo && !targetInfo.isFile()) {
        try {
          await rm(target, { recursive: true, force: true });
        } catch (error) {
          throw new Error(
            "Временный файл секретов " + relative + " занят каталогом, который не удалось убрать: " +
              target + " (" + errorMessage(error) + ")",
          );
        }
      }
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
  await clearRuntimeDir(runtimeProjectDir(projectId), "временные секреты " + projectId);
}

/** Убирает всё, что осталось после падения сервера: в этих файлах лежит открытый текст. */
export async function clearAllPreviewSecrets() {
  await clearRuntimeDir(path.join(sandboxRootDir(), RUNTIME_DIR), "временные секреты всех проектов");
}

/**
 * Каталог `.secret-runtime` может оказаться root:root: Docker создаёт отсутствующий source
 * bind-mount от root, а API работает от uid 1000. Удаление тогда падает с EACCES/EPERM, и
 * раньше это валило установку зависимостей, из-за чего watcher функций повторял hot-reload
 * каждые пару секунд. Владельца исправляет host-таймер `webnestdev-sandbox-ownership`; здесь
 * ошибку логируем и не превращаем в отказ всего запуска.
 */
async function clearRuntimeDir(dir: string, what: string) {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM" || code === "EBUSY") {
      console.warn("[preview] " + what + " не удалены (" + code + "): " + dir + " — починит таймер владельцев");
      return;
    }
    throw error;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
