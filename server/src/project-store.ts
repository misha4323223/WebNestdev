import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage } from "./types.js";
import { isYdbEnabled, ydbQuery, getTable } from "./storage/ydb.js";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "./storage/secret-crypto.js";

export type GitHubRepositoryRef = {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  url: string;
};

export type Project = {
  id:string;
  name:string;
  createdAt:string;
  updatedAt:string;
  github?:GitHubRepositoryRef;
  userId: string;
};
export type Conversation = { id:string; projectId:string; title:string; messages:ChatMessage[]; createdAt:string; updatedAt:string };
export type ProjectProviderConfig = { provider:string; baseUrl:string; model:string; token?:string };
const root=process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");

export async function ensureDataDir(){await mkdir(root,{recursive:true})}

export async function getProject(projectId:string):Promise<Project|null>{
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{id:string;name:string;created_at:string;updated_at:string;github_json:string;user_id:string}>>`
      SELECT id,name,created_at,updated_at,github_json,user_id
      FROM ${ydbQuery().identifier(getTable("projects"))}
      WHERE id = ${projectId}
      LIMIT 1
    `;
    const row=rows?.[0];
    if(!row)return null;
    return {
      id:row.id,name:row.name,createdAt:row.created_at,updatedAt:row.updated_at,userId:row.user_id,
      ...(row.github_json ? {github:JSON.parse(row.github_json) as GitHubRepositoryRef} : {})
    };
  }
  try{return JSON.parse(await readFile(path.join(root,"projects",projectId+".json"),"utf8")) as Project}catch{return null}
}

export async function listProjects(userId:string){
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{id:string;name:string;created_at:string;updated_at:string;github_json:string;user_id:string}>>`
      SELECT id,name,created_at,updated_at,github_json,user_id
      FROM ${ydbQuery().identifier(getTable("projects"))}
      WHERE user_id = ${userId}
      ORDER BY updated_at DESC
    `;
    return rows.map(row=>({
      id:row.id,name:row.name,createdAt:row.created_at,updatedAt:row.updated_at,userId:row.user_id,
      ...(row.github_json ? {github:JSON.parse(row.github_json) as GitHubRepositoryRef} : {})
    }));
  }
  const result:Project[]=[];
  try{
    await mkdir(path.join(root,"projects"),{recursive:true});
    for(const n of await readdir(path.join(root,"projects"))){
      if(!n.endsWith(".json"))continue;
      try{
        const p=JSON.parse(await readFile(path.join(root,"projects",n),"utf8")) as Project;
        if(p.userId===userId)result.push(p);
      }catch{}
    }
  }catch{}
  return result.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
}

function newProject(name:string,github:GitHubRepositoryRef|undefined,userId:string):Project{
  const now=new Date().toISOString();
  return {id:randomUUID(),name:name.trim()||"Новый проект",github,userId,createdAt:now,updatedAt:now};
}
async function persistProject(project:Project){
  if(isYdbEnabled()){
    await ydbQuery()`
      INSERT INTO ${ydbQuery().identifier(getTable("projects"))}
        (id,name,created_at,updated_at,github_json,user_id)
      VALUES (${project.id},${project.name},${project.createdAt},${project.updatedAt},${project.github ? JSON.stringify(project.github) : ""},${project.userId})
    `;
    return project;
  }
  await mkdir(path.join(root,"projects"),{recursive:true});
  await writeFile(path.join(root,"projects",project.id+".json"),JSON.stringify(project,null,2),{flag:"wx"});
  return project;
}
export async function createProject(name:string,github:GitHubRepositoryRef|undefined,userId:string):Promise<Project>{
  return persistProject(newProject(name,github,userId));
}

export class ProjectLimitError extends Error{
  readonly statusCode=403;
  constructor(readonly limit:number,readonly used:number){
    super("Project limit reached");
    this.name="ProjectLimitError";
  }
}
const projectLocks=new Map<string,Promise<unknown>>();
async function withProjectLock<T>(userId:string,action:()=>Promise<T>):Promise<T>{
  const previous=projectLocks.get(userId)??Promise.resolve();
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve});
  const current=previous.then(()=>gate);
  projectLocks.set(userId,current);
  await previous;
  try{return await action()}
  finally{release();if(projectLocks.get(userId)===current)projectLocks.delete(userId)}
}
export async function createProjectWithinLimit(name:string,github:GitHubRepositoryRef|undefined,userId:string,limit:number):Promise<Project>{
  const project=newProject(name,github,userId);
  if(isYdbEnabled()){
    const sql=ydbQuery();
    const projectCountersTable=sql.identifier(getTable("project_counters"));
    const projectsTable=sql.identifier(getTable("projects"));
    await sql.transaction({idempotent:true},async tx=>{
      const [counterRows]=await tx<Array<{project_count:number|string|bigint}>>`
        SELECT project_count FROM ${projectCountersTable}
        WHERE user_id=${userId} LIMIT 1
      `;
      let used:number;
      if(counterRows[0]){
        used=Number(counterRows[0].project_count);
      }else{
        const [countRows]=await tx<Array<{project_count:number|string|bigint}>>`
          SELECT COUNT(*) AS project_count FROM ${projectsTable}
          WHERE user_id=${userId}
        `;
        used=Number(countRows[0]?.project_count??0);
      }
      if(used>=limit)throw new ProjectLimitError(limit,used);
      await tx`
        UPSERT INTO ${projectCountersTable}(user_id,project_count)
        VALUES(${userId},${used+1})
      `;
      await tx`
        INSERT INTO ${projectsTable}
          (id,name,created_at,updated_at,github_json,user_id)
        VALUES (${project.id},${project.name},${project.createdAt},${project.updatedAt},${project.github?JSON.stringify(project.github):""},${project.userId})
      `;
    });
    return project;
  }
  return withProjectLock(userId,async()=>{
    const projects=await listProjects(userId);
    if(projects.length>=limit)throw new ProjectLimitError(limit,projects.length);
    return persistProject(project);
  });
}

