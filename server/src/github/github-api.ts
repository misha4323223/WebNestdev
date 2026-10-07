import { getGitHubConnection } from "./github-connection-store.js";

const API="https://api.github.com";
async function githubFetch(userId:string,pathname:string,init:RequestInit={}){
  const connection=await getGitHubConnection(userId);
  if(!connection)throw new Error("GitHub is not connected");
  const headers=new Headers(init.headers);
  headers.set("Accept","application/vnd.github+json"); headers.set("X-GitHub-Api-Version","2022-11-28");
  headers.set("Authorization","Bearer "+connection.accessToken);
  const response=await fetch(API+pathname,{...init,headers});
  const body=await response.text();
  if(!response.ok)throw new Error("GitHub API "+response.status+": "+body.slice(0,1000));
  return body?JSON.parse(body):null;
}
export async function getGitHubUser(userId:string){return githubFetch(userId,"/user")}
export async function listGitHubRepositories(userId:string){return githubFetch(userId,"/user/repos?sort=updated&per_page=100")}
export async function getGitHubRepository(userId:string,owner:string,repo:string){return githubFetch(userId,"/repos/"+encodeURIComponent(owner)+"/"+encodeURIComponent(repo))}
export async function getGitHubTree(userId:string,owner:string,repo:string,branch:string){return githubFetch(userId,"/repos/"+encodeURIComponent(owner)+"/"+encodeURIComponent(repo)+"/git/trees/"+encodeURIComponent(branch)+"?recursive=1")}
export async function getGitHubBlob(userId:string,owner:string,repo:string,shaOrPath:string){return githubFetch(userId,"/repos/"+encodeURIComponent(owner)+"/"+encodeURIComponent(repo)+"/contents/"+shaOrPath.split("/").map(encodeURIComponent).join("/"))}
