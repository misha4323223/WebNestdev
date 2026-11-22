export type FileChangeState = "added" | "modified" | "deleted";

const TEXT_FILE = /\.(?:[cm]?[jt]sx?|json|css|scss|sass|less|html?|md|txt|svg|yml|yaml|toml|env|sql|sh|py|rb|go|rs|java|php|xml|graphql|vue|svelte)$/i;
const IMAGE_FILE = /\.(?:png|jpe?g|webp|gif|avif|bmp|ico)$/i;

export function baseName(file: string) {
  return file.split("/").pop() || file;
}

export function fileFolder(file: string) {
  const parts = file.split("/");
  parts.pop();
  return parts.join("/") || ".";
}

/** Сервер скрывает секретные env-файлы; проверка остаётся и здесь для старого ответа из кэша. */
export function isSecretEnvName(name: string) {
  if (name !== ".env" && !name.startsWith(".env.")) return false;
  return !/\.(example|sample|template)$/.test(name);
}

export function isTextFile(file: string) {
  return TEXT_FILE.test(baseName(file));
}

export function isImageFile(file: string) {
  return IMAGE_FILE.test(baseName(file));
}

export function isJsonFile(file: string) {
  return /\.json$/i.test(baseName(file));
}

export const changeLabels: Record<FileChangeState, string> = {
  added: "Создан агентом",
  modified: "Изменён агентом",
  deleted: "Удалён агентом",
};

/** Сколько изменённых файлов лежит внутри папки: по этому числу папка тоже подсвечивается. */
export function changedInside(path: string, changes: Map<string, FileChangeState>) {
  const prefix = path + "/";
  let count = 0;
  for (const file of changes.keys()) {
    if (file.startsWith(prefix)) count += 1;
  }
  return count;
}
