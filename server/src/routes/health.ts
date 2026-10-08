import type { FastifyInstance } from "fastify";
import { sandboxStatus } from "../docker-sandbox.js";
import { isYdbEnabled, ydbQuery } from "../storage/ydb.js";

async function dependencyStatus(){
  const sandbox=await sandboxStatus();
  let storage:{mode:"json"|"ydb";ok:boolean}={mode:isYdbEnabled()?"ydb":"json",ok:true};
  if(isYdbEnabled()){
    try{await ydbQuery()`SELECT 1 AS ok`;}catch{storage={mode:"ydb",ok:false};}
  }
  return {storage,sandbox};
}

export async function registerHealthRoutes(app:FastifyInstance){
  app.get("/api/health",async()=>({
    ok:true,
    service:"webnestdev-server",
    ...(await dependencyStatus())
  }));
  app.get("/api/ready",async(_request,reply)=>{
    const dependencies=await dependencyStatus();
    const ok=dependencies.storage.ok && dependencies.sandbox.available;
    return reply.code(ok?200:503).send({ok,service:"webnestdev-server",...dependencies});
  });
  app.get("/api/sandbox/status",async()=>sandboxStatus());
}
