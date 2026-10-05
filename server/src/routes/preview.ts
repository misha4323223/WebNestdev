import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSandbox } from "../sandbox-manager.js";
import { startPreview,stopPreview,previewStatus } from "../preview-manager.js";

export async function registerPreviewRoutes(app:FastifyInstance){
  app.post("/api/projects/:id/preview/start",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    return reply.send(await startPreview(await getSandbox(p.id)));
  });
  app.post("/api/projects/:id/preview/stop",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    return reply.send(await stopPreview(p.id));
  });
  app.get("/api/projects/:id/preview/status",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    return reply.send(await previewStatus(p.id));
  });
  app.get("/api/projects/:id/preview/open",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    return proxyPreview(p.id,"");
  });
  app.get("/api/projects/:id/preview/open/*",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const params=request.params as {id:string;"*":string};
    return proxyPreview(p.id,params["*"]||"");
  });
  async function proxyPreview(projectId:string,suffix:string){
    const state=await previewStatus(projectId);
    if(!state.running||!state.port)throw new Error("Preview is not running");
    const response=await fetch("http://127.0.0.1:"+state.port+"/"+suffix);
    return new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers});
  }
}
