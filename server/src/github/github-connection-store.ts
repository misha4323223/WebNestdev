import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../security/secret-crypto.js";

export type GitHubConnection = { id:string; userId:string; accessToken:string; githubLogin?:string; createdAt:string };
const root=process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");

async function writeConnection(file:string,connection:GitHubConnection){
  const dir=path.dirname(file); await mkdir(dir,{recursive:true});
  const temp=file+"."+randomUUID()+".tmp";
  try { await writeFile(temp,JSON.stringify(connection),{mode:0o600}); await rename(temp,file); }
  catch(error){ try{await unlink(temp)}catch{} throw error; }
}
export async function saveGitHubConnection(userId:string,accessToken:string,githubLogin?:string){
  const connection:GitHubConnection={id:randomUUID(),userId,accessToken:encryptSecret(accessToken),githubLogin,createdAt:new Date().toISOString()};
  await writeConnection(path.join(root,"github",userId+".json"),connection);
  return {id:connection.id,githubLogin:connection.githubLogin,createdAt:connection.createdAt};
}
export async function getGitHubConnection(userId:string):Promise<GitHubConnection|null>{
  const file=path.join(root,"github",userId+".json");
  try {
    const connection=JSON.parse(await readFile(file,"utf8")) as GitHubConnection;
    if(!isEncryptedSecret(connection.accessToken)){
      // Persist migrated ciphertext atomically before exposing the token to callers.
      await writeConnection(file,{...connection,accessToken:encryptSecret(connection.accessToken)});
    }
    return {...connection,accessToken:decryptSecret(connection.accessToken)};
  } catch(error) {
    if((error as NodeJS.ErrnoException).code==="ENOENT") return null;
    throw error;
  }
}
export async function deleteGitHubConnection(userId:string){
  try{await unlink(path.join(root,"github",userId+".json"))}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error}
}
