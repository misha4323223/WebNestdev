import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { AgentRuntime } from "./agent-runtime.js";
import { createProject,ensureDataDir,getProject,createConversation,getConversation,listConversations,appendConversationMessages } from "./project-store.js";
import { listTools } from "./tool-registry.js";
import { sandboxStatus } from "./docker-sandbox.js";
import { getSandbox,assertInsideSandbox } from "./sandbox-manager.js";
import { readdir,readFile } from "node:fs/promises";
import path from "node:path";
import { runInSandbox } from "./sandbox-worker.js";
import "./tools/project-tools.js";
import "./tools/filesystem-tools.js";
import "./tools/terminal-tools.js";
import "./tools/git-tools.js";

const app=Fastify({logger:true});
const runtime=new AgentRuntime();
await ensureDataDir();
await app.register(cors,{origin:true});
await app.register(websocket);

const messageSchema=z.discriminatedUnion("role",[
  z.object({role:z.literal("user"),content:z.string()}),
  z.object({role:z.literal("system"),content:z.string()}),
  z.object({role:z.literal("assistant"),content:z.string(),tool_calls:z.array(z.object({id:z.string(),name:z.string(),arguments:z.record(z.unknown())})).optional()}),
  z.object({role:z.literal("tool"),content:z.string(),tool_call_id:z.string()})
]);
const runSchema=z.object({projectId:z.string().min(1),conversationId:z.string().optional(),messages:z.array(messageSchema).min(1),model:z.string().optional()});

app.get("/api/health",async()=>({ok:true,service:"webnestdev-server",sandbox:await sandboxStatus()}));
app.get("/api/sandbox/status",async()=>sandboxStatus());
app.get("/api/tools",async()=>({tools:listTools()}));
app.get("/api/projects/:id/files",async(request,reply)=>{
  const p=z.object({id:z.string().min(1)}).parse(request.params);
  const q=z.object({path:z.string().default(".")}).parse(request.query);
  const sandbox=await getSandbox(p.id); const dir=assertInsideSandbox(sandbox.root,path.join(sandbox.root,q.path));
  const entries=await readdir(dir,{withFileTypes:true}); return {path:q.path,files:entries.map(e=>({name:e.name,type:e.isDirectory()?"directory":"file"}))};
});
app.get("/api/projects/:id/file",async(request,reply)=>{
  const p=z.object({id:z.string().min(1)}).parse(request.params); const q=z.object({path:z.string().min(1)}).parse(request.query);
  const sandbox=await getSandbox(p.id); const file=assertInsideSandbox(sandbox.root,path.join(sandbox.root,q.path));
  return {path:q.path,content:await readFile(file,"utf8")};
});
app.post("/api/projects/:id/terminal",async(request,reply)=>{
  const p=z.object({id:z.string().min(1)}).parse(request.params); const body=z.object({command:z.string().min(1),cwd:z.string().optional()}).parse(request.body);
  const sandbox=await getSandbox(p.id); const cwd=assertInsideSandbox(sandbox.root,path.join(sandbox.root,body.cwd??"."));
  return runInSandbox(sandbox,body.command,cwd);
});
app.get("/api/projects/:id",async(request,reply)=>{const params=z.object({id:z.string().min(1)}).parse(request.params);const project=await getProject(params.id);if(!project)return reply.code(404).send({error:"Project not found"});return project});
app.post("/api/projects",async(request,reply)=>{const body=z.object({name:z.string().max(120).optional()}).parse(request.body);return reply.code(201).send(await createProject(body.name??"Новый проект"))});
app.get("/api/projects/:id/conversations",async(request,reply)=>{const p=z.object({id:z.string().min(1)}).parse(request.params);if(!await getProject(p.id))return reply.code(404).send({error:"Project not found"});return {conversations:await listConversations(p.id)}});
app.post("/api/projects/:id/conversations",async(request,reply)=>{const p=z.object({id:z.string().min(1)}).parse(request.params);const body=z.object({title:z.string().max(120).optional()}).parse(request.body);return reply.code(201).send(await createConversation(p.id,body.title))});
app.get("/api/conversations/:id",async(request,reply)=>{const p=z.object({id:z.string().min(1)}).parse(request.params);const c=await getConversation(p.id);if(!c)return reply.code(404).send({error:"Conversation not found"});return c});

app.get("/ws",{websocket:true},(socket)=>{
  socket.on("message",async raw=>{
    try{
      const message=JSON.parse(raw.toString()) as {type?:string;request?:unknown};
      if(message.type!=="agent.run"){socket.send(JSON.stringify({type:"error",error:"Unknown websocket message type"}));return}
      const request=runSchema.parse(message.request);
      await runtime.run(request,event=>socket.send(JSON.stringify(event)));
    }catch(error){socket.send(JSON.stringify({type:"error",error:error instanceof Error?error.message:String(error)}))}
  });
});

await app.listen({host:"0.0.0.0",port:Number(process.env.PORT??8787)});
