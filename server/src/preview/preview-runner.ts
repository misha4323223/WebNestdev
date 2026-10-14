import type { SandboxConfig } from "../sandbox-manager.js";
import { workspaceMountSource } from "../sandbox/config.js";
import { dockerExec } from "./docker-exec.js";
import { previewNetwork } from "./preview-network.js";
import { resolvePreviewCommand } from "./preview-command.js";
import { setPreview } from "./preview-store.js";
import { PREVIEW_APP_PORT, PREVIEW_LABEL, type PreviewState } from "./types.js";

const READY_ATTEMPTS=30;
const READY_DELAY_MS=500;

/**
 * The preview runs the same way for the agent and for the button in the panel: one dev
 * server per project, reached at the container address and the app port. The port is not
 * published on the host at all — the server talks to the container directly and the
 * container joins the server's Docker network — so a user's app never appears on the VM's
 * public address and there is no host-port/container-port mix-up to reason about.
 */
export async function startPreviewContainer(config:SandboxConfig){
  const command=await resolvePreviewCommand(config);
  const image=process.env.SANDBOX_IMAGE??"node:22-bookworm-slim";
  const network=await previewNetwork();
  const result=await dockerExec([
    "run","-d","--rm","--init",
    "--cpus",String(config.cpuLimit),
    "--memory",String(config.memoryMb)+"m",
    "--pids-limit","128",
    "--read-only",
    "--tmpfs","/tmp:rw,nosuid,size=256m",
    "--user","1000:1000",
    ...(network?["--network",network]:[]),
    // The label is how a restarted server finds previews it no longer knows about.
    "--label",PREVIEW_LABEL+"="+config.projectId,
    // Путь хоста, а не сервера: docker разбирает его до контейнера (см. sandbox/config.ts).
    "-v",workspaceMountSource(config)+":/workspace",
    "-w","/workspace",
    "-e","HOME=/tmp",
    "-e","CI=1",
    image,"/bin/sh","-lc",command,
  ]);
  if(result.code!==0)throw new Error(result.stderr||"Не удалось запустить контейнер предпросмотра");
  const containerId=result.stdout.trim();
  const host=await containerAddress(containerId);
  if(!host){
    await dockerExec(["stop",containerId]);
    throw new Error("Адрес контейнера предпросмотра не назначен");
  }
  const now=Date.now();
  const state:PreviewState={mode:"container",containerId,projectId:config.projectId,host,port:PREVIEW_APP_PORT,startedAt:now,lastUsedAt:now};
  setPreview(state);
  const ready=await waitForApp(state);
  // A dev server that has not answered yet is not a failure: npm may still be installing
  // or Vite may still be compiling. The state stays, the diagnostics come along, and the
  // next status check turns ready into the real answer.
  return {...state,running:true as const,ready,...(ready?{}:{logs:await recentPreviewLogs(containerId)})};
}

async function containerAddress(containerId:string){
  const result=await dockerExec(["inspect","-f","{{range .NetworkSettings.Networks}}{{.IPAddress}}\n{{end}}",containerId]);
  if(result.code!==0)return "";
  return result.stdout.split("\n").map(value=>value.trim()).filter(Boolean)[0]??"";
}

/** Bounded wait: the dev server answers in a second or two, a cold npm install takes longer. */
async function waitForApp(state:PreviewState){
  for(let attempt=0;attempt<READY_ATTEMPTS;attempt++){
    const running=await dockerExec(["inspect","-f","{{.State.Running}}",state.containerId]);
    if(running.code!==0||running.stdout.trim()!=="true"){
      const logs=await recentPreviewLogs(state.containerId);
      throw new Error(logs||"Процесс предпросмотра завершился при запуске");
    }
    if(await previewAppAnswers(state))return true;
    await new Promise(resolve=>setTimeout(resolve,READY_DELAY_MS));
  }
  return false;
}

/**
 * Probes the app from inside its own container, where it listens on the app port. Reading
 * the answer here keeps the readiness check independent of how the server reaches the
 * container from the outside.
 */
export async function previewAppAnswers(state:PreviewState){
  const probe=`fetch('http://127.0.0.1:${state.port}').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))`;
  const result=await dockerExec(["exec",state.containerId,"node","-e",probe],8000).catch(()=>null);
  return Boolean(result&&result.code===0);
}

export async function recentPreviewLogs(containerId:string){
  const result=await dockerExec(["logs","--tail","120",containerId]);
  return [result.stdout,result.stderr].map(value=>value.replace(/\r/g,"").trim()).filter(Boolean).join("\n");
}
