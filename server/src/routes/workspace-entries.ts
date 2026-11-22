import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { requireProjectUser } from "../auth/auth.js";
import { getSandbox } from "../sandbox-manager.js";
import { assertRegularFile } from "../sandbox/path-guard.js";
import {
  ProjectFileError,
  createProjectEntry,
  deleteProjectEntry,
  MAX_CREATE_BYTES,
  projectDownloadPath,
  renameProjectEntry,
  uploadProjectEntry,
} from "../files/project-file-ops.js";
import { applyNoStoreToReply } from "./cache-headers.js";

function failure(reply: FastifyReply, error: unknown) {
  const status = error instanceof ProjectFileError
    ? error.statusCode
    : (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 400;
  return reply.code(status).send({ error: error instanceof Error ? error.message : String(error) });
}

/**
 * Операции панели «Файлы», которые меняют дерево, а не содержимое одного файла: создание
 * файла и папки, переименование, удаление, загрузка и скачивание. Они отделены от редактора,
 * чтобы маршрут сохранения текста оставался маленьким, а проверки путей жили в одном месте.
 */
export async function registerWorkspaceEntryRoutes(app: FastifyInstance) {
  app.post("/api/projects/:id/files", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const user = await requireProjectUser(request, reply, params.id);
    if (!user) return;
    const body = z.object({
      path: z.string().min(1).max(2000),
      type: z.enum(["file", "directory"]),
      content: z.string().max(MAX_CREATE_BYTES).optional(),
    }).parse(request.body);
    try {
      const sandbox = await getSandbox(params.id, user.id);
      const entry = await createProjectEntry(sandbox.root, params.id, user.id, body);
      applyNoStoreToReply(reply);
      return reply.code(201).send(entry);
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.patch("/api/projects/:id/files", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const user = await requireProjectUser(request, reply, params.id);
    if (!user) return;
    const body = z.object({
      from: z.string().min(1).max(2000),
      to: z.string().min(1).max(2000),
    }).parse(request.body);
    try {
      const sandbox = await getSandbox(params.id, user.id);
      const entry = await renameProjectEntry(sandbox.root, params.id, user.id, body);
      applyNoStoreToReply(reply);
      return entry;
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.delete("/api/projects/:id/files", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const user = await requireProjectUser(request, reply, params.id);
    if (!user) return;
    const query = z.object({ path: z.string().min(1).max(2000) }).parse(request.query);
    try {
      const sandbox = await getSandbox(params.id, user.id);
      const entry = await deleteProjectEntry(sandbox.root, params.id, user.id, query.path);
      applyNoStoreToReply(reply);
      return entry;
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post("/api/projects/:id/files/upload", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const user = await requireProjectUser(request, reply, params.id);
    if (!user) return;
    const body = z.object({
      path: z.string().max(2000).default("."),
      name: z.string().min(1).max(300),
      data: z.string().min(1).max(1_700_000),
    }).parse(request.body);
    try {
      const sandbox = await getSandbox(params.id, user.id);
      const entry = await uploadProjectEntry(sandbox.root, params.id, user.id, body);
      applyNoStoreToReply(reply);
      return reply.code(201).send(entry);
    } catch (error) {
      return failure(reply, error);
    }
  });

  /**
   * Скачивание одного файла. Поток, а не буфер: в проекте могут быть большие архивы и
   * изображения, и держать их целиком в памяти ради одного клика незачем.
   */
  app.get("/api/projects/:id/files/download", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const user = await requireProjectUser(request, reply, params.id);
    if (!user) return;
    const query = z.object({ path: z.string().min(1).max(2000) }).parse(request.query);
    try {
      const sandbox = await getSandbox(params.id, user.id);
      const target = await projectDownloadPath(sandbox.root, query.path);
      const file = await assertRegularFile(sandbox.root, target.path);
      const info = await stat(file);
      const name = path.basename(target.relative);
      const ascii = name.replace(/[^\x20-\x7e]/g, "_");
      applyNoStoreToReply(reply);
      reply.header("content-type", "application/octet-stream");
      reply.header("content-length", info.size);
      reply.header("content-disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
      return reply.send(createReadStream(file));
    } catch (error) {
      return failure(reply, error);
    }
  });
}
