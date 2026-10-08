import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage } from "./types.js";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "./security/secret-crypto.js";

export type GitHubRepositoryRef = { owner:string; name:string; fullName:string; defaultBranch:string; url:string };
export type Project = { id:string; name:string; createdAt:string; updatedAt:string; github?:GitHubRepositoryRef; userId:string };
export type Conversation = { id:string; projectId:string; title:string; messages:ChatMessage[]; createdAt:string; updatedAt:string };
export type ProjectProviderConfig = { provider:string; baseUrl:string; model:string; token?:string };
const root=process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");

async function writeJsonAtomic(file:string,value:unknown,mode=0o600){
  await mkdir(path.dirname(file),{recursive:true});
  const temp=file+"."+randomUUID()+".tmp";
  try { await writeFile(temp,JSON.stringify(value,null,2),{mode}); await rename(temp,file); }
  catch(error){ try { await import("node:fs/promises").then(fs=>fs.unlink(temp)); } catch {} throw error; }
}
export async function ensureDataDir(){await mkdir(root,{recursive:true})}
export async function getProject(projectId:string):Promise<Project|null>{try{return JSON.parse(await readFile(path.join(root,"projects",projectId+".json"),"utf8")) as Project}catch{return null}}
export async function listProjects(userId:string){const result:Project[]=[];try{await mkdir(path.join(root,"projects"),{recursive:true});for(const n of await (await import("node:fs/promises")).readdir(path.join(root,"projects"))){if(!n.endsWith(".json"))continue;try{const p=JSON.parse(await readFile(path.join(root,"projects",n),"utf8")) as Project;if(p.userId===userId)result.push(p)}catch{}}}catch{}return result.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
export async function createProject(name:string,github:GitHubRepositoryRef|undefined,userId:string):Promise<Project>{const project={id:randomUUID(),name:name.trim()||"Новый проект",github,userId,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};await writeJsonAtomic(path.join(root,"projects",project.id+".json"),project);return project}
export async function getProjectProvider(projectId:string):Promise<ProjectProviderConfig|null>{
  const file=path.join(root,"providers",projectId+".json");
  try {
    const config=JSON.parse(await readFile(file,"utf8")) as ProjectProviderConfig;
    if(config.token && !isEncryptedSecret(config.token)){
      // One-way, atomic migration: persist ciphertext before returning the legacy plaintext value.
      await writeJsonAtomic(file,{...config,token:encryptSecret(config.token)});
    }
    return config.token ? {...config,token:decryptSecret(config.token)} : config;
  } catch(error) {
    if((error as NodeJS.ErrnoException).code==="ENOENT") return null;
    throw error;
  }
}
export async function saveProjectProvider(projectId:string,config:ProjectProviderConfig){
  if(!await getProject(projectId))throw new Error("Project not found");
  const persisted={...config,...(config.token?{token:encryptSecret(config.token)}:{})};
  await writeJsonAtomic(path.join(root,"providers",projectId+".json"),persisted);
  return config;
}
async function conversationsDir(){const d=path.join(root,"conversations");await mkdir(d,{recursive:true});return d}
export async function createConversation(projectId:string,title="Новая сессия"){if(!await getProject(projectId))throw new Error("Project not found");const now=new Date().toISOString();const c:Conversation={id:randomUUID(),projectId,title:title.trim()||"Новая сессия",messages:[],createdAt:now,updatedAt:now};await writeJsonAtomic(path.join(await conversationsDir(),c.id+".json"),c);return c}
export async function getConversation(id:string):Promise<Conversation|null>{try{return JSON.parse(await readFile(path.join(root,"conversations",id+".json"),"utf8")) as Conversation}catch{return null}}
export async function listConversations(projectId:string){const result:Conversation[]=[];try{for(const n of await (await import("node:fs/promises")).readdir(await conversationsDir())){if(!n.endsWith(".json"))continue;const c=await getConversation(n.slice(0,-5));if(c?.projectId===projectId)result.push(c)}}catch{}return result.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))}
export async function appendConversationMessages(id:string,messages:ChatMessage[]){const c=await getConversation(id);if(!c)throw new Error("Conversation not found");c.messages.push(...messages);c.updatedAt=new Date().toISOString();await writeJsonAtomic(path.join(root,"conversations",id+".json"),c);return c}
