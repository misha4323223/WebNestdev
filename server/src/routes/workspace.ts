import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { readdir,readFile } from "node:fs/promises";
import path from "node:path";
import { getSandbox,assertInsideSandbox } from "../sandbox-manager.js";
import { runInSandbox } from "../sandbox-worker.js";

export async function registerWorkspaceRoutes(app:FastifyInstance){
  app.get("/api/projects/:id/files",async(request)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const q=z.object({path:z.string().default(".")}).parse(request.query);
    const sandbox=await getSandbox(p.id);
    const dir=assertInsideSandbox(sandbox.root,path.join(sandbox.root,q.path));
    const entries=await readdir(dir,{withFileTypes:true});
    return {path:q.path,files:entries.map(e=>({name:e.name,type:e.isDirectory()?"directory":"file"}))};
  });

  app.get("/api/projects/:id/file",async(request)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const q=z.object({path:z.string().min(1)}).parse(request.query);
    const sandbox=await getSandbox(p.id);
    const file=assertInsideSandbox(sandbox.root,path.join(sandbox.root,q.path));
    return {path:q.path,content:await readFile(file,"utf8")};
  });

  app.post("/api/projects/:id/terminal",async(request)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const body=z.object({command:z.string().min(1),cwd:z.string().optional()}).parse(request.body);
    const sandbox=await getSandbox(p.id);
    const cwd=assertInsideSandbox(sandbox.root,path.join(sandbox.root,body.cwd??"."));
    return runInSandbox(sandbox,body.command,cwd);
  });
}
