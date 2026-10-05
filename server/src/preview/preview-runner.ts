import type { SandboxConfig } from "../sandbox-manager.js";
import { dockerExec } from "./docker-exec.js";
import { setPreview } from "./preview-store.js";
import type { PreviewState } from "./types.js";

export async function startPreviewContainer(config:SandboxConfig):Promise<PreviewState>{
  const image=process.env.SANDBOX_IMAGE??"node:22-bookworm-slim";
  const result=await dockerExec([
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
  if(result.code!==0)throw new Error(result.stderr||"Unable to start preview container");
  const containerId=result.stdout.trim();
  const portResult=await dockerExec(["port",containerId,"3000/tcp"]);
  const match=portResult.stdout.match(/127\.0\.0\.1:(\d+)/);
  if(!match){await dockerExec(["stop",containerId]);throw new Error("Preview port was not assigned")}
  const state={containerId,port:Number(match[1]),projectId:config.projectId,startedAt:Date.now()};
  setPreview(state);
  return state;
}
