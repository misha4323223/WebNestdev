import { spawn } from "node:child_process";
import type { SandboxConfig } from "./sandbox-manager.js";
import { dockerOptions } from "./sandbox/docker/options.js";
import type { SandboxRunOptions } from "./sandbox-worker.js";
import { dockerRunArgs } from "./sandbox/docker/args.js";
import type { DockerCommandResult } from "./sandbox/docker/types.js";

export type { DockerCommandResult };

export async function runDockerSandbox(config:SandboxConfig,command:string,cwd:string,runOptions:SandboxRunOptions={}):Promise<DockerCommandResult>{
  if((process.env.SANDBOX_MODE??"docker")!=="docker")throw new Error("Host execution is disabled. Set SANDBOX_MODE=docker.");
  const options=dockerOptions(config);
  const args=dockerRunArgs(config,cwd,options,command,runOptions.network ?? options.network);
  return new Promise((resolve,reject)=>{
    const child=spawn("docker",args,{stdio:["ignore","pipe","pipe"],windowsHide:true});
    let stdout="",stderr="",truncated=false;
    const append=(target:"stdout"|"stderr",chunk:Buffer)=>{
      const left=options.maxOutput-stdout.length-stderr.length;
      if(left<=0){truncated=true;return}
      const value=chunk.toString();
      if(value.length>left)truncated=true;
      if(target==="stdout")stdout+=value.slice(0,left);else stderr+=value.slice(0,left);
    };
    child.stdout.on("data",(x:Buffer)=>append("stdout",x));
    child.stderr.on("data",(x:Buffer)=>append("stderr",x));
    const timer=setTimeout(()=>{
      child.kill("SIGTERM");
      setTimeout(()=>child.kill("SIGKILL"),1500).unref();
      reject(new Error("Sandbox command timeout"));
    },config.timeoutMs);
    child.once("error",e=>{clearTimeout(timer);reject(new Error("Docker sandbox unavailable: "+e.message))});
    child.once("close",(code,signal)=>{clearTimeout(timer);resolve({ok:code===0,exitCode:code,signal,stdout,stderr,truncated})});
  });
}

export async function sandboxStatus(){
  const mode=process.env.SANDBOX_MODE??"docker";
  if(mode!=="docker")return {mode,available:false,reason:"Docker sandbox is required."};
  return new Promise(resolve=>{
    const child=spawn("docker",["version","--format","{{.Server.Version}}"],{stdio:["ignore","pipe","pipe"]});
    let output="";
    child.stdout.on("data",(x:Buffer)=>output+=x.toString());
    child.on("error",()=>resolve({mode,available:false}));
    child.on("close",code=>resolve({mode,available:code===0,dockerVersion:code===0?output.trim():undefined}));
  });
}
