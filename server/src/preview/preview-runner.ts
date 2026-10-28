import type { SandboxConfig } from "../sandbox-manager.js";
import { sandboxImage, workspaceMountSource } from "../sandbox/config.js";
import { previewAppAnswers } from "./app-http.js";
import { dockerExec, missingContainer } from "./docker-exec.js";
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
 *
 * Контейнер запускается без `--rm`: с ним упавший dev-сервер исчезал раньше, чем сервер успевал
 * прочитать его вывод, и причину отказа (ошибка в скрипте запуска, OOM, занятый порт) заменить было
 * нечем — вместо неё человек видел `Error response from daemon: No such container: <id>`. Теперь
 * упавший контейнер остаётся остановленным, пока его не уберут остановка, следующий запуск или
 * проверка статуса.
 */
export async function startPreviewContainer(config:SandboxConfig){
  // У проекта, только что созданного агентом, нет `node_modules`, и `npm run dev` в контейнере
  // падал бы на отсутствующем `vite`: установка идёт здесь же, один раз, с сетью — как `npm.install`.
  const dependencies=await ensureProjectDependencies(config);
  if(!dependencies.ok)throw new Error(dependencies.reason);
  const command=await resolvePreviewCommand(config);
  const image=sandboxImage();
  const network=await previewNetwork();
  // Секреты приходят из зашифрованного хранилища как read-only файлы поверх `/workspace`.
  // В рабочей области их нет: агент и файловый API не видят ни значения, ни файла.
  const secrets=await previewSecretMounts(config);
  let result;
  try {
    result=await dockerExec([
      "run","-d","--init",
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
    ],
    // На загруженном хосте старт контейнера вместе с созданием слоя может занять больше 15 с:
    // рядом идёт npm install или сборка другого проекта. Предел больше только у этого шага;
    // inspect и logs остаются короткими, чтобы зависший демон не держал панель.
    60_000);
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
    await removePreviewContainer(containerId);
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
    // Неудачный запуск не должен оставлять ни открытый env-файл на хосте, ни контейнер: без `--rm`
    // он остался бы остановленным и занимал место до следующей уборки.
    await removePreviewContainer(containerId);
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
    // Код выхода читается вместе с признаком работы: упавший процесс объясняет отказ точнее, чем
    // отсутствие ответа на порту.
    const inspect=await dockerExec(["inspect","-f","{{.State.Running}} {{.State.ExitCode}}",state.containerId]);
    const [isRunning,exitCode]=inspect.stdout.trim().split(/\s+/);
    if(inspect.code!==0){
      if(missingContainer(inspect))throw new Error(containerVanishedMessage(state.containerId));
      throw new Error(inspect.stderr.trim()||"Не удалось проверить контейнер предпросмотра");
    }
    if(isRunning!=="true"){
      // Причина отказа — это вывод самого dev-сервера: без `--rm` контейнер остаётся, и `docker logs`
      // возвращает текст настоящей ошибки (не установлены зависимости, занят порт, синтаксис).
      const logs=await recentPreviewLogs(state.containerId);
      if(logs)throw new Error(logs);
      throw new Error("Процесс предпросмотра завершился при запуске"+(exitCode&&exitCode!=="0"?" (код выхода "+exitCode+")":"")+": вывода нет, проверьте команду запуска в package.json.");
    }
    if(await previewAppAnswers(state))return true;
    await new Promise(resolve=>setTimeout(resolve,READY_DELAY_MS));
  }
  return false;
}

/**
 * Сообщение вместо английского ответа Docker. Контейнер без `--rm` так исчезнуть не может сам, значит
 * его убрали извне (уборка на хосте, `docker system prune`, перенос на другую машину).
 */
export function containerVanishedMessage(containerId:string){
  return "Контейнер предпросмотра исчез во время запуска: Docker больше не знает контейнер "+containerId.slice(0,12)+
    ". Запустите предпросмотр ещё раз — если это повторяется, проверьте на хосте `docker events` и свободное место на диске.";
}

/**
 * Вывод контейнера вместе с ответом «контейнера уже нет»: вызывающий по нему снимает состояние
 * предпросмотра, а не показывает пользователю текст ошибки Docker.
 */
export async function previewLogsOf(containerId:string,docker:typeof dockerExec=dockerExec):Promise<{logs:string;missing:boolean}>{
  const result=await docker(["logs","--tail","120",containerId]);
  if(missingContainer(result))return {logs:"",missing:true};
  const logs=[result.stdout,result.stderr].map(value=>value.replace(/\r/g,"").trim()).filter(Boolean).join("\n");
  return {logs,missing:false};
}

export async function recentPreviewLogs(containerId:string,docker:typeof dockerExec=dockerExec){
  return (await previewLogsOf(containerId,docker)).logs;
}

/**
 * Убирает контейнер предпросмотра с хоста. Ответ не проверяется: контейнера могло уже не быть, а
 * остановка предпросмотра не должна из-за этого падать.
 */
export async function removePreviewContainer(containerId:string){
  const result=await dockerExec(["rm","-f",containerId]).catch(()=>null);
  return Boolean(result&&result.code===0);
}
