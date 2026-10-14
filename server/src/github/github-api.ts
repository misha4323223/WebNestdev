import { getGitHubConnection } from "./github-connection-store.js";

const DEFAULT_API="https://api.github.com";
/** База GitHub API; `GITHUB_API_BASE` переопределяют тесты, чтобы проверка токена не ходила в сеть. */
export function githubApiBase(){return (process.env.GITHUB_API_BASE??DEFAULT_API).replace(/\/+$/,"")}

function githubHeaders(token:string){
  const headers=new Headers();
  headers.set("Accept","application/vnd.github+json"); headers.set("X-GitHub-Api-Version","2022-11-28");
  headers.set("Authorization","Bearer "+token);
  return headers;
}

async function githubFetch(userId:string,pathname:string,init:RequestInit={}){
  const connection=await getGitHubConnection(userId);
  if(!connection)throw new Error("GitHub не подключён");
  const headers=githubHeaders(connection.accessToken);
  for(const [key,value] of new Headers(init.headers))headers.set(key,value);
  const response=await fetch(githubApiBase()+pathname,{...init,headers});
  const body=await response.text();
  if(!response.ok)throw new Error("GitHub API вернул "+response.status+": "+body.slice(0,1000));
  return body?JSON.parse(body):null;
}

/**
 * Проверка личного токена до сохранения: GitHub отвечает владельцем токена или отказом. Так
 * подключение даёт понятную ошибку сразу, а не «пустой список репозиториев» потом.
 */
export async function getGitHubLoginFromToken(token:string){
  let response:Response;
  try{
    response=await fetch(githubApiBase()+"/user",{headers:githubHeaders(token)});
  }catch(error){
    throw new Error("Не удалось связаться с GitHub: "+(error instanceof Error?error.message:String(error)));
  }
  const body=await response.text();
  if(response.status===401)throw new Error("GitHub не принял токен: проверьте, что он скопирован целиком и не истёк");
  if(!response.ok)throw new Error("GitHub API вернул "+response.status+": "+body.slice(0,300));
  const user=JSON.parse(body) as {login?:string};
  if(!user.login)throw new Error("GitHub не вернул имя пользователя для этого токена");
  return user.login;
}
export async function getGitHubUser(userId:string){return githubFetch(userId,"/user")}
export async function listGitHubRepositories(userId:string){return githubFetch(userId,"/user/repos?sort=updated&per_page=100")}
export async function getGitHubRepository(userId:string,owner:string,repo:string){return githubFetch(userId,"/repos/"+encodeURIComponent(owner)+"/"+encodeURIComponent(repo))}
export async function getGitHubTree(userId:string,owner:string,repo:string,branch:string){return githubFetch(userId,"/repos/"+encodeURIComponent(owner)+"/"+encodeURIComponent(repo)+"/git/trees/"+encodeURIComponent(branch)+"?recursive=1")}
export async function getGitHubBlob(userId:string,owner:string,repo:string,shaOrPath:string){return githubFetch(userId,"/repos/"+encodeURIComponent(owner)+"/"+encodeURIComponent(repo)+"/contents/"+shaOrPath.split("/").map(encodeURIComponent).join("/"))}
