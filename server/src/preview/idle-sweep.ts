import { isRunActive } from "../agent/active-runs.js";
import { stopPreview } from "../preview-manager.js";
import { listPreviews } from "./preview-store.js";
import type { PreviewState } from "./types.js";

/** Five minutes without a single use: the container is stopped and its memory returned. */
export const DEFAULT_IDLE_MS=5*60*1000;
export const DEFAULT_SWEEP_MS=60*1000;

/** The stop step is injected so the sweep can be tested without a Docker daemon. */
export type IdleSweepDeps={stopPreview:(projectId:string)=>Promise<unknown>};
export const defaultIdleSweepDeps:IdleSweepDeps={stopPreview};

export function idleTimeoutMs(){
  const configured=Number(process.env.PREVIEW_IDLE_MS??DEFAULT_IDLE_MS);
  return Number.isFinite(configured)&&configured>=0?configured:DEFAULT_IDLE_MS;
}

/**
 * Which previews have not been used for longer than the timeout. A preview counts as used when
 * its status is read, its logs are read, or anything is proxied through it — that is what the
 * panel, the logs tab and the agent's verification all do. `PREVIEW_IDLE_MS=0` disables the
 * sweep entirely, which is what a host with a single long-lived preview would want.
 */
export function idlePreviews(states:PreviewState[],now:number,idleMs=idleTimeoutMs()){
  if(idleMs<=0)return [];
  return states.filter(state=>now-(state.lastUsedAt||state.startedAt)>=idleMs);
}

/**
 * Idle previews are stopped, but a project with a run in flight is skipped: the agent may be one
 * step away from verifying against that preview. A stop that fails (the container is gone,
 * Docker is unreachable) leaves the state in place, so the next sweep retries instead of
 * forgetting a container that is still running.
 */
export async function stopIdlePreviews(now=Date.now(),idleMs=idleTimeoutMs(),deps:IdleSweepDeps=defaultIdleSweepDeps){
  const candidates=idlePreviews(listPreviews(),now,idleMs).filter(state=>!isRunActive(state.projectId));
  let stopped=0;
  for(const state of candidates){
    try{
      await deps.stopPreview(state.projectId);
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
