import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { sandboxRootPath } from "./sandbox/config.js";
import type { ChatMessage, PlanState } from "./types.js";
import { isYdbEnabled, ydbQuery, getTable } from "./storage/ydb.js";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "./storage/secret-crypto.js";

export type RepositoryProvider = "github" | "gitlab";
export type GitHubRepositoryRef = {
  /** Старые записи без поля — это GitHub; GitLab появился позже. */
  provider?: RepositoryProvider;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  url: string;
  /** Адрес для git clone/push, когда он отличается от ссылки в браузере (GitLab). */
  cloneUrl?: string;
};

export type Project = {
  id:string;
  name:string;
  createdAt:string;
  updatedAt:string;
  github?:GitHubRepositoryRef;
  userId: string;
};
export type Conversation = { id:string; projectId:string; title:string; messages:ChatMessage[]; plan?:PlanState|null; createdAt:string; updatedAt:string };
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

/**
 * Все проекты без содержимого — только владение. Нужно сверке хранилища: она обходит диск и
 * должна знать, какому аккаунту принадлежит каталог, не загружая диалоги и секреты проектов.
 */
export type ProjectOwner = { id:string; name:string; userId:string; updatedAt:string };

export async function listProjectOwners():Promise<ProjectOwner[]>{
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{id:string;name:string;user_id:string;updated_at:string}>>`
      SELECT id,name,user_id,updated_at
      FROM ${ydbQuery().identifier(getTable("projects"))}
    `;
    return rows.map(row=>({id:row.id,name:row.name,userId:row.user_id,updatedAt:row.updated_at}));
  }
  const result:ProjectOwner[]=[];
  try{
    for(const name of await readdir(path.join(root,"projects"))){
      if(!name.endsWith(".json"))continue;
      try{
        const project=JSON.parse(await readFile(path.join(root,"projects",name),"utf8")) as Project;
        if(!project?.id||!project.userId)continue;
        result.push({id:project.id,name:project.name,userId:project.userId,updatedAt:project.updatedAt});
      }catch{}
    }
  }catch{}
  return result;
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
    super("Достигнут лимит проектов");
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

/**
 * Deletes a project together with everything that belongs to it: conversations,
 * provider credentials and the sandbox directory. Returns false when the project
 * does not exist or belongs to another account.
 */
export async function deleteProject(projectId:string,userId:string):Promise<boolean>{
  const project=await getProject(projectId);
  if(!project||project.userId!==userId)return false;
  if(isYdbEnabled()){
    const sql=ydbQuery();
    await sql.transaction({idempotent:true},async tx=>{
      await tx`DELETE FROM ${sql.identifier(getTable("conversation_messages"))} WHERE project_id=${projectId}`;
      await tx`DELETE FROM ${sql.identifier(getTable("conversations"))} WHERE project_id=${projectId}`;
      await tx`DELETE FROM ${sql.identifier(getTable("providers"))} WHERE project_id=${projectId}`;
      await tx`DELETE FROM ${sql.identifier(getTable("projects"))} WHERE id=${projectId}`;
      await tx`UPDATE ${sql.identifier(getTable("project_counters"))} SET project_count=CASE WHEN project_count>0 THEN project_count-1 ELSE 0 END WHERE user_id=${userId}`;
    });
  }else{
    await rm(path.join(root,"projects",projectId+".json"),{force:true});
    await rm(path.join(root,"providers",projectId+".json"),{force:true});
    const conversations=path.join(root,"conversations");
    try{
      for(const name of await readdir(conversations)){
        if(!name.endsWith(".json"))continue;
        const file=path.join(conversations,name);
        try{
          const conversation=JSON.parse(await readFile(file,"utf8")) as Conversation;
          if(conversation.projectId===projectId)await rm(file,{force:true});
        }catch{}
      }
    }catch{}
  }
  await rm(sandboxRootPath(projectId),{recursive:true,force:true});
  return true;
}

/**
 * Привязывает проект к репозиторию GitHub. Так проект, созданный в приложении, получает
 * место, куда «Изменения» отправляют коммиты.
 */
