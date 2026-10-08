import type { FastifyInstance } from "fastify";
import type { RawData } from "ws";
import { z } from "zod";
import { AgentRuntime } from "../agent-runtime.js";
import { getCurrentUser } from "../auth/auth.js";
import { getProject,getConversation,appendConversationMessages } from "../project-store.js";

const messageSchema=z.discriminatedUnion("role",[
  z.object({role:z.literal("user"),content:z.string().max(100000)}),
  z.object({role:z.literal("assistant"),content:z.string().max(100000),tool_calls:z.array(z.object({id:z.string(),name:z.string(),arguments:z.record(z.string(),z.unknown())})).optional()}),
  z.object({role:z.literal("tool"),content:z.string().max(100000),tool_call_id:z.string()})
]);
const runSchema=z.object({projectId:z.string().min(1).max(200),conversationId:z.string().max(200).optional(),messages:z.array(messageSchema).min(1).max(100),model:z.string().max(200).optional()});

function allowedOrigin(origin:string|undefined){
  if(!origin)return true;
  const allowed=(process.env.WEBNESTDEV_ALLOWED_ORIGINS??"http://localhost:5173").split(",").map(value=>value.trim()).filter(Boolean);
  return allowed.includes(origin);
}

export async function registerAgentWebSocket(app:FastifyInstance,runtime=new AgentRuntime()){
  app.get("/ws",{websocket:true},(socket,request)=>{
    if(!allowedOrigin(request.headers.origin)){
      socket.close(1008,"Origin not allowed");
      return;
    }
    let running=false,closed=false; let controller:AbortController|null=null;
    const safeSend=(payload:unknown)=>{if(!closed)try{socket.send(JSON.stringify(payload))}catch{closed=true}};
    socket.on("close",()=>{closed=true;controller?.abort();controller=null;});
    socket.on("message",async (raw:RawData)=>{
      if(closed)return;
      if(running){safeSend({type:"error",error:"Agent is already running for this connection"});return}
      running=true;
      try{
        const user=await getCurrentUser(request);
        if(!user){socket.close(1008,"Authentication required");closed=true;return}
        const message=JSON.parse(raw.toString()) as {type?:string;request?:unknown};
        if(message.type!=="agent.run")throw new Error("Unknown websocket message type");
        const parsed=runSchema.parse(message.request);
        const payloadSize=Buffer.byteLength(JSON.stringify(parsed),"utf8");
        if(payloadSize>2_000_000)throw new Error("Agent request is too large");
        const project=await getProject(parsed.projectId);
        if(!project||project.userId!==user.id)throw new Error("Project not found");
        if(parsed.conversationId){
          const conversation=await getConversation(parsed.conversationId);
          if(!conversation||conversation.projectId!==parsed.projectId)throw new Error("Conversation not found for project");
          const last=parsed.messages.at(-1),storedLast=conversation.messages.at(-1);
          if(last?.role==="user"&&!(storedLast?.role==="user"&&storedLast.content===last.content))await appendConversationMessages(parsed.conversationId,[last]);
        }
        controller=new AbortController();
        await runtime.run({...parsed,userId:user.id},event=>safeSend(event),controller.signal);
      }catch(error){safeSend({type:"error",error:error instanceof Error?error.message:String(error)});}
      finally{running=false;}
    });
  });
}