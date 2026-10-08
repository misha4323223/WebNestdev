import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { initializeStorage, isYdbEnabled, ydbQuery, getTable, closeStorage } from "./ydb.js";

const root=process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");

function json<T>(value:string){return JSON.parse(value) as T;}
async function files(dir:string){
  try{return (await readdir(dir)).filter(name=>name.endsWith(".json"));}catch{return [];}
}

type User={id:string;email:string;passwordHash:string;createdAt:string};
type Session={id:string;userId:string;expiresAt:string};
type Project={id:string;name:string;createdAt:string;updatedAt:string;github?:unknown;userId:string};
type Conversation={id:string;projectId:string;title:string;messages:unknown[];createdAt:string;updatedAt:string};
type Provider={provider:string;baseUrl:string;model:string;token?:string};
type GitHub={id:string;userId:string;accessToken:string;githubLogin?:string;createdAt:string};

async function main(){
  if(!isYdbEnabled()) throw new Error("Run with WEBNESTDEV_STORAGE=ydb");
  await initializeStorage();
  const sql=ydbQuery();

  const usersFile=path.join(root,"auth","users.json");
  try{
    const users=json<User[]>(await readFile(usersFile,"utf8"));
    for(const u of users){
      await sql\`UPSERT INTO \${sql.identifier(getTable("users"))} (id,email,password_hash,created_at) VALUES (\${u.id},\${u.email},\${u.passwordHash},\${u.createdAt})\`;
    }
  }catch{}

  const sessionsFile=path.join(root,"auth","sessions.json");
  try{
    const sessions=json<Session[]>(await readFile(sessionsFile,"utf8"));
    for(const s of sessions){
      await sql\`UPSERT INTO \${sql.identifier(getTable("sessions"))} (id,user_id,expires_at) VALUES (\${s.id},\${s.userId},\${s.expiresAt})\`;
    }
  }catch{}


  for(const name of await files(path.join(root,"projects"))){
    const p=json<Project>(await readFile(path.join(root,"projects",name),"utf8"));
    await sql\`UPSERT INTO \${sql.identifier(getTable("projects"))} (id,name,created_at,updated_at,github_json,user_id) VALUES (\${p.id},\${p.name},\${p.createdAt},\${p.updatedAt},\${p.github ? JSON.stringify(p.github) : ""},\${p.userId})\`;
  }

  for(const name of await files(path.join(root,"conversations"))){
    const c=json<Conversation>(await readFile(path.join(root,"conversations",name),"utf8"));
    await sql\`UPSERT INTO \${sql.identifier(getTable("conversations"))} (id,project_id,title,messages_json,created_at,updated_at) VALUES (\${c.id},\${c.projectId},\${c.title},\${JSON.stringify(c.messages)},\${c.createdAt},\${c.updatedAt})\`;
  }

  for(const name of await files(path.join(root,"providers"))){
    const p=json<Provider>(await readFile(path.join(root,"providers",name),"utf8"));
    await sql\`UPSERT INTO \${sql.identifier(getTable("providers"))} (project_id,provider,base_url,model,token) VALUES (\${name.slice(0,-5)},\${p.provider},\${p.baseUrl},\${p.model},\${p.token ?? ""})\`;
  }

  for(const name of await files(path.join(root,"github"))){
    const g=json<GitHub>(await readFile(path.join(root,"github",name),"utf8"));
    await sql\`UPSERT INTO \${sql.identifier(getTable("github_connections"))} (user_id,id,access_token,github_login,created_at) VALUES (\${g.userId},\${g.id},\${g.accessToken},\${g.githubLogin ?? ""},\${g.createdAt})\`;
  }

  console.log("JSON → YDB migration completed");
  await closeStorage();
}
main().catch(async error=>{console.error(error);await closeStorage().catch(()=>undefined);process.exitCode=1;});
