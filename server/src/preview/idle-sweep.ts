import { isRunActiveAnywhere } from "../agent/run-activity.js";
import { stopPreview } from "../preview-manager.js";
import { listPreviews } from "./preview-store.js";
import { pruneSharedPreviews } from "./preview-registry.js";
import { markIdleStopped } from "./idle-stop-marker.js";
import type { PreviewState } from "./types.js";

/** Docker/hybrid останавливаются после трёх минут без запросов. */
export const DEFAULT_IDLE_MS=3*60*1000;
/** Static — это слушатель в процессе API, а не контейнер: ему даём пятнадцать минут. */
export const DEFAULT_STATIC_IDLE_MS=15*60*1000;
/** Проверка раз в 30 секунд: остановка наступает около 3:00–3:30, а не к четвёртой минуте. */
export const DEFAULT_SWEEP_MS=30*1000;

/** The stop step is injected so the sweep can be tested without a Docker daemon. */
export type IdleSweepDeps={stopPreview:(projectId:string)=>Promise<unknown>};
export const defaultIdleSweepDeps:IdleSweepDeps={stopPreview};

export function idleTimeoutMs(){
  const configured=Number(process.env.PREVIEW_IDLE_MS??DEFAULT_IDLE_MS);
  return Number.isFinite(configured)&&configured>=0?configured:DEFAULT_IDLE_MS;
}

export function staticIdleTimeoutMs(){
  const configured=Number(process.env.PREVIEW_STATIC_IDLE_MS??DEFAULT_STATIC_IDLE_MS);
  return Number.isFinite(configured)&&configured>=0?configured:DEFAULT_STATIC_IDLE_MS;
}

/**
 * Which previews have not been used for longer than their timeout. Runtime (Docker/hybrid) uses
 * `PREVIEW_IDLE_MS`; static keeps `PREVIEW_STATIC_IDLE_MS` so an inline preview does not disappear
 * on the runtime timer. `PREVIEW_IDLE_MS=0` disables the sweep entirely, including static.
 */
export function idlePreviews(states:PreviewState[],now:number,idleMs=idleTimeoutMs(),staticIdleMs=staticIdleTimeoutMs()){
  if(idleMs<=0)return [];
  return states.filter(state=>{
    const limit=state.mode==="static"?staticIdleMs:idleMs;
    return limit>0&&now-(state.lastUsedAt||state.startedAt)>=limit;
  });
}

/**
 * Idle previews are stopped, but a project with a run in flight is skipped: the agent may be one
 * step away from verifying against that preview. A stop that fails (the container is gone,
 * Docker is unreachable) leaves the state in place, so the next sweep retries instead of
 * forgetting a container that is still running.
 */
export async function stopIdlePreviews(now=Date.now(),idleMs=idleTimeoutMs(),deps:IdleSweepDeps=defaultIdleSweepDeps,staticIdleMs=staticIdleTimeoutMs()){
  // Просроченные строки чужих реплик не должны копиться после падений: их всё равно не отдаёт
  // чтение, но уборка базы — единственное место, где они исчезают совсем.
  await pruneSharedPreviews().catch(()=>undefined);
  const candidates=[];
  for(const state of idlePreviews(listPreviews(),now,idleMs,staticIdleMs)){
    // Проверка общая: preview мог быть поднят на этой реплике, а агент ещё работает на другой.
    if(await isRunActiveAnywhere(state.projectId))continue;
    candidates.push(state);
  }
  let stopped=0;
  for(const state of candidates){
    try{
      await deps.stopPreview(state.projectId);
      // Отметка ставится после успешной остановки: старая ссылка объяснит причину, а не
      // покажет общий «не запущен». Ручная остановка и новый запуск её снимают.
      markIdleStopped(state.projectId, state.mode, state.mode==="static"?staticIdleMs:idleMs, now);
      stopped++;
      console.log("[preview] остановлен по бездействию: проект "+state.projectId+" (контейнер "+state.containerId+")");
    }catch(error){
      console.error("[preview] не удалось остановить бездействующий предпросмотр "+state.projectId,error);
    }
  }
  return {stopped};
}

let timer:NodeJS.Timeout|null=null;

/** Runs the sweep on a fixed interval; disabled when the idle timeout is 0. */
export function startPreviewSweeper(sweepMs=Number(process.env.PREVIEW_SWEEP_MS??DEFAULT_SWEEP_MS)){
  if(timer||idleTimeoutMs()<=0)return;
  timer=setInterval(()=>{void stopIdlePreviews().catch(()=>undefined)},Math.max(5000,sweepMs));
  timer.unref();
}

export function stopPreviewSweeper(){
  if(timer)clearInterval(timer);
  timer=null;
}
