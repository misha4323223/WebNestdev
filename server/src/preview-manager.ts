import { spawn } from "node:child_process";
import type { SandboxConfig } from "./sandbox-manager.js";

type PreviewState={containerId:string;port:number;projectId:string;startedAt:number};
const previews=new Map<string,PreviewState>();

function exec(args:string[], timeoutMs=15000):Promise<{code:number;stdout:string;stderr:string}>{
  return new Promise((resolve,reject)=>{
    const p=spawn("docker",args,{stdio:["ignore","pipe","pipe"],windowsHide:true});
    let stdout="",stderr="";
    p.stdout.on("data",(x:Buffer)=>stdout+=x.toString());
    p.stderr.on("data",(x:Buffer)=>stderr+=x.toString());
    const t=setTimeout(()=>{p.kill("SIGKILL");reject(new Error("Docker operation timeout"))},timeoutMs);
    p.on("error",e=>{clearTimeout(t);reject(e)});
    p.on("close",code=>{clearTimeout(t);resolve({code:code??1,stdout,stderr})});
  });
}

export async function startPreview(config:SandboxConfig){
  const current=previews.get(config.projectId);
  if(current) return current;
  const image=process.env.SANDBOX_IMAGE ?? "node:22-bookworm-slim";
  const result=await exec([
    "run","-d","--rm","--init",
    "--cpus",String(config.cpuLimit),
    "--memory",String(config.memoryMb)+"m",
    "--pids-limit","128",
    "--read-only",
    "--tmpfs","/tmp:rw,nosuid,size=256m",
    "--user","1000:1000",
    "-p","127.0.0.1::3000",
    "-v",config.root+":/workspace",
    "-w","/workspace",
    "-e","HOME=/tmp",
    "-e","CI=1",
    image,"/bin/sh","-lc",
    "npm run dev -- --host 0.0.0.0 --port 3000"
  ]);
  if(result.code!==0) throw new Error(result.stderr||"Unable to start preview container");
  const containerId=result.stdout.trim();
  const portResult=await exec(["port",containerId,"3000/tcp"]);
  const match=portResult.stdout.match(/127\.0\.0\.1:(\d+)/);
  if(!match){await exec(["stop",containerId]);throw new Error("Preview port was not assigned")}
  const state={containerId,port:Number(match[1]),projectId:config.projectId,startedAt:Date.now()};
  previews.set(config.projectId,state);
  return state;
}

export async function stopPreview(projectId:string){
  const current=previews.get(projectId);
  if(!current)return {stopped:false};
  await exec(["stop",current.containerId]);
  previews.delete(projectId);
  return {stopped:true};
}

export async function previewStatus(projectId:string){
  const current=previews.get(projectId);
  if(!current)return {running:false};
  const inspect=await exec(["inspect","-f","{{.State.Running}}",current.containerId]);
  if(inspect.code!==0||inspect.stdout.trim()!=="true"){previews.delete(projectId);return {running:false}}
  return {running:true,port:current.port,containerId:current.containerId,startedAt:current.startedAt};
}
