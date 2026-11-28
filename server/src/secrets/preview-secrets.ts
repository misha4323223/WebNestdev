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

/**
 * Сколько запусков одновременно пользуются временными файлами проекта.
 *
 * Файл монтируется в контейнер по пути на диске, а запусков для одного проекта бывает
 * несколько сразу: установка зависимостей, сборка и старт предпросмотра ждут место в общем
 * лимите контейнеров и идут параллельно. Первый завершившийся запуск убирал каталог целиком, и
 * следующий `docker run` падал с «источник монтирования не существует:
 * …/.secret-runtime/<проект>/.env.local» — предпросмотр не стартовал, функции не собирались.
 * Каталог удаляет только последний пользователь.
 */
const activeUses = new Map<string, number>();

function acquireRuntimeDir(dir: string) {
  activeUses.set(dir, (activeUses.get(dir) ?? 0) + 1);
}

/** `true` — это был последний пользователь, каталог можно убирать. */
function releaseRuntimeDir(dir: string): boolean {
  const left = (activeUses.get(dir) ?? 1) - 1;
  if (left > 0) {
    activeUses.set(dir, left);
    return false;
  }
  activeUses.delete(dir);
  return true;
}

function runtimeDirInUse(dir: string) {
  return (activeUses.get(dir) ?? 0) > 0;
}

export async function previewSecretMounts(config: SandboxConfig): Promise<PreviewSecretMounts> {
  const files = await loadProjectSecretFiles(config.projectId, config.root);
  const entries = Object.entries(files).filter(([, variables]) => Object.keys(variables).length);
  const dir = runtimeProjectDir(config.projectId);
  if (!entries.length) {
    // Предыдущий запуск мог оставить файл, а секреты с тех пор удалили: он не должен пережить
    // остановку предпросмотра. Пока файлы нужны другому запуску, каталог не трогаем.
    if (!runtimeDirInUse(dir)) await clearPreviewSecrets(config.projectId);
    return { mounts: [], cleanup: async () => {} };
  }

  await mkdir(dir, { recursive: true });
  await openDirForSandbox(dir);
  acquireRuntimeDir(dir);
  let released = false;
  /** Освободить каталог; удаляет его только последний запуск. */
  const release = async () => {
    if (released) return;
    released = true;
    if (releaseRuntimeDir(dir)) await clearPreviewSecrets(config.projectId);
  };

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
    // Неудачный запуск не должен оставлять открытый текст в `.secret-runtime` — если файлы не
    // нужны другому запуску (release удаляет каталог только последним).
    await release();
    throw error;
  }

  return { mounts, cleanup: release };
}

/** Убирает временные файлы одного проекта: предпросмотр остановлен. */
export async function clearPreviewSecrets(projectId: string) {
  const dir = runtimeProjectDir(projectId);
  // Идущий запуск держит файл смонтированным: удалит его собственный cleanup, когда закончит.
  if (runtimeDirInUse(dir)) return;
  await clearRuntimeDir(dir, "временные секреты " + projectId);
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
