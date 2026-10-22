import type { SandboxConfig } from "../sandbox-manager.js";
import { workspaceMountSource } from "../sandbox/config.js";
import { previewAppAnswers } from "./app-http.js";
import { dockerExec } from "./docker-exec.js";
import { addressOnNetworks, firstContainerAddress, previewNetwork } from "./preview-network.js";
import { settlePreviewAddress } from "./preview-address.js";
import { resolvePreviewCommand } from "./preview-command.js";
import { ensureProjectDependencies } from "./dependencies.js";
import { setPreview } from "./preview-store.js";
import { PREVIEW_APP_PORT, PREVIEW_LABEL, type PreviewState } from "./types.js";
import { previewSecretMounts } from "../secrets/preview-secrets.js";

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
  // У проекта, только что созданного агентом, нет `node_modules`, и `npm run dev` в контейнере
  // падал бы на отсутствующем `vite`: установка идёт здесь же, один раз, с сетью — как `npm.install`.
  const dependencies=await ensureProjectDependencies(config);
  if(!dependencies.ok)throw new Error(dependencies.reason);
  const command=await resolvePreviewCommand(config);
  const image=process.env.SANDBOX_IMAGE??"node:22-bookworm-slim";
  const network=await previewNetwork();
  // Секреты приходят из зашифрованного хранилища как read-only файлы поверх `/workspace`.
  // В рабочей области их нет: агент и файловый API не видят ни значения, ни файла.
  const secrets=await previewSecretMounts(config);
  let result;
  try {
    result=await dockerExec([
      "run","-d","--rm","--init",
      "--cpus",String(config.cpuLimit),
      "--memory",String(config.memoryMb)+"m",
      "--pids-limit","128",
      // Предпросмотр — тоже пользовательский код: capabilities и setuid ему не нужны, а
      // отсутствие обоих флагов делало контейнер более мягкой целью, чем контейнер команд.
      "--cap-drop","ALL",
      "--security-opt","no-new-privileges:true",
      "--read-only",
      "--tmpfs","/tmp:rw,nosuid,size=256m",
      "--user","1000:1000",
      ...(network?["--network",network]:[]),
      // The label is how a restarted server finds previews it no longer knows about.
      "--label",PREVIEW_LABEL+"="+config.projectId,
      // Путь хоста, а не сервера: docker разбирает его до контейнера (см. sandbox/config.ts).
      "-v",workspaceMountSource(config)+":/workspace",
      ...secrets.mounts,
      "-w","/workspace",
      "-e","HOME=/tmp",
      "-e","CI=1",
      image,"/bin/sh","-lc",command,
    ]);
  } catch (error) {
    await secrets.cleanup();
    throw error;
  }
  if(result.code!==0){
    await secrets.cleanup();
    throw new Error(result.stderr||"Не удалось запустить контейнер предпросмотра");
  }
  const containerId=result.stdout.trim();
  // Адрес берётся именно на той сети, куда контейнер поставлен: у контейнера может быть несколько
  // интерфейсов, и адрес не с той сети серверу недоступен (см. preview-network.ts).
  const host=(network?await addressOnNetworks(containerId,[network]):"")||await firstContainerAddress(containerId);
  if(!host){
    await dockerExec(["stop",containerId]);
    await secrets.cleanup();
    throw new Error("Адрес контейнера предпросмотра не назначен");
  }
  const now=Date.now();
  const state:PreviewState={mode:"container",containerId,projectId:config.projectId,host,port:PREVIEW_APP_PORT,startedAt:now,lastUsedAt:now};
  setPreview(state);
  let ready:boolean;
  let settled:PreviewState;
  try{
    ready=await waitForApp(state);
    // Приложение решает, где слушать: оно могло не принять флаги запуска (тогда порт берётся из
    // /proc/net/tcp) или слушать только петлю контейнера (тогда поднимается проброс), иначе
    // предпросмотр выглядел бы работающим, а панель, агент и Chromium не доходили бы до него.
    settled=await settlePreviewAddress(state,{appAnswers:ready});
  }catch(error){
    // Неудачный запуск не должен оставлять открытый env-файл на хосте.
    await dockerExec(["stop",containerId]).catch(()=>undefined);
    await secrets.cleanup();
    throw error;
  }
  setPreview(settled);
  // A dev server that has not answered yet is not a failure: npm may still be installing
  // or Vite may still be compiling. The state stays, the diagnostics come along, and the
  // next status check turns ready into the real answer.
  // Лог установки — единственное место, где видно, почему первый запуск занял минуту, а также
  // причина отказа, если dev-сервер так и не ответил.
  return {...settled,running:true as const,ready,...(ready?{}:{logs:[dependencies.log,await recentPreviewLogs(containerId)].filter(Boolean).join("\n\n")})};
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

export async function recentPreviewLogs(containerId:string){
  const result=await dockerExec(["logs","--tail","120",containerId]);
  return [result.stdout,result.stderr].map(value=>value.replace(/\r/g,"").trim()).filter(Boolean).join("\n");
}
