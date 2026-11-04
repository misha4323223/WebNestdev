import { apiJson } from "./api";

export type MediaUpload = {
  key: string;
  uploadId: string;
  publicUrl: string;
  partSizeBytes: number;
  partCount: number;
  parts: Array<{ partNumber: number; url: string }>;
};

export type UploadedMedia = {
  key: string;
  publicUrl: string;
  bytes: number;
};

export type MediaUsage = {
  count: number;
  files: Array<{ path: string; line: number }>;
};

export type ProjectMediaObject = {
  key: string;
  url: string;
  name: string;
  bytes: number;
  lastModified: string;
  usage: MediaUsage | null;
};

export type ProjectMediaList = {
  objects: ProjectMediaObject[];
  truncated: boolean;
  usageTruncated: boolean;
  usageAvailable: boolean;
  publicBaseUrl: string;
};

/** Список объектов в бакете проекта: он не зависит от того, сохранился ли чат с файлом. */
export async function listProjectMedia(projectId: string) {
  return apiJson<ProjectMediaList>("/api/projects/" + projectId + "/media/objects");
}

/** Удаляет уже загруженный файл из бакета; ключ проверяется на сервере по проекту. */
export async function deleteUploadedMedia(projectId: string, key: string, force = false) {
  return apiJson<{ deleted: boolean }>("/api/projects/" + projectId + "/media", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, ...(force ? { force: true } : {}) }),
  });
}

/** Переименование меняет URL, поэтому сервер разрешает его только для неиспользуемых файлов. */
export async function renameProjectMedia(projectId: string, key: string, name: string) {
  return apiJson<{ key: string; url: string; name: string; bytes: number }>("/api/projects/" + projectId + "/media/rename", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, name }),
  });
}

/**
 * Большой файл уходит в S3 частями. Сервер подписывает каждую часть, браузер кладёт её
 * напрямую в бакет, а в конце сервер проверяет размер и только тогда отдаёт публичную ссылку.
 * Ошибка на любой части отменяет multipart, чтобы неоплаченные обрывки не лежали в бакете.
 */
/**
 * Отправка одной части. Сначала прямо в бакет: так байты не идут через API. Если браузер не смог
 * достучаться до хранилища (сеть, расширение, CORS), та же часть уходит через API — ключ, uploadId
 * и номер части одни и те же, поэтому сборка файла в конце не меняется.
 */
async function uploadPart(
  projectId: string,
  start: MediaUpload,
  part: { partNumber: number; url: string },
  chunk: Blob,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(part.url, { method: "PUT", body: chunk });
  } catch {
    const proxied = await apiJson<{ etag: string }>(
      "/api/projects/" + projectId + "/media/part?partNumber=" + part.partNumber +
        "&uploadId=" + encodeURIComponent(start.uploadId) + "&key=" + encodeURIComponent(start.key),
      { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: chunk },
    );
    if (!proxied.etag) throw new Error("Сервер не вернул ETag части " + part.partNumber);
    return proxied.etag;
  }
  if (!response.ok) {
    throw new Error("Хранилище отклонило часть " + part.partNumber + ": HTTP " + response.status);
  }
  const etag = response.headers.get("etag");
  if (!etag) throw new Error("Хранилище не вернуло ETag части " + part.partNumber);
  return etag;
}

export async function uploadProjectMedia(
  projectId: string,
  file: Blob & { name: string },
  onProgress?: (uploaded: number, total: number) => void,
  options: { replaceKey?: string } = {},
): Promise<UploadedMedia> {
  const start = await apiJson<MediaUpload>("/api/projects/" + projectId + "/media", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: file.name,
      size: file.size,
      contentType: file.type || undefined,
      ...(options.replaceKey ? { replaceKey: options.replaceKey } : {}),
    }),
  });
  const parts: Array<{ partNumber: number; etag: string }> = [];
  let uploaded = 0;
  try {
    for (const part of start.parts) {
      const begin = (part.partNumber - 1) * start.partSizeBytes;
      const end = Math.min(file.size, begin + start.partSizeBytes);
      const chunk = file.slice(begin, end);
      parts.push({ partNumber: part.partNumber, etag: await uploadPart(projectId, start, part, chunk) });
      uploaded += chunk.size;
      onProgress?.(uploaded, file.size);
    }
    return await apiJson<UploadedMedia>("/api/projects/" + projectId + "/media/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: start.key, uploadId: start.uploadId, bytes: file.size, parts }),
    });
  } catch (error) {
    await apiJson<{ aborted: boolean }>("/api/projects/" + projectId + "/media/abort", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: start.key, uploadId: start.uploadId }),
    }).catch(() => undefined);
    throw error;
  }
}