export async function linkProjectGithub(projectId:string,userId:string,github:GitHubRepositoryRef):Promise<Project|null>{
  const project=await getProject(projectId);
  if(!project||project.userId!==userId)return null;
  const updated:Project={...project,github,updatedAt:new Date().toISOString()};
  if(isYdbEnabled()){
    await ydbQuery()`
      UPDATE ${ydbQuery().identifier(getTable("projects"))}
      SET github_json=${JSON.stringify(github)},updated_at=${updated.updatedAt}
      WHERE id=${projectId}
    `;
    return updated;
  }
  await mkdir(path.join(root,"projects"),{recursive:true});
  await writeFile(path.join(root,"projects",projectId+".json"),JSON.stringify(updated,null,2));
  return updated;
}

/**
 * Renames a project and bumps its updated time. Returns null when the project is
 * missing or belongs to another account.
 */
export async function renameProject(projectId:string,userId:string,name:string):Promise<Project|null>{
  const project=await getProject(projectId);
  if(!project||project.userId!==userId)return null;
  const nextName=name.trim().slice(0,120)||project.name;
  const updated:Project={...project,name:nextName,updatedAt:new Date().toISOString()};
  if(isYdbEnabled()){
    await ydbQuery()`
      UPDATE ${ydbQuery().identifier(getTable("projects"))}
      SET name=${updated.name},updated_at=${updated.updatedAt}
      WHERE id=${projectId}
    `;
    return updated;
  }
  await mkdir(path.join(root,"projects"),{recursive:true});
  await writeFile(path.join(root,"projects",projectId+".json"),JSON.stringify(updated,null,2));
  return updated;
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
  if(!await getProject(projectId))throw new Error("Проект не найден");
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

export async function removeProjectProvider(projectId:string){
  if(!await getProject(projectId))throw new Error("Проект не найден");
  if(isYdbEnabled()){
    await ydbQuery()`
      DELETE FROM ${ydbQuery().identifier(getTable("providers"))}
      WHERE project_id=${projectId}
    `;
    return;
  }
  await rm(path.join(root,"providers",projectId+".json"),{force:true});
}

async function conversationsDir(){const d=path.join(root,"conversations");await mkdir(d,{recursive:true});return d}

function messageFromRow(row:{created_at:string;message_id:string;role:string;content:string;tool_calls_json:string;tool_call_id:string;reasoning?:string}):ChatMessage{
  const base={role:row.role as ChatMessage["role"],content:row.content};
  if(row.role==="assistant"){
    return {
      ...base,role:"assistant",
      ...(row.tool_calls_json ? {tool_calls:JSON.parse(row.tool_calls_json) as Extract<ChatMessage,{role:"assistant"}>["tool_calls"]}: {}),
      ...(row.reasoning ? {reasoning:row.reasoning}: {}),
    } as ChatMessage;
  }
  if(row.role==="tool")return {...base,role:"tool",tool_call_id:row.tool_call_id};
  return {...base,role:row.role as "user"|"system"};
}
/**
 * Tool output can be megabytes of logs, and a stored conversation is not a log archive:
 * the row keeps enough for the user to read what happened (and for the action list to
 * be rebuilt after a reload), while the model's own context keeps the full output.
 */
const MAX_STORED_TOOL_CHARS=8000;
/**
 * The chain of thought is read back in the panel after a reload, but it is not the work and it is not
 * sent to the provider again: a step of thinking can be tens of kilobytes, and a long chat would
 * carry every one of them in the database for good.
 */
const MAX_STORED_REASONING_CHARS=4000;
function clipStored(text:string,limit:number,label:string){
  return text.length<=limit?text:text.slice(0,limit)+'\n…['+label+']';
}
function boundMessage(message:ChatMessage):ChatMessage{
  if(message.role==="tool"){
    if(message.content.length<=MAX_STORED_TOOL_CHARS)return message;
    return {...message,content:clipStored(message.content,MAX_STORED_TOOL_CHARS,"вывод обрезан при сохранении")};
  }
  if(message.role!=="assistant")return message;
  const reasoning=message.reasoning&&message.reasoning.length>MAX_STORED_REASONING_CHARS
    ? clipStored(message.reasoning,MAX_STORED_REASONING_CHARS,"размышление обрезано при сохранении")
    : message.reasoning;
  if(reasoning===message.reasoning)return message;
  return {...message,reasoning};
}
function messageRow(projectId:string,conversationId:string,message:ChatMessage,createdAt:string){
  return {
    conversationId,projectId,messageId:randomUUID(),createdAt,
    role:message.role,content:message.content,
    toolCallsJson:message.role==="assistant"&&message.tool_calls ? JSON.stringify(message.tool_calls):"",
    reasoningJson:message.role==="assistant"&&message.reasoning ? message.reasoning:"",
    toolCallId:message.role==="tool" ? message.tool_call_id:""
  };
}

export async function createConversation(projectId:string,title="Новая сессия"){
  if(!await getProject(projectId))throw new Error("Проект не найден");
  const now=new Date().toISOString();
  const c:Conversation={id:randomUUID(),projectId,title:title.trim()||"Новая сессия",messages:[],createdAt:now,updatedAt:now};
  if(isYdbEnabled()){
    await ydbQuery()`
      INSERT INTO ${ydbQuery().identifier(getTable("conversations"))}
        (id,project_id,title,messages_json,plan_json,created_at,updated_at)
      VALUES (${c.id},${c.projectId},${c.title},"","",${c.createdAt},${c.updatedAt})
    `;
    return c;
  }
  await writeFile(path.join(await conversationsDir(),c.id+".json"),JSON.stringify(c,null,2));
  return c;
}

export async function getConversation(id:string):Promise<Conversation|null>{
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{id:string;project_id:string;title:string;messages_json:string;plan_json:string;created_at:string;updated_at:string}>>`
      SELECT id,project_id,title,messages_json,plan_json,created_at,updated_at
      FROM ${ydbQuery().identifier(getTable("conversations"))}
      WHERE id = ${id}
      LIMIT 1
    `;
    const row=rows?.[0];
    if(!row)return null;
    const [messageRows]=await ydbQuery()<Array<{created_at:string;message_id:string;role:string;content:string;tool_calls_json:string;tool_call_id:string;reasoning:string}>>`
      SELECT created_at,message_id,role,content,tool_calls_json,tool_call_id,reasoning
      FROM ${ydbQuery().identifier(getTable("conversation_messages"))}
      WHERE conversation_id = ${id}
      ORDER BY created_at,message_id
    `;
    const messages=messageRows.length ? messageRows.map(messageFromRow) : JSON.parse(row.messages_json || "[]") as ChatMessage[];
    return {id:row.id,projectId:row.project_id,title:row.title,messages,plan:row.plan_json ? JSON.parse(row.plan_json) as PlanState : null,createdAt:row.created_at,updatedAt:row.updated_at};
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

/**
 * Deletes one saved chat with its messages. The project stays: a chat is a working session,
 * not the project itself. Returns false when the chat is already gone, so the route can answer
 * 404 instead of claiming a deletion that did not happen.
 */
export async function deleteConversation(id:string):Promise<boolean>{
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{id:string}>>`
      SELECT id
      FROM ${ydbQuery().identifier(getTable("conversations"))}
      WHERE id = ${id}
      LIMIT 1
    `;
    if(!rows?.[0])return false;
    await ydbQuery().transaction({idempotent:true},async tx=>{
      await tx`DELETE FROM ${ydbQuery().identifier(getTable("conversation_messages"))} WHERE conversation_id=${id}`;
      await tx`DELETE FROM ${ydbQuery().identifier(getTable("conversations"))} WHERE id=${id}`;
    });
    return true;
  }
  const file=path.join(await conversationsDir(),id+".json");
  try{
    if(!(await stat(file)).isFile())return false;
  }catch{return false}
  await rm(file,{force:true});
  return true;
}

/**
 * The conversation row without its messages. A run appends a message per tool call, so the append
 * path must not read the chat it appends to: loading a session of a thousand messages to add one is
 * what made a long dialog pay for its own length on every step, and the messages are exactly the part
 * the append does not need. The JSON backend keeps a whole conversation in one file and has to
 * rewrite it anyway, so there the cheap read only saves the parse of what is about to be written.
 */
async function conversationMeta(id:string):Promise<{id:string;projectId:string}|null>{
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{id:string;project_id:string}>>`
      SELECT id,project_id
      FROM ${ydbQuery().identifier(getTable("conversations"))}
      WHERE id = ${id}
      LIMIT 1
    `;
    const row=rows?.[0];
    return row?{id:row.id,projectId:row.project_id}:null;
  }
  const c=await getConversation(id);
  return c?{id:c.id,projectId:c.projectId}:null;
}