async function writeSecretJsonAtomic(file:string,value:unknown){
  await mkdir(path.dirname(file),{recursive:true});
  const temp=file+"."+randomUUID()+".tmp";
  try { await writeFile(temp,JSON.stringify(value,null,2),{mode:0o600}); await rename(temp,file); }
  catch(error){ try{await unlink(temp)}catch{} throw error; }
}

export async function getProjectProvider(projectId:string):Promise<ProjectProviderConfig|null>{
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{project_id:string;provider:string;base_url:string;model:string;token:string}>>`
      SELECT project_id,provider,base_url,model,token
      FROM ${ydbQuery().identifier(getTable("providers"))}
      WHERE project_id = ${projectId}
      LIMIT 1
    `;
    const row=rows?.[0];
    if(!row)return null;
    let token=row.token || undefined;
    if(token && !isEncryptedSecret(token)){
      const plaintext=token;
      token=encryptSecret(token);
      await ydbQuery()`
        UPSERT INTO ${ydbQuery().identifier(getTable("providers"))}
          (project_id,provider,base_url,model,token)
        VALUES (${projectId},${row.provider},${row.base_url},${row.model},${token})
      `;
      token=plaintext;
    } else if(token) token=decryptSecret(token);
    return {provider:row.provider,baseUrl:row.base_url,model:row.model,...(token ? {token} : {})};
  }
  const file=path.join(root,"providers",projectId+".json");
  try{
    const config=JSON.parse(await readFile(file,"utf8")) as ProjectProviderConfig;
    if(!config.token)return config;
    if(!isEncryptedSecret(config.token)){
      const plaintext=config.token;
      await writeSecretJsonAtomic(file,{...config,token:encryptSecret(plaintext)});
      return {...config,token:plaintext};
    }
    return {...config,token:decryptSecret(config.token)};
  }catch(error){
    if((error as NodeJS.ErrnoException).code==="ENOENT")return null;
    throw error;
  }
}

export async function saveProjectProvider(projectId:string,config:ProjectProviderConfig){
  if(!await getProject(projectId))throw new Error("Project not found");
  const token=config.token ? encryptSecret(config.token) : "";
  if(isYdbEnabled()){
    await ydbQuery()`
      UPSERT INTO ${ydbQuery().identifier(getTable("providers"))}
        (project_id,provider,base_url,model,token)
      VALUES (${projectId},${config.provider},${config.baseUrl},${config.model},${token})
    `;
    return config;
  }
  const persisted={...config,...(config.token ? {token} : {})};
  await writeSecretJsonAtomic(path.join(root,"providers",projectId+".json"),persisted);
  return config;
}

async function conversationsDir(){const d=path.join(root,"conversations");await mkdir(d,{recursive:true});return d}

function messageFromRow(row:{created_at:string;message_id:string;role:string;content:string;tool_calls_json:string;tool_call_id:string}):ChatMessage{
  const base={role:row.role as ChatMessage["role"],content:row.content};
  if(row.role==="assistant"){
    return {...base,role:"assistant",...(row.tool_calls_json ? {tool_calls:JSON.parse(row.tool_calls_json) as Extract<ChatMessage,{role:"assistant"}>["tool_calls"]}: {})} as ChatMessage;
  }
  if(row.role==="tool")return {...base,role:"tool",tool_call_id:row.tool_call_id};
  return {...base,role:row.role as "user"|"system"};
}
function messageRow(projectId:string,conversationId:string,message:ChatMessage,createdAt:string){
  return {
    conversationId,projectId,messageId:randomUUID(),createdAt,
    role:message.role,content:message.content,
    toolCallsJson:message.role==="assistant"&&message.tool_calls ? JSON.stringify(message.tool_calls):"",
    toolCallId:message.role==="tool" ? message.tool_call_id:""
  };
}

