import type { FastifyReply } from "fastify";
import { ProjectRestoreFailedError, ProjectRestoringError } from "../storage/restore-jobs.js";

/**
 * Единый HTTP-ответ холодного старта. Панель получает `Retry-After` и прогресс, а не
 * 500/непонятную ошибку; тот же помощник используется в тесте гонки restore + `/changes`.
 */
export function sendProjectRestoreError(error: unknown, reply: FastifyReply): boolean {
  if (!(error instanceof ProjectRestoringError || error instanceof ProjectRestoreFailedError)) return false;
  if (error instanceof ProjectRestoringError) reply.header("Retry-After", "2");
  reply.code(error.statusCode).send({
    error: error.message,
    code: error.code,
    jobId: error.jobId,
    bytesDone: error.bytesDone,
    bytesTotal: error.bytesTotal,
    ...(error instanceof ProjectRestoringError ? { retryAfter: 2 } : {}),
  });
  return true;
}
