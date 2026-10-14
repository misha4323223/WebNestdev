import type { PreviewState } from "./types.js";

const previews=new Map<string,PreviewState>();

export function getPreview(projectId:string){return previews.get(projectId)}
export function listPreviews(){return [...previews.values()]}
/** Keeps the last-use mark the caller supplies (the runner sets a fresh one); fills it when missing. */
export function setPreview(state:PreviewState){previews.set(state.projectId,{...state,lastUsedAt:state.lastUsedAt||Date.now()})}
export function removePreview(projectId:string){previews.delete(projectId)}
/** Marks a preview as used now; returns false when the project has no running preview. */
export function touchPreview(projectId:string,now=Date.now()){
  const current=previews.get(projectId);
  if(!current)return false;
  previews.set(projectId,{...current,lastUsedAt:now});
  return true;
}
