import type { FastifyInstance } from "fastify";
import { sandboxStatus } from "../docker-sandbox.js";
import { isYdbEnabled, ydbQuery } from "../storage/ydb.js";

export async function registerHealthRoutes(app:FastifyInstance){
  app.get("/api/health",async()=>{
    const sandbox=await sandboxStatus();
    let storage:{mode:"json"|"ydb";ok:boolean}={mode:isYdbEnabled()?"ydb":"json",ok:true};
    if(isYdbEnabled()){
      try{
        await ydbQuery()\`SELECT 1 AS ok\`;
      }catch{
        storage={mode:"ydb",ok:false};
      }
    }
    return {ok:storage.ok && sandbox.available,service:"webnestdev-server",storage,sandbox};
  });
  app.get("/api/sandbox/status",async()=>sandboxStatus());
}
