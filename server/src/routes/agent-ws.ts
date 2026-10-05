import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentRuntime } from "../agent-runtime.js";
import { getProject,getConversation,appendConversationMessages } from "../project-store.js";

const messageSchema=z.discriminatedUnion("role",[
  z.object({role:z.literal("user"),content:z.string().max(100000)}),
  z.object({role:z.literal("system"),content:z.string().max(100000)}),
  z.object({role:z.literal("assistant"),content:z.string().max(100000),tool_calls:z.array(z.object({id:z.string(),name:z.string(),arguments:z.record(z.unknown())})).optional()}),
  z.object({role:z.literal("tool"),content:z.string().max(100000),tool_call_id:z.string()})
]);
const runSchema=z.object({projectId:z.string().min(1).max(200),conversationId:z.string().max(200).optional(),messages:z.array(messageSchema).min(1).max(100),model:z.string().max(200).optional()});

export async function registerAgentWebSocket(app:FastifyInstance,runtime=new AgentRuntime()){
  app.get("/ws",{websocket:true},(socket)=>{
    let running=false;
    let closed=false;

    const safeSend=(payload:unknown)=>{
      if(!closed)try{socket.send(JSON.stringify(payload))}catch{closed=true}
    };

    socket.on("close",()=>{closed=true});
    socket.on("message",async raw=>{
      if(closed)return;
      if(running){safeSend({type:"error",error:"Agent is already running for this connection"});return}
      running=true;
      try{
        const message=JSON.parse(raw.toString()) as {type?:string;request?:unknown};
        if(message.type!=="agent.run"){safeSend({type:"error",error:"Unknown websocket message type"});return}

        const request=runSchema.parse(message.request);
        const payloadSize=Buffer.byteLength(JSON.stringify(request),"utf8");
        if(payloadSize>2_000_000)throw new Error("Agent request is too large");

        if(!await getProject(request.projectId))throw new Error("Project not found");

        if(request.conversationId){
          const conversation=await getConversation(request.conversationId);
          if(!conversation||conversation.projectId!==request.projectId)throw new Error("Conversation not found for project");
          const last=request.messages.at(-1);
          const storedLast=conversation.messages.at(-1);
          if(last?.role==="user"&&!(storedLast?.role==="user"&&storedLast.content===last.content)){
            await appendConversationMessages(request.conversationId,[last]);
          }
        }

        await runtime.run(request,event=>safeSend(event));
      }catch(error){
        safeSend({type:"error",error:error instanceof Error?error.message:String(error)});
      }finally{
        running=false;
      }
    });
  });
}
