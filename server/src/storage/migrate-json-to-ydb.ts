import { readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { initializeStorage, isYdbEnabled, ydbQuery, getTable, closeStorage } from "./ydb.js";
import { encryptSecret } from "./secret-crypto.js";
import type { ChatMessage } from "../types.js";

const root=process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");

function json<T>(value:string){return JSON.parse(value) as T;}
async function files(dir:string){
  try{return (await readdir(dir)).filter(name=>name.endsWith(".json"));}catch{return [];}
}

type User={id:string;email:string;passwordHash:string;createdAt:string};
type Session={id:string;userId:string;expiresAt:string;lastSeenAt?:string};
type Project={id:string;name:string;createdAt:string;updatedAt:string;github?:unknown;userId:string;node?:string};
type Conversation={id:string;projectId:string;title:string;messages:ChatMessage[];createdAt:string;updatedAt:string};
type Provider={provider:string;baseUrl:string;model:string;token?:string};
type GitHub={id:string;userId:string;accessToken:string;githubLogin?:string;createdAt:string};
type Yandex={userId:string;id:string;kind:string;secret:string;folderId?:string;cloudId?:string;account?:string;allowWrites:boolean;createdAt:string;updatedAt:string};
type Database={userId:string;id:string;provider:string;scheme:string;host:string;port:number;database:string;username:string;password:string;url:string;ssl:boolean;createdAt:string;updatedAt:string};
type ProjectSecrets={version:number;payload:string};
type SecretAudit={id:string;projectId:string;userId:string;action:string;names:string[];file:string;ipHash:string;createdAt:string};

async function main(){
  if(!isYdbEnabled()) throw new Error("Run with WEBNESTDEV_STORAGE=postgres and DATABASE_URL");
  await initializeStorage();
  const sql=ydbQuery();

  const usersFile=path.join(root,"auth","users.json");
  try{
    const users=json<User[]>(await readFile(usersFile,"utf8"));
    for(const u of users){
      await sql`UPSERT INTO ${sql.identifier(getTable("users"))} (id,email,password_hash,created_at) VALUES (${u.id},${u.email},${u.passwordHash},${u.createdAt})`;
    }
  }catch{}

  const sessionsFile=path.join(root,"auth","sessions.json");
  try{
    const sessions=json<Session[]>(await readFile(sessionsFile,"utf8"));
    for(const s of sessions){
      // Старые файлы не знают отметки активности: пустая строка читается как «отметки нет».
      await sql`UPSERT INTO ${sql.identifier(getTable("sessions"))} (id,user_id,expires_at,last_seen_at) VALUES (${s.id},${s.userId},${s.expiresAt},${s.lastSeenAt ?? ""})`;
    }
  }catch{}


  for(const name of await files(path.join(root,"projects"))){
    const p=json<Project>(await readFile(path.join(root,"projects",name),"utf8"));
    await sql`UPSERT INTO ${sql.identifier(getTable("projects"))} (id,name,created_at,updated_at,github_json,user_id,node) VALUES (${p.id},${p.name},${p.createdAt},${p.updatedAt},${p.github ? JSON.stringify(p.github) : ""},${p.userId},${p.node ?? ""})`;
  }

  for(const name of await files(path.join(root,"conversations"))){
    const c=json<Conversation>(await readFile(path.join(root,"conversations",name),"utf8"));
    await sql`UPSERT INTO ${sql.identifier(getTable("conversations"))} (id,project_id,title,messages_json,created_at,updated_at) VALUES (${c.id},${c.projectId},${c.title},${JSON.stringify(c.messages)},${c.createdAt},${c.updatedAt})`;
    for(let index=0;index<c.messages.length;index++){
      const message=c.messages[index];
      const createdAt=new Date(Date.parse(c.createdAt)+index).toISOString();
      await sql`UPSERT INTO ${sql.identifier(getTable("conversation_messages"))}
        (conversation_id,created_at,message_id,project_id,role,content,tool_calls_json,tool_call_id)
        VALUES (${c.id},${createdAt},${randomUUID()},${c.projectId},${message.role},${message.content},${message.role==="assistant"&&message.tool_calls ? JSON.stringify(message.tool_calls):""},${message.role==="tool" ? message.tool_call_id:""})
      `;
    }
  }

  // Секреты проектов — такой же зашифрованный payload, как подключения. Без этого шага
  // переезд на PostgreSQL оставил бы их в JSON-файлах, а сервер искал бы их в таблице.
  for(const name of await files(path.join(root,"project-secrets"))){
    const s=json<ProjectSecrets>(await readFile(path.join(root,"project-secrets",name),"utf8"));
    if(!s.payload) continue;
    await sql`UPSERT INTO ${sql.identifier(getTable("project_secrets"))}
      (project_id,payload,updated_at)
      VALUES (${name.slice(0,-5)},${encryptSecret(s.payload)},${new Date().toISOString()})
    `;
  }

  // Журнал аудита — JSONL, а не один JSON: каждая строка переносится отдельно.
  try{
    const raw=await readFile(path.join(root,"secret-audit.jsonl"),"utf8");
    for(const line of raw.split("\n")){
      if(!line.trim()) continue;
      const entry=json<SecretAudit>(line);
      await sql`UPSERT INTO ${sql.identifier(getTable("secret_audit"))}
        (id,project_id,user_id,action,names_json,file,ip_hash,created_at)
        VALUES (${entry.id},${entry.projectId},${entry.userId},${entry.action},${JSON.stringify(entry.names ?? [])},${entry.file ?? ""},${entry.ipHash ?? ""},${entry.createdAt})
      `;
    }
  }catch{}

  for(const name of await files(path.join(root,"providers"))){
    const p=json<Provider>(await readFile(path.join(root,"providers",name),"utf8"));
    await sql`UPSERT INTO ${sql.identifier(getTable("providers"))} (project_id,provider,base_url,model,token) VALUES (${name.slice(0,-5)},${p.provider},${p.baseUrl},${p.model},${p.token ? encryptSecret(p.token) : ""})`;
  }

  for(const name of await files(path.join(root,"github"))){
    const g=json<GitHub>(await readFile(path.join(root,"github",name),"utf8"));
    await sql`UPSERT INTO ${sql.identifier(getTable("github_connections"))} (user_id,id,access_token,github_login,created_at) VALUES (${g.userId},${g.id},${encryptSecret(g.accessToken)},${g.githubLogin ?? ""},${g.createdAt})`;
  }

  for(const name of await files(path.join(root,"yandex"))){
    const y=json<Yandex>(await readFile(path.join(root,"yandex",name),"utf8"));
    await sql`UPSERT INTO ${sql.identifier(getTable("yandex_connections"))}
      (user_id,id,kind,secret,folder_id,cloud_id,account,allow_writes,created_at,updated_at)
      VALUES (${y.userId},${y.id},${y.kind},${encryptSecret(y.secret)},${y.folderId ?? ""},${y.cloudId ?? ""},${y.account ?? ""},${y.allowWrites},${y.createdAt},${y.updatedAt})`;
  }

  for(const name of await files(path.join(root,"database"))){
    const d=json<Database>(await readFile(path.join(root,"database",name),"utf8"));
    await sql`UPSERT INTO ${sql.identifier(getTable("database_connections"))}
      (user_id,id,provider,scheme,host,port,database_name,username,password,url,ssl,created_at,updated_at)
      VALUES (${d.userId},${d.id},${d.provider},${d.scheme},${d.host},${d.port},${d.database},${d.username},${encryptSecret(d.password)},${encryptSecret(d.url)},${d.ssl},${d.createdAt},${d.updatedAt})`;
  }

  console.log("JSON → PostgreSQL migration completed");
  await closeStorage();
}
main().catch(async error=>{console.error(error);await closeStorage().catch(()=>undefined);process.exitCode=1;});