export async function createConversation(projectId:string,title="Новая сессия"){
  if(!await getProject(projectId))throw new Error("Project not found");
  const now=new Date().toISOString();
  const c:Conversation={id:randomUUID(),projectId,title:title.trim()||"Новая сессия",messages:[],createdAt:now,updatedAt:now};
  if(isYdbEnabled()){
    await ydbQuery()`
      INSERT INTO ${ydbQuery().identifier(getTable("conversations"))}
        (id,project_id,title,messages_json,created_at,updated_at)
      VALUES (${c.id},${c.projectId},${c.title},"",${c.createdAt},${c.updatedAt})
    `;
    return c;
  }
  await writeFile(path.join(await conversationsDir(),c.id+".json"),JSON.stringify(c,null,2));
  return c;
}

export async function getConversation(id:string):Promise<Conversation|null>{
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{id:string;project_id:string;title:string;messages_json:string;created_at:string;updated_at:string}>>`
      SELECT id,project_id,title,messages_json,created_at,updated_at
      FROM ${ydbQuery().identifier(getTable("conversations"))}
      WHERE id = ${id}
      LIMIT 1
    `;
    const row=rows?.[0];
    if(!row)return null;
    const [messageRows]=await ydbQuery()<Array<{created_at:string;message_id:string;role:string;content:string;tool_calls_json:string;tool_call_id:string}>>`
      SELECT created_at,message_id,role,content,tool_calls_json,tool_call_id
      FROM ${ydbQuery().identifier(getTable("conversation_messages"))}
      WHERE conversation_id = ${id}
      ORDER BY created_at,message_id
    `;
    const messages=messageRows.length ? messageRows.map(messageFromRow) : JSON.parse(row.messages_json || "[]") as ChatMessage[];
    return {id:row.id,projectId:row.project_id,title:row.title,messages,createdAt:row.created_at,updatedAt:row.updated_at};
  }
  try{return JSON.parse(await readFile(path.join(root,"conversations",id+".json"),"utf8")) as Conversation}catch{return null}
}

export async function listConversations(projectId:string){
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{id:string;project_id:string;title:string;messages_json:string;created_at:string;updated_at:string}>>`
      SELECT id,project_id,title,messages_json,created_at,updated_at
      FROM ${ydbQuery().identifier(getTable("conversations"))}
      WHERE project_id = ${projectId}
      ORDER BY updated_at DESC
    `;
    const result=rows.map(row=>({id:row.id,projectId:row.project_id,title:row.title,messages:[] as ChatMessage[],createdAt:row.created_at,updatedAt:row.updated_at}));
    const [messageRows]=await ydbQuery()<Array<{conversation_id:string;created_at:string;message_id:string;role:string;content:string;tool_calls_json:string;tool_call_id:string}>>`
      SELECT conversation_id,created_at,message_id,role,content,tool_calls_json,tool_call_id
      FROM ${ydbQuery().identifier(getTable("conversation_messages"))}
      WHERE project_id = ${projectId}
      ORDER BY created_at,message_id
    `;
    const byId=new Map(result.map(item=>[item.id,item]));
    for(const row of messageRows)byId.get(row.conversation_id)?.messages.push(messageFromRow(row));
    for(const item of result){
      if(item.messages.length===0 && rows.find(row=>row.id===item.id)?.messages_json) item.messages=JSON.parse(rows.find(row=>row.id===item.id)?.messages_json ?? "[]") as ChatMessage[];
    }
    return result;
  }
  const result:Conversation[]=[];
  try{
    for(const n of await readdir(await conversationsDir())){
      if(!n.endsWith(".json"))continue;
      const c=await getConversation(n.slice(0,-5));
      if(c?.projectId===projectId)result.push(c);
    }
  }catch{}
  return result.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
}

export async function appendConversationMessages(id:string,messages:ChatMessage[]){
  const c=await getConversation(id);
  if(!c)throw new Error("Conversation not found");
  c.messages.push(...messages);
  c.updatedAt=new Date().toISOString();
  if(isYdbEnabled()){
    const projectId=c.projectId;
    const now=Date.now();
    for(let index=0;index<messages.length;index++){
      const row=messageRow(projectId,id,messages[index],new Date(now+index).toISOString());
      await ydbQuery()`
        UPSERT INTO ${ydbQuery().identifier(getTable("conversation_messages"))}
          (conversation_id,created_at,message_id,project_id,role,content,tool_calls_json,tool_call_id)
        VALUES (${row.conversationId},${row.createdAt},${row.messageId},${row.projectId},${row.role},${row.content},${row.toolCallsJson},${row.toolCallId})
      `;
    }
    await ydbQuery()`
      UPDATE ${ydbQuery().identifier(getTable("conversations"))}
      SET updated_at=${c.updatedAt}
      WHERE id=${id}
    `;
    return c;
  }
  await writeFile(path.join(root,"conversations",id+".json"),JSON.stringify(c,null,2));
  return c;
}
