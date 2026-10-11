import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { mkdir,readdir,readFile,stat,writeFile } from "node:fs/promises";
import path from "node:path";
import { requireProjectUser } from "../auth/auth.js";
import { getSandbox,assertInsideSandbox } from "../sandbox-manager.js";
import { assertRegularFile,resolveInsideSandbox } from "../sandbox/path-guard.js";
import { runInSandbox } from "../sandbox-worker.js";

const MAX_FILE_BYTES=Number(process.env.WORKSPACE_MAX_FILE_BYTES??2_000_000);
const MAX_DIRECTORY_ENTRIES=Number(process.env.WORKSPACE_MAX_DIRECTORY_ENTRIES??2_000);
// Uploads arrive as base64 inside a JSON body, and the API body limit is 2 MB, so
// the decoded ceiling stays well below it.
const MAX_UPLOAD_BYTES=Number(process.env.WORKSPACE_MAX_UPLOAD_BYTES??1_200_000);
const UPLOAD_FOLDER="uploads";

export async function registerWorkspaceRoutes(app:FastifyInstance){
  app.get("/api/projects/:id/files",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    if(!await requireProjectUser(request,reply,p.id))return;
    const q=z.object({path:z.string().max(2000).default(".")}).parse(request.query);
    const sandbox=await getSandbox(p.id);
    const dir=await resolveInsideSandbox(sandbox.root,path.join(sandbox.root,q.path));
    const entries=await readdir(dir,{withFileTypes:true});
    if(entries.length>MAX_DIRECTORY_ENTRIES)throw new Error("В папке слишком много файлов");
    return {path:q.path,files:entries.map(e=>({name:e.name,type:e.isDirectory()?"directory":e.isFile()?"file":"other"})).filter(e=>e.type!=="other")};
  });

  app.get("/api/projects/:id/file",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    if(!await requireProjectUser(request,reply,p.id))return;
    const q=z.object({path:z.string().min(1).max(2000)}).parse(request.query);
    const sandbox=await getSandbox(p.id);
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
    if(!await requireProjectUser(request,reply,p.id))return;
    const body=z.object({name:z.string().min(1).max(300),data:z.string().min(1).max(1_700_000)}).parse(request.body);
    const bytes=Buffer.from(body.data,"base64");
    if(!bytes.length)throw new Error("Пустой файл");
    if(bytes.length>MAX_UPLOAD_BYTES)throw new Error("Файл больше "+Math.round(MAX_UPLOAD_BYTES/1000)+" КБ");
    const base=(body.name.split(/[\\/]/).pop()??"file").replace(/[^A-Za-z0-9._-]+/g,"-").replace(/^[.-]+/,"").slice(0,120)||"file";
    const sandbox=await getSandbox(p.id);
    const dir=path.join(sandbox.root,UPLOAD_FOLDER);
    await mkdir(dir,{recursive:true});
    const relative=UPLOAD_FOLDER+"/"+Date.now().toString(36)+"-"+base;
    await writeFile(assertInsideSandbox(sandbox.root,path.join(sandbox.root,relative)),bytes);
    return {name:base,path:relative,bytes:bytes.length};
  });

  app.post("/api/projects/:id/terminal",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    if(!await requireProjectUser(request,reply,p.id))return;
    const body=z.object({command:z.string().min(1).max(20000),cwd:z.string().max(2000).optional()}).parse(request.body);
    const sandbox=await getSandbox(p.id);
    const cwd=await resolveInsideSandbox(sandbox.root,path.join(sandbox.root,body.cwd??"."));
    return runInSandbox(sandbox,body.command,cwd);
  });
}