import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage } from "./types.js";
import { isYdbEnabled, ydbQuery, getTable } from "./storage/ydb.js";

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
    const [rows]=await ydbQuery()<Array<{id:string;name:string;created_at:string;updated_at:string;github_json:string;user_id:string}>>\`
      SELECT id,name,created_at,updated_at,github_json,user_id
      FROM \${ydbQuery().identifier(getTable("projects"))}
      WHERE id = \${projectId}
      LIMIT 1
    \`;
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
    const [rows]=await ydbQuery()<Array<{id:string;name:string;created_at:string;updated_at:string;github_json:string;user_id:string}>>\`
      SELECT id,name,created_at,updated_at,github_json,user_id
      FROM \${ydbQuery().identifier(getTable("projects"))}
      WHERE user_id = \${userId}
      ORDER BY updated_at DESC
    \`;
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

export async function createProject(name:string,github:GitHubRepositoryRef|undefined,userId:string):Promise<Project>{
  const now=new Date().toISOString();
  const project={id:randomUUID(),name:name.trim()||"Новый проект",github,userId,createdAt:now,updatedAt:now};
  if(isYdbEnabled()){
    await ydbQuery()\`
      INSERT INTO \${ydbQuery().identifier(getTable("projects"))}
        (id,name,created_at,updated_at,github_json,user_id)
      VALUES (\${project.id},\${project.name},\${project.createdAt},\${project.updatedAt},\${project.github ? JSON.stringify(project.github) : ""},\${project.userId})
    \`;
    return project;
  }
  await mkdir(path.join(root,"projects"),{recursive:true});
  await writeFile(path.join(root,"projects",project.id+".json"),JSON.stringify(project,null,2));
  return project;
}

export async function getProjectProvider(projectId:string):Promise<ProjectProviderConfig|null>{
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{project_id:string;provider:string;base_url:string;model:string;token:string}>>\`
      SELECT project_id,provider,base_url,model,token
      FROM \${ydbQuery().identifier(getTable("providers"))}
      WHERE project_id = \${projectId}
      LIMIT 1
    \`;
    const row=rows?.[0];
    if(!row)return null;
    return {provider:row.provider,baseUrl:row.base_url,model:row.model,...(row.token ? {token:row.token} : {})};
  }
  try{return JSON.parse(await readFile(path.join(root,"providers",projectId+".json"),"utf8")) as ProjectProviderConfig}catch{return null}
}

export async function saveProjectProvider(projectId:string,config:ProjectProviderConfig){
  if(!await getProject(projectId))throw new Error("Project not found");
  if(isYdbEnabled()){
    await ydbQuery()\`
      UPSERT INTO \${ydbQuery().identifier(getTable("providers"))}
        (project_id,provider,base_url,model,token)
      VALUES (\${projectId},\${config.provider},\${config.baseUrl},\${config.model},\${config.token ?? ""})
    \`;
    return config;
  }
  await mkdir(path.join(root,"providers"),{recursive:true});
  await writeFile(path.join(root,"providers",projectId+".json"),JSON.stringify(config,null,2),{mode:0o600});
  return config;
}

async function conversationsDir(){const d=path.join(root,"conversations");await mkdir(d,{recursive:true});return d}

export async function createConversation(projectId:string,title="Новая сессия"){
  if(!await getProject(projectId))throw new Error("Project not found");
  const now=new Date().toISOString();
  const c:Conversation={id:randomUUID(),projectId,title:title.trim()||"Новая сессия",messages:[],createdAt:now,updatedAt:now};
  if(isYdbEnabled()){
    await ydbQuery()\`
      INSERT INTO \${ydbQuery().identifier(getTable("conversations"))}
        (id,project_id,title,messages_json,created_at,updated_at)
      VALUES (\${c.id},\${c.projectId},\${c.title},\${JSON.stringify(c.messages)},\${c.createdAt},\${c.updatedAt})
    \`;
    return c;
  }
  await writeFile(path.join(await conversationsDir(),c.id+".json"),JSON.stringify(c,null,2));
  return c;
}

export async function getConversation(id:string):Promise<Conversation|null>{
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{id:string;project_id:string;title:string;messages_json:string;created_at:string;updated_at:string}>>\`
      SELECT id,project_id,title,messages_json,created_at,updated_at
      FROM \${ydbQuery().identifier(getTable("conversations"))}
      WHERE id = \${id}
      LIMIT 1
    \`;
    const row=rows?.[0];
    if(!row)return null;
    return {id:row.id,projectId:row.project_id,title:row.title,messages:JSON.parse(row.messages_json) as ChatMessage[],createdAt:row.created_at,updatedAt:row.updated_at};
  }
  try{return JSON.parse(await readFile(path.join(root,"conversations",id+".json"),"utf8")) as Conversation}catch{return null}
}

export async function listConversations(projectId:string){
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{id:string;project_id:string;title:string;messages_json:string;created_at:string;updated_at:string}>>\`
      SELECT id,project_id,title,messages_json,created_at,updated_at
      FROM \${ydbQuery().identifier(getTable("conversations"))}
      WHERE project_id = \${projectId}
      ORDER BY updated_at DESC
    \`;
    return rows.map(row=>({id:row.id,projectId:row.project_id,title:row.title,messages:JSON.parse(row.messages_json) as ChatMessage[],createdAt:row.created_at,updatedAt:row.updated_at}));
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
    await ydbQuery()\`
      UPDATE \${ydbQuery().identifier(getTable("conversations"))}
      SET messages_json=\${JSON.stringify(c.messages)},updated_at=\${c.updatedAt}
      WHERE id=\${id}
    \`;
    return c;
  }
  await writeFile(path.join(root,"conversations",id+".json"),JSON.stringify(c,null,2));
  return c;
}