/** What an append reports back: which conversation grew and by how much. */
export type AppendedConversation={id:string;projectId:string;updatedAt:string;appended:number};

/** Appends turns to a stored conversation. The value it returns is a receipt, not the chat. */
export async function appendConversationMessages(id:string,messages:ChatMessage[]):Promise<AppendedConversation>{
  // Bounding happens here, once, so both backends store the same readable copy.
  const bounded=messages.map(boundMessage);
  const updatedAt=new Date().toISOString();
  if(isYdbEnabled()){
    const meta=await conversationMeta(id);
    if(!meta)throw new Error("Сессия не найдена");
    const now=Date.now();
    for(let index=0;index<bounded.length;index++){
      const row=messageRow(meta.projectId,id,bounded[index],new Date(now+index).toISOString());
      await ydbQuery()`
        UPSERT INTO ${ydbQuery().identifier(getTable("conversation_messages"))}
          (conversation_id,created_at,message_id,project_id,role,content,tool_calls_json,reasoning,tool_call_id)
        VALUES (${row.conversationId},${row.createdAt},${row.messageId},${row.projectId},${row.role},${row.content},${row.toolCallsJson},${row.reasoningJson},${row.toolCallId})
      `;
    }
    await ydbQuery()`
      UPDATE ${ydbQuery().identifier(getTable("conversations"))}
      SET updated_at=${updatedAt}
      WHERE id=${id}
    `;
    return {id,projectId:meta.projectId,updatedAt,appended:bounded.length};
  }
  const c=await getConversation(id);
  if(!c)throw new Error("Сессия не найдена");
  c.messages.push(...bounded);
  c.updatedAt=updatedAt;
  await writeFile(path.join(await conversationsDir(),id+".json"),JSON.stringify(c,null,2));
  return {id,projectId:c.projectId,updatedAt,appended:bounded.length};
}

/**
 * The stored plan on its own: a resumed run needs the bookmark, not the chat it is written in, and a
 * long conversation is not worth loading to read one field. The JSON backend has no separate column,
 * so there the whole file is read anyway.
 */
export async function getConversationPlan(id:string):Promise<PlanState|undefined>{
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{plan_json:string}>>`
      SELECT plan_json
      FROM ${ydbQuery().identifier(getTable("conversations"))}
      WHERE id = ${id}
      LIMIT 1
    `;
    const value=rows?.[0]?.plan_json;
    return value?JSON.parse(value) as PlanState:undefined;
  }
  return (await getConversation(id))?.plan??undefined;
}

/**
 * The plan belongs to the conversation, not to the browser: it is what the user watches
 * during a long run, so it is stored with the messages and comes back after a reload.
 */
export async function saveConversationPlan(id:string,plan:PlanState){
  const updatedAt=new Date().toISOString();
  if(isYdbEnabled()){
    await ydbQuery()`
      UPDATE ${ydbQuery().identifier(getTable("conversations"))}
      SET plan_json=${JSON.stringify(plan)},updated_at=${updatedAt}
      WHERE id=${id}
    `;
    return plan;
  }
  const c=await getConversation(id);
  if(!c)throw new Error("Сессия не найдена");
  c.plan=plan;
  c.updatedAt=updatedAt;
  await writeFile(path.join(root,"conversations",id+".json"),JSON.stringify(c,null,2));
  return plan;
}
