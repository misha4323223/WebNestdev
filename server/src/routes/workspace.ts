import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { readdir,readFile,stat } from "node:fs/promises";
import path from "node:path";
import { requireProjectUser } from "../auth/auth.js";
import { getSandbox } from "../sandbox-manager.js";
import { assertRegularFile,resolveInsideSandbox,writeFileInside } from "../sandbox/path-guard.js";
import { runInSandbox } from "../sandbox-worker.js";
import { dockerMissing } from "../sandbox/docker/unavailable.js";
import { isSecretProjectPath, secretEnvRefusal } from "../secrets/secret-paths.js";
import { applyNoStoreToReply } from "./cache-headers.js";

const MAX_FILE_BYTES=Number(process.env.WORKSPACE_MAX_FILE_BYTES??2_000_000);
const MAX_DIRECTORY_ENTRIES=Number(process.env.WORKSPACE_MAX_DIRECTORY_ENTRIES??2_000);
// Uploads arrive as base64 inside a JSON body, and the API body limit is 2 MB, so
// the decoded ceiling stays well below it.
const MAX_UPLOAD_BYTES=Number(process.env.WORKSPACE_MAX_UPLOAD_BYTES??1_200_000);
const UPLOAD_FOLDER="uploads";

export async function registerWorkspaceRoutes(app:FastifyInstance){
  app.get("/api/projects/:id/files",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const user=await requireProjectUser(request,reply,p.id);
    if(!user)return;
    const q=z.object({path:z.string().max(2000).default(".")}).parse(request.query);
    const sandbox=await getSandbox(p.id,user.id);
    const dir=await resolveInsideSandbox(sandbox.root,path.join(sandbox.root,q.path));
    const entries=await readdir(dir,{withFileTypes:true});
    if(entries.length>MAX_DIRECTORY_ENTRIES)throw new Error("В папке слишком много файлов");
    // Панель «Файлы» — это ещё один читатель рабочей области. Секретные env-файлы не
    // показываются в ней даже именем: значения правятся только в разделе «Секреты».
    applyNoStoreToReply(reply);
    return {path:q.path,files:entries
      .filter(e=>!isSecretProjectPath(e.name))
      .map(e=>({name:e.name,type:e.isDirectory()?"directory":e.isFile()?"file":"other"}))
      .filter(e=>e.type!=="other")};
  });

  app.get("/api/projects/:id/file",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const user=await requireProjectUser(request,reply,p.id);
    if(!user)return;
    const q=z.object({path:z.string().min(1).max(2000)}).parse(request.query);
    applyNoStoreToReply(reply);
    // Прямой запрос файла не должен обходить запрет инструментов агента: тот же basename,
    // то же правило. 403, а не 404: файл существует, но этот маршрут его не отдаёт.
    if(isSecretProjectPath(q.path))return reply.code(403).send({error:secretEnvRefusal(q.path)});
    const sandbox=await getSandbox(p.id,user.id);
    const file=await assertRegularFile(sandbox.root,path.join(sandbox.root,q.path));
    const info=await stat(file);
    if(info.size>MAX_FILE_BYTES)throw new Error("Файл слишком большой, чтобы открыть его в рабочей области");
    return {path:q.path,content:await readFile(file,"utf8")};
  });

  /**
   * Stores a file the user attached in the chat composer inside the project, so the
   * agent can use it as project material. Names are reduced to a safe basename and
   * the upload lives in its own folder to keep it apart from generated sources.
   */
  app.post("/api/projects/:id/upload",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const user=await requireProjectUser(request,reply,p.id);
    if(!user)return;
    const body=z.object({name:z.string().min(1).max(300),data:z.string().min(1).max(1_700_000)}).parse(request.body);
    const bytes=Buffer.from(body.data,"base64");
    if(!bytes.length)throw new Error("Пустой файл");
    if(bytes.length>MAX_UPLOAD_BYTES)throw new Error("Файл больше "+Math.round(MAX_UPLOAD_BYTES/1000)+" КБ");
    const base=(body.name.split(/[\\/]/).pop()??"file").replace(/[^A-Za-z0-9._-]+/g,"-").replace(/^[.-]+/,"").slice(0,120)||"file";
    const sandbox=await getSandbox(p.id,user.id);
    const relative=UPLOAD_FOLDER+"/"+Date.now().toString(36)+"-"+base;
    await writeFileInside(sandbox.root,path.join(sandbox.root,relative),bytes);
    return {name:base,path:relative,bytes:bytes.length};
  });

  app.post("/api/projects/:id/terminal",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const user=await requireProjectUser(request,reply,p.id);
    if(!user)return;
    const body=z.object({command:z.string().min(1).max(20000),cwd:z.string().max(2000).optional()}).parse(request.body);
    const sandbox=await getSandbox(p.id,user.id);
    const cwd=await resolveInsideSandbox(sandbox.root,path.join(sandbox.root,body.cwd??"."));
    try{
      // Терминал панели — тоже команда: `.env.local` в нём виден по пути, но пуст.
      return await runInSandbox(sandbox,body.command,cwd,{maskSecretEnvFiles:true});
    }catch(error){
      // Команда, которая не запустилась вообще, — это диагностика для того, кто её набрал:
      // «Внутренняя ошибка сервера» не отличима от сломанного проекта. Хост без Docker и очередь
      // песочницы — 503 (как их и описывает лимитер), остальное — 400 с причиной, как в предпросмотре.
      const message=error instanceof Error?error.message:String(error);
      const carried=(error as {statusCode?:unknown}).statusCode;
      const status=typeof carried==="number"&&carried>=400&&carried<600?carried:dockerMissing(error)?503:400;
      return reply.code(status).send({error:message});
    }
  });
}