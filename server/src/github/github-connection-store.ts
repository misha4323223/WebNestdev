import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isYdbEnabled, ydbQuery, getTable } from "../storage/ydb.js";

export type GitHubConnection = { id:string; userId:string; accessToken:string; githubLogin?:string; createdAt:string };

const root=process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");

export async function saveGitHubConnection(userId:string,accessToken:string,githubLogin?:string){
  const connection:GitHubConnection={
    id:randomUUID(),
    userId,
    accessToken,
    githubLogin,
    createdAt:new Date().toISOString()
  };
  if(isYdbEnabled()){
    await ydbQuery()`
      UPSERT INTO ${ydbQuery().identifier(getTable("github_connections"))}
        (user_id,id,access_token,github_login,created_at)
      VALUES (${connection.userId},${connection.id},${connection.accessToken},${connection.githubLogin ?? ""},${connection.createdAt})
    `;
    return {id:connection.id,githubLogin:connection.githubLogin,createdAt:connection.createdAt};
  }
  const dir=path.join(root,"github");
  await mkdir(dir,{recursive:true});
  await writeFile(path.join(dir,userId+".json"),JSON.stringify(connection),{mode:0o600});
  return {id:connection.id,githubLogin:connection.githubLogin,createdAt:connection.createdAt};
}

export async function getGitHubConnection(userId:string):Promise<GitHubConnection|null>{
  if(isYdbEnabled()){
    const [rows]=await ydbQuery()<Array<{user_id:string;id:string;access_token:string;github_login:string;created_at:string}>>`
      SELECT user_id,id,access_token,github_login,created_at
      FROM ${ydbQuery().identifier(getTable("github_connections"))}
      WHERE user_id = ${userId}
      LIMIT 1
    `;
    const row=rows?.[0];
    if(!row)return null;
    return {id:row.id,userId:row.user_id,accessToken:row.access_token,githubLogin:row.github_login || undefined,createdAt:row.created_at};
  }
  try{return JSON.parse(await readFile(path.join(root,"github",userId+".json"),"utf8")) as GitHubConnection}catch{return null}
}

export async function deleteGitHubConnection(userId:string){
  if(isYdbEnabled()){
    await ydbQuery()`DELETE FROM ${ydbQuery().identifier(getTable("github_connections"))} WHERE user_id = ${userId}`;
    return;
  }
  try{await writeFile(path.join(root,"github",userId+".json"),"",{mode:0o600})}catch{}
}
