import { lstat, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { parseEnvFileContent } from "../platform/platform-env.js";
import { isSecretEnvFile } from "../sandbox/permissions.js";
import { findSecretEnvFiles } from "../sandbox/secret-mask.js";
import {
  loadStoredSecretValues,
  saveStoredSecretValues,
  type SecretFiles,
} from "./secret-store.js";

/**
 * Секреты проекта — это переменные окружения самого приложения пользователя, а не ключи
 * платформы. Каноническое хранилище — зашифрованный payload вне рабочей области
 * (`secrets/secret-store.ts`). `.env.local` больше не пишется в проект: на время работы
 * предпросмотра он монтируется read-only из временного файла.
 *
 * Файлов может быть несколько (`.env`, `.env.local`, `.env.production`): при первом чтении
 * существующие файлы переносятся в хранилище и удаляются из проекта. Порядок и имена файлов
 * сохраняются, поэтому Vite, Next.js и dotenv читают ровно то же, что и раньше.
 */
export const PROJECT_SECRETS_FILE = ".env.local";
export const PROJECT_SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const MAX_PROJECT_SECRET_VALUE = 20_000;
const MAX_ENV_FILE_BYTES = 500_000;

export type ProjectSecret = {
  name: string;
  /** Форма значения, а не само значение: оно не должно уезжать в браузер. */
  preview: string;
  /** Файл, из которого пришла переменная; `.env.local` — файл панели по умолчанию. */
  file: string;
};

export function projectSecretPreview(value: string) {
  const text = value.trim();
  const lines = text.split("\n").length;
  if (lines > 1) return "скрыто · " + lines + " строк";
  if (!text) return "пусто";
  // Ни одного символа значения: даже префикс и суффикс токена — это часть ключа.
  return "скрыто";
}

/**
 * Имя файла секретов: всё, что `isSecretEnvFile` считает окружением, кроме шаблонов. Это шире
 * списка файлов, которые пишет панель, — при миграции нужно забрать из проекта и
 * `.env.production.local`, и любой другой вариант, который читает сборщик.
 */
export function isProjectSecretFile(file: string) {
  return file === path.posix.basename(file) && isSecretEnvFile(file);
}

function assertSecretFile(file: string) {
  if (!isProjectSecretFile(file)) {
    throw new Error("Файл секретов должен называться .env или .env.<окружение> (например, .env.local, .env.production, .env.production.local)");
  }
}

function assertVariable(name: string, value: string) {
  if (!PROJECT_SECRET_NAME.test(name)) {
    throw new Error("Имя переменной должно начинаться с латинской буквы или подчёркивания и содержать только латинские буквы, цифры и подчёркивания");
  }
  if (value.length > MAX_PROJECT_SECRET_VALUE) {
    throw new Error("Значение переменной длиннее 20 000 символов");
  }
}

function fileVariables(content: string): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const entry of parseEnvFileContent(content)) variables[entry.name] = entry.value;
  return variables;
}

/** Загрузки одного проекта объединены: первый запрос переносит файлы, остальные ждут его. */
const loads = new Map<string, Promise<SecretFiles>>();

async function loadFiles(projectId: string, root: string): Promise<SecretFiles> {
  const pending = loads.get(projectId);
  if (pending) return pending;

  const run = (async () => {
    const stored = await loadStoredSecretValues(projectId);

    // Обход выполняется и когда хранилище уже есть: файл мог появиться из git pull, быть
    // восстановлен вручную или создан приложением. Он не должен остаться в рабочей области
    // только потому, что первая миграция случилась раньше. Кэша «уже проверено» здесь нет:
    // именно он раньше скрывал такие файлы до перезапуска сервера.
    const files: SecretFiles = stored ? { ...stored } : {};
    const migratedFiles: string[] = [];
    for (const relative of await findSecretEnvFiles(root)) {
      if (!isProjectSecretFile(path.posix.basename(relative))) continue;
      const target = path.join(root, relative);
      // Символическая ссылка может указывать наружу: её не переносим, и файл остаётся
      // недоступен агенту по имени.
      const info = await lstat(target).catch(() => null);
      if (!info || !info.isFile()) continue;
      // Пустой файл — это placeholder, который предпросмотр создаёт под read-only mount.
      // Значений в нём нет, поэтому переносить и удалять нечего; иначе каждая проверка
      // списка переписывала бы хранилище.
      if (info.size === 0) continue;
      if (info.size > MAX_ENV_FILE_BYTES) {
        throw new Error("Файл секретов " + relative + " больше 500 КБ — сократите его и повторите");
      }
      // Файл на диске — источник истины для своего имени: удалённая из него переменная не
      // должна воскресать из старой копии в хранилище.
      files[relative] = fileVariables(await readFile(target, "utf8"));
      migratedFiles.push(relative);
    }

    if (migratedFiles.length) {
      // Сначала шифрованное хранилище, только потом удаление: сбой записи не должен уничтожить
      // единственную копию секрета.
      await saveStoredSecretValues(projectId, files);
      for (const relative of migratedFiles) {
        try {
          await rm(path.join(root, relative), { force: true });
        } catch (error) {
          console.error("[secrets] не удалось удалить перенесённый файл " + relative, error);
        }
      }
    }
    return files;
  })();

  loads.set(projectId, run);
  try {
    return await run;
  } finally {
    loads.delete(projectId);
  }
}

/** Один проект меняется одним запросом: иначе два сохранения теряют переменную друг друга. */
const locks = new Map<string, Promise<unknown>>();
async function withSecretLock<T>(projectId: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const current = previous.then(() => gate);
  locks.set(projectId, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (locks.get(projectId) === current) locks.delete(projectId);
  }
}

function flatten(files: SecretFiles): ProjectSecret[] {
  return Object.entries(files)
    .flatMap(([file, variables]) =>
      Object.entries(variables).map(([name, value]) => ({
        name,
        preview: projectSecretPreview(value),
        file,
      })),
    )
    .sort((left, right) => left.file.localeCompare(right.file) || left.name.localeCompare(right.name));
}

/** Все секретные env-файлы проекта; используется предпросмотром для read-only монтирования. */
export async function loadProjectSecretFiles(projectId: string, root: string): Promise<SecretFiles> {
  return loadFiles(projectId, root);
}

/** Список переменных: только имена и форма значения, сам секрет в браузер не уходит. */
export async function listProjectSecrets(projectId: string, root: string): Promise<ProjectSecret[]> {
  return flatten(await loadFiles(projectId, root));
}

async function writeFileValues(
  projectId: string,
  root: string,
  file: string,
  variables: Record<string, string>,
) {
  assertSecretFile(file);
  const entries = Object.entries(variables);
  for (const [name, value] of entries) assertVariable(name, value);
  if (!entries.length) return flatten(await loadFiles(projectId, root));

  return withSecretLock(projectId, async () => {
    const files = await loadFiles(projectId, root);
    files[file] = { ...files[file], ...variables };
    await saveStoredSecretValues(projectId, files);
    return flatten(files);
  });
}

/** Добавляет или заменяет переданные переменные в одном файле, не трогая остальные. */
export async function saveProjectSecrets(
  projectId: string,
  root: string,
  variables: Record<string, string>,
  file = PROJECT_SECRETS_FILE,
) {
  return writeFileValues(projectId, root, file, variables);
}

/** Импорт готового `.env`: комментарии, export, кавычки и многострочные ключи понимаются. */
export async function importProjectSecrets(
  projectId: string,
  root: string,
  content: string,
  file = PROJECT_SECRETS_FILE,
) {
  assertSecretFile(file);
  if (Buffer.byteLength(content, "utf8") > MAX_ENV_FILE_BYTES) {
    throw new Error("Файл больше 500 КБ — это не .env с секретами проекта");
  }
  const variables = fileVariables(content);
  if (!Object.keys(variables).length) {
    throw new Error("В файле нет ни одной переменной вида KEY=value");
  }
  return writeFileValues(projectId, root, file, variables);
}

/**
 * Значение из модального окна идёт в тот файл, который запросил агент. Файл по-прежнему
 * проверяется по имени, а значение никогда не возвращается.
 */
export async function writeProjectSecret(
  projectId: string,
  root: string,
  file: string,
  name: string,
  value: string,
) {
  assertSecretFile(file);
  return writeFileValues(projectId, root, file, { [name]: value });
}

/** Удаляет переменную из файла и возвращает обновлённый список; значение в ответ не попадает. */
export async function deleteProjectSecret(
  projectId: string,
  root: string,
  name: string,
  file = PROJECT_SECRETS_FILE,
): Promise<{ deleted: boolean; variables: ProjectSecret[] }> {
  assertSecretFile(file);
  if (!PROJECT_SECRET_NAME.test(name)) throw new Error("Некорректное имя переменной");
  return withSecretLock(projectId, async () => {
    const files = await loadFiles(projectId, root);
    const present = Object.prototype.hasOwnProperty.call(files[file] ?? {}, name);
    if (!present) return { deleted: false, variables: flatten(files) };
    delete files[file][name];
    if (!Object.keys(files[file]).length) delete files[file];
    await saveStoredSecretValues(projectId, files);
    return { deleted: true, variables: flatten(files) };
  });
}
