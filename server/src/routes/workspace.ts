import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { readdir,readFile,stat } from "node:fs/promises";
import path from "node:path";
import { getSandbox,assertInsideSandbox } from "../sandbox-manager.js";
import { assertRegularFile,resolveInsideSandbox } from "../sandbox/path-guard.js";
import { runInSandbox } from "../sandbox-worker.js";

const MAX_FILE_BYTES=Number(process.env.WORKSPACE_MAX_FILE_BYTES??2_000_000);
const MAX_DIRECTORY_ENTRIES=Number(process.env.WORKSPACE_MAX_DIRECTORY_ENTRIES??2_000);

export async function registerWorkspaceRoutes(app:FastifyInstance){
  app.get("/api/projects/:id/files",async(request)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const q=z.object({path:z.string().max(2000).default(".")}).parse(request.query);
    const sandbox=await getSandbox(p.id);
    const dir=await resolveInsideSandbox(sandbox.root,path.join(sandbox.root,q.path));
    const entries=await readdir(dir,{withFileTypes:true});
    if(entries.length>MAX_DIRECTORY_ENTRIES)throw new Error("Directory contains too many entries");
    return {path:q.path,files:entries.map(e=>({name:e.name,type:e.isDirectory()?"directory":e.isFile()?"file":"other"})).filter(e=>e.type!=="other")};
  });

  app.get("/api/projects/:id/file",async(request)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const q=z.object({path:z.string().min(1).max(2000)}).parse(request.query);
    const sandbox=await getSandbox(p.id);
    const file=await assertRegularFile(sandbox.root,path.join(sandbox.root,q.path));
    const info=await stat(file);
    if(info.size>MAX_FILE_BYTES)throw new Error("File is too large to open in the workspace");
    return {path:q.path,content:await readFile(file,"utf8")};
  });

  app.post("/api/projects/:id/terminal",async(request)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const body=z.object({command:z.string().min(1).max(20000),cwd:z.string().max(2000).optional()}).parse(request.body);
    const sandbox=await getSandbox(p.id);
    const cwd=await resolveInsideSandbox(sandbox.root,path.join(sandbox.root,body.cwd??"."));
    return runInSandbox(sandbox,body.command,cwd);
  });
}
