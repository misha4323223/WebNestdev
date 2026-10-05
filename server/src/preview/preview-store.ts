import type { PreviewState } from "./types.js";

const previews=new Map<string,PreviewState>();

export function getPreview(projectId:string){return previews.get(projectId)}
export function setPreview(state:PreviewState){previews.set(state.projectId,state)}
export function removePreview(projectId:string){previews.delete(projectId)}
