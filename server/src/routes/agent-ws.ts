import type { FastifyInstance } from "fastify";
import type { RawData } from "ws";
import { z } from "zod";
import { AgentRuntime } from "../agent-runtime.js";
import { getCurrentUser } from "../auth/auth.js";
import { getProject,getConversation,appendConversationMessages } from "../project-store.js";
import { consumeUsageForCurrentPlan } from "../account/usage-store.js";

const messageSchema=z.discriminatedUnion("role",[
  z.object({role:z.literal("user"),content:z.string().max(100000)}),
  z.object({role:z.literal("assistant"),content:z.string().max(100000),tool_calls:z.array(z.object({id:z.string(),name:z.string(),arguments:z.record(z.string(),z.unknown())})).optional()}),
  z.object({role:z.literal("tool"),content:z.string().max(100000),tool_call_id:z.string()})
]);
const runSchema=z.object({projectId:z.string().min(1).max(200),conversationId:z.string().max(200).optional(),messages:z.array(messageSchema).min(1).max(100),model:z.string().max(200).optional(),mode:z.enum(["planner","developer"]).optional()});

// Mirrors the HTTP CORS rule in index.ts: in development the browser origin varies
// (localhost, LAN IP, hosted preview domain), so any origin is accepted unless
// WEBNESTDEV_ALLOWED_ORIGINS pins a list. Production always uses the list.
function allowedOrigin(origin:string|undefined){
  if(!origin)return true;
  const production=process.env.NODE_ENV==="production";
  const configured=process.env.WEBNESTDEV_ALLOWED_ORIGINS;
  if(!production&&!configured)return true;
  const allowed=(configured??"").split(",").map(value=>value.trim()).filter(Boolean);
  return allowed.includes(origin);
}

export async function registerAgentWebSocket(app:FastifyInstance,runtime=new AgentRuntime()){
  app.get("/ws",{websocket:true},(socket,request)=>{
    if(!allowedOrigin(request.headers.origin)){
      socket.close(1008,"Источник запроса не разрешён");
      return;
    }
    let running=false,closed=false; let controller:AbortController|null=null;
    const safeSend=(payload:unknown)=>{if(!closed)try{socket.send(JSON.stringify(payload))}catch{closed=true}};
    socket.on("close",()=>{closed=true;controller?.abort();controller=null;});
    socket.on("message",async (raw:RawData)=>{
      if(closed)return;
      if(running){safeSend({type:"error",error:"Агент уже выполняется в этом соединении"});return}
      running=true;
      try{
        const user=await getCurrentUser(request);
        if(!user){socket.close(1008,"Требуется вход в аккаунт");closed=true;return}
        const message=JSON.parse(raw.toString()) as {type?:string;request?:unknown};
        if(message.type!=="agent.run")throw new Error("Неизвестный тип сообщения");
        const parsed=runSchema.parse(message.request);
        const payloadSize=Buffer.byteLength(JSON.stringify(parsed),"utf8");
        if(payloadSize>2_000_000)throw new Error("Запрос агента слишком большой");
        const project=await getProject(parsed.projectId);
        if(!project||project.userId!==user.id)throw new Error("Проект не найден");
        if(parsed.conversationId){
          const conversation=await getConversation(parsed.conversationId);
          if(!conversation||conversation.projectId!==parsed.projectId)throw new Error("Сессия не найдена в этом проекте");
          const storedUserContent=new Set(conversation.messages.filter(m=>m.role==="user").map(m=>m.content));
          const newMessages=parsed.messages.filter(m=>m.role==="user"&&!storedUserContent.has(m.content));
          if(newMessages.length)await appendConversationMessages(parsed.conversationId,newMessages);
        }
        const usage = await consumeUsageForCurrentPlan(user.id,"agentRuns");
        safeSend({type:"usage.updated",usage});
        controller=new AbortController();
        await runtime.run({...parsed,userId:user.id},event=>safeSend(event),controller.signal);
      }catch(error){
        const message = error instanceof Error ? error.message : String(error);
        const isQuota = error && typeof error === "object" && "statusCode" in error && (error as {statusCode?:unknown}).statusCode === 429;
        const isStorage = error instanceof Error && error.name === "StorageLimitError";
        const quotaCode = isStorage ? "STORAGE_LIMIT_REACHED" : "DAILY_QUOTA_EXCEEDED";
        safeSend({type:"error",error:message,...(isQuota?{code:quotaCode}:{})});
      }
      finally{running=false;}
    });
  });
}
