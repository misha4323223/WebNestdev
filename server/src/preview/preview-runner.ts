import type { SandboxConfig } from "../sandbox-manager.js";
import { dockerExec } from "./docker-exec.js";
import { resolvePreviewCommand } from "./preview-command.js";
import { setPreview } from "./preview-store.js";
import type { PreviewState } from "./types.js";

export async function startPreviewContainer(config:SandboxConfig):Promise<PreviewState>{
  const command=await resolvePreviewCommand(config);
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
    image,"/bin/sh","-lc",command
  ]);
  if(result.code!==0)throw new Error(result.stderr||"Unable to start preview container");
  const containerId=result.stdout.trim();
  const portResult=await dockerExec(["port",containerId,"3000/tcp"]);
  const match=portResult.stdout.match(/127\.0\.0\.1:(\d+)/);
  if(!match){
    await dockerExec(["stop",containerId]);
    throw new Error("Preview port was not assigned");
  }
  const ipResult=await dockerExec(["inspect","-f","{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",containerId]);
  const host=ipResult.stdout.trim();
  if(ipResult.code!==0||!host){await dockerExec(["stop",containerId]);throw new Error("Preview container address was not assigned");}
  // Give the dev server a short startup window and surface its logs if it exits.
  // This makes preview failures actionable for the agent instead of looking like a generic start error.
  for(let attempt=0;attempt<10;attempt++){
    const inspect=await dockerExec(["inspect","-f","{{.State.Running}}",containerId]);
    if(inspect.code!==0||inspect.stdout.trim()!=="true"){
      const logs=await dockerExec(["logs","--tail","120",containerId]);
      await dockerExec(["stop",containerId]);
      throw new Error((logs.stdout||logs.stderr||"Preview process exited during startup").trim());
    }
    await new Promise(resolve=>setTimeout(resolve,300));
  }

  const state={containerId,port:Number(match[1]),host,projectId:config.projectId,startedAt:Date.now()};
  setPreview(state);
  return state;
}
