import { apiJson, apiUrl } from "./api";

export type ProjectEntryType = "file" | "directory";

/**
 * Дерево файлов меняется не только сохранением текста: панель создаёт и удаляет узлы,
 * загружает материалы и скачивает отдельный файл. Эти вызовы живут отдельно от `project-api`,
 * чтобы редактор и список файлов не тянули весь остальной API проекта.
 */
export const createProjectEntry = (
  projectId: string,
  body: { path: string; type: ProjectEntryType; content?: string },
) => apiJson<{ path: string; type: ProjectEntryType; bytes?: number }>(
  "/api/projects/" + projectId + "/files",
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
);

export const renameProjectEntry = (
  projectId: string,
  body: { from: string; to: string },
) => apiJson<{ path: string; type?: ProjectEntryType }>(
  "/api/projects/" + projectId + "/files",
  { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
);

export const deleteProjectEntry = (projectId: string, path: string) =>
  apiJson<{ path: string; deleted: boolean }>(
    "/api/projects/" + projectId + "/files?path=" + encodeURIComponent(path),
    { method: "DELETE" },
  );

export const uploadProjectEntry = (
  projectId: string,
  body: { path: string; name: string; data: string },
) => apiJson<{ path: string; name: string; bytes: number }>(
  "/api/projects/" + projectId + "/files/upload",
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
);

/** Скачивание одного файла: ошибку показываем в панели, а не белой страницей вместо неё. */
export async function downloadProjectFile(projectId: string, path: string) {
  let response: Response;
  try {
    response = await fetch(
      apiUrl("/api/projects/" + projectId + "/files/download?path=" + encodeURIComponent(path)),
      { credentials: "include" },
    );
  } catch (error) {
    throw new Error("Не удалось подключиться к NestDev API: " + (error instanceof Error ? error.message : String(error)));
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(data?.error ?? ("HTTP " + response.status));
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = path.split("/").pop() || "file";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // URL живёт до следующей вкладки: Safari отменяет скачивание при немедленном отзыве.
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
}
