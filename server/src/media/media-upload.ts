import path from "node:path";
import { assertMediaQuota } from "./media-quota.js";
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  mediaConfigFromEnv,
  uploadMultipartPart,
} from "./media-store.js";

export type StoredMedia = { key: string; publicUrl: string; bytes: number };

/**
 * Загрузка одного файла с сервера. Браузерная загрузка идёт через presigned URL, но снимок
 * уже лежит в памяти Node: гонять его через HTTP API панели и обратно незачем. Используется
 * тот же multipart-контракт, что и у вложений чата, поэтому ключ, квота и публичная ссылка
 * получаются одинаковыми.
 */
export async function uploadScreenshotBuffer(input: {
  userId: string;
  projectId: string;
  name: string;
  bytes: Buffer;
  contentType: string;
}): Promise<StoredMedia | null> {
  const config = mediaConfigFromEnv();
  if (!config) return null;
  await assertMediaQuota(input.userId, input.bytes.length);
  const upload = await createMultipartUpload(config, {
    userId: input.userId,
    projectId: input.projectId,
    name: path.basename(input.name) || "screenshot.png",
    size: input.bytes.length,
    contentType: input.contentType,
  });
  try {
    const parts: Array<{ partNumber: number; etag: string }> = [];
    const count = Math.ceil(input.bytes.length / upload.partSizeBytes);
    for (let index = 0; index < count; index++) {
      const body = input.bytes.subarray(index * upload.partSizeBytes, (index + 1) * upload.partSizeBytes);
      const etag = await uploadMultipartPart(config, {
        key: upload.key,
        uploadId: upload.uploadId,
        partNumber: index + 1,
        body,
      });
      parts.push({ partNumber: index + 1, etag });
    }
    const completed = await completeMultipartUpload(config, {
      key: upload.key,
      uploadId: upload.uploadId,
      parts,
      expectedBytes: input.bytes.length,
    });
    return { key: completed.key, publicUrl: completed.publicUrl, bytes: completed.bytes };
  } catch (error) {
    await abortMultipartUpload(config, upload.key, upload.uploadId).catch(() => undefined);
    throw error;
  }
}
