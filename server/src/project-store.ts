import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage } from "./types.js";

export type Project = { id:string; name:string; createdAt:string; updatedAt:string };
export type Conversation = { id:string; projectId:string; title:string; messages:ChatMessage[]; createdAt:string; updatedAt:string };
export type ProjectProviderConfig = { provider:string; baseUrl:string; model:string; token?:string };
const root=process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");

export async function ensureDataDir(){await mkdir(root,{recursive:true})}
export async function getProject(projectId:string):Promise<Project|null>{try{return JSON.parse(await readFile(path.join(root,"projects",projectId+".json"),"utf8")) as Project}catch{return null}}
export async function createProject(name:string):Promise<Project>{const project={id:randomUUID(),name:name.trim()||"Новый проект",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};await mkdir(path.join(root,"projects"),{recursive:true});await writeFile(path.join(root,"projects",project.id+".json"),JSON.stringify(project,null,2));return project}
export async function getProjectProvider(projectId:string):Promise<ProjectProviderConfig|null>{try{return JSON.parse(await readFile(path.join(root,"providers",projectId+".json"),"utf8")) as ProjectProviderConfig}catch{return null}}
export async function saveProjectProvider(projectId:string,config:ProjectProviderConfig){if(!await getProject(projectId))throw new Error("Project not found");await mkdir(path.join(root,"providers"),{recursive:true});await writeFile(path.join(root,"providers",projectId+".json"),JSON.stringify(config,null,2),{mode:0o600});return config}
async function conversationsDir(){const d=path.join(root,"conversations");await mkdir(d,{recursive:true});return d}
export async function createConversation(projectId:string,title="Новая сессия"){if(!await getProject(projectId))throw new Error("Project not found");const now=new Date().toISOString();const c:Conversation={id:randomUUID(),projectId,title:title.trim()||"Новая сессия",messages:[],createdAt:now,updatedAt:now};await writeFile(path.join(await conversationsDir(),c.id+".json"),JSON.stringify(c,null,2));return c}
export async function getConversation(id:string):Promise<Conversation|null>{try{return JSON.parse(await readFile(path.join(root,"conversations",id+".json"),"utf8")) as Conversation}catch{return null}}
export async function listConversations(projectId:string){const result:Conversation[]=[];try{for(const n of await readdir(await conversationsDir())){if(!n.endsWith(".json"))continue;const c=await getConversation(n.slice(0,-5));if(c?.projectId===projectId)result.push(c)}}catch{}return result.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))}
export async function appendConversationMessages(id:string,messages:ChatMessage[]){const c=await getConversation(id);if(!c)throw new Error("Conversation not found");c.messages.push(...messages);c.updatedAt=new Date().toISOString();await writeFile(path.join(root,"conversations",id+".json"),JSON.stringify(c,null,2));return c}
