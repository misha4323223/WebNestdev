import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { isYdbEnabled, ydbQuery, getTable } from "../storage/ydb.js";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../storage/secret-crypto.js";

export type GitHubConnection = { id:string; userId:string; accessToken:string; githubLogin?:string; createdAt:string };
const root=process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");

async function writeConnection(file:string,connection:GitHubConnection){
  await mkdir(path.dirname(file),{recursive:true});
  const temp=file+"."+randomUUID()+".tmp";
  try { await writeFile(temp,JSON.stringify(connection),{mode:0o600}); await rename(temp,file); }
  catch(error){ try{await unlink(temp)}catch{} throw error; }
}

export async function saveGitHubConnection(userId:string,accessToken:string,githubLogin?:string){
  const connection:GitHubConnection={id:randomUUID(),userId,accessToken:encryptSecret(accessToken),githubLogin,createdAt:new Date().toISOString()};
  if(isYdbEnabled()){
    await ydbQuery()`
      UPSERT INTO ${ydbQuery().identifier(getTable("github_connections"))}
        (user_id,id,access_token,github_login,created_at)
      VALUES (${connection.userId},${connection.id},${connection.accessToken},${connection.githubLogin ?? ""},${connection.createdAt})
    `;
    return {id:connection.id,githubLogin:connection.githubLogin,createdAt:connection.createdAt};
  }
  await writeConnection(path.join(root,"github",userId+".json"),connection);
  return {id:connection.id,githubLogin:connection.githubLogin,createdAt:connection.createdAt};
}

export async function getGitHubConnection(userId:string):Promise<GitHubConnection|null>{
  if(isYdbEnabled()){
    const sql=ydbQuery();
    const [rows]=await sql<Array<{user_id:string;id:string;access_token:string;github_login:string;created_at:string}>>`
      SELECT user_id,id,access_token,github_login,created_at
      FROM ${ydbQuery().identifier(getTable("github_connections"))}
      WHERE user_id = ${userId}
      LIMIT 1
    `;
    const row=rows?.[0];
    if(!row)return null;
    let token=row.access_token;
    if(!isEncryptedSecret(token)){
      const plaintext=token;
      token=encryptSecret(token);
      await ydbQuery()`
        UPSERT INTO ${ydbQuery().identifier(getTable("github_connections"))}
          (user_id,id,access_token,github_login,created_at)
        VALUES (${row.user_id},${row.id},${token},${row.github_login},${row.created_at})
      `;
      token=plaintext;
    } else token=decryptSecret(token);
    return {id:row.id,userId:row.user_id,accessToken:token,githubLogin:row.github_login || undefined,createdAt:row.created_at};
  }
  const file=path.join(root,"github",userId+".json");
  try{
    const connection=JSON.parse(await readFile(file,"utf8")) as GitHubConnection;
    if(!isEncryptedSecret(connection.accessToken)){
      const plaintext=connection.accessToken;
      await writeConnection(file,{...connection,accessToken:encryptSecret(plaintext)});
      return {...connection,accessToken:plaintext};
    }
    return {...connection,accessToken:decryptSecret(connection.accessToken)};
  }catch(error){
    if((error as NodeJS.ErrnoException).code==="ENOENT")return null;
    throw error;
  }
}

export async function deleteGitHubConnection(userId:string){
  if(isYdbEnabled()){
    await ydbQuery()`DELETE FROM ${ydbQuery().identifier(getTable("github_connections"))} WHERE user_id = ${userId}`;
    return;
  }
  try{await unlink(path.join(root,"github",userId+".json"))}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error}
}
