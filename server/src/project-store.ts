import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
export type Project = { id:string; name:string; createdAt:string; updatedAt:string };
const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
export async function ensureDataDir(){ await mkdir(root,{recursive:true}); }
export async function getProject(projectId:string):Promise<Project|null>{ try{return JSON.parse(await readFile(path.join(root,"projects",projectId+".json"),"utf8")) as Project}catch{return null} }
export async function createProject(name:string):Promise<Project>{ const project={id:randomUUID(),name:name.trim()||"Новый проект",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}; await mkdir(path.join(root,"projects"),{recursive:true}); await writeFile(path.join(root,"projects",project.id+".json"),JSON.stringify(project,null,2)); return project; }