import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentRuntime } from "../agent-runtime.js";
import { getConversation,appendConversationMessages } from "../project-store.js";

const messageSchema=z.discriminatedUnion("role",[
  z.object({role:z.literal("user"),content:z.string()}),
  z.object({role:z.literal("system"),content:z.string()}),
  z.object({role:z.literal("assistant"),content:z.string(),tool_calls:z.array(z.object({id:z.string(),name:z.string(),arguments:z.record(z.unknown())})).optional()}),
  z.object({role:z.literal("tool"),content:z.string(),tool_call_id:z.string()})
]);
const runSchema=z.object({projectId:z.string().min(1),conversationId:z.string().optional(),messages:z.array(messageSchema).min(1),model:z.string().optional()});

export async function registerAgentWebSocket(app:FastifyInstance,runtime=new AgentRuntime()){
  app.get("/ws",{websocket:true},(socket)=>{
    socket.on("message",async raw=>{
      try{
        const message=JSON.parse(raw.toString()) as {type?:string;request?:unknown};
        if(message.type!=="agent.run"){socket.send(JSON.stringify({type:"error",error:"Unknown websocket message type"}));return}
        const request=runSchema.parse(message.request);
        if(request.conversationId){
          const conversation=await getConversation(request.conversationId);
          if(!conversation||conversation.projectId!==request.projectId)throw new Error("Conversation not found for project");
          const last=request.messages.at(-1);
          if(last?.role==="user")await appendConversationMessages(request.conversationId,[last]);
        }
        await runtime.run(request,event=>socket.send(JSON.stringify(event)));
      }catch(error){
        socket.send(JSON.stringify({type:"error",error:error instanceof Error?error.message:String(error)}));
      }
    });
  });
}
