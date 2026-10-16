import type { PreviewState } from "./types.js";

const previews=new Map<string,PreviewState>();

export function getPreview(projectId:string){return previews.get(projectId)}
export function listPreviews(){return [...previews.values()]}
/**
 * Keeps the last-use mark the caller supplies (the runner sets a fresh one); fills it when missing.
 * A write that carries a mark older than the stored one must not move it back: bringing the
 * address to a working one happens after the status read has already marked the preview as used,
 * and the idle sweeper would otherwise see a preview nobody touched.
 */
export function setPreview(state:PreviewState){
  const current=previews.get(state.projectId);
  const lastUsedAt=Math.max(state.lastUsedAt||0,current?.lastUsedAt??0)||Date.now();
  previews.set(state.projectId,{...state,lastUsedAt});
}
export function removePreview(projectId:string){previews.delete(projectId)}
/**
 * Снимает подтверждение адреса (прокси увидел, что он не работает): следующая проверка статуса
 * снова сведёт адрес приложения — например, после перезапуска dev-сервера на другом порту.
 */
export function unsettlePreview(projectId:string){
  const current=previews.get(projectId);
  if(!current||!current.settled)return false;
  previews.set(projectId,{...current,settled:false});
  return true;
}

/**
 * Адреса живых предпросмотров для `/api/health`: режим, порт, подтверждён ли адрес запросом сервера
 * и сколько предпросмотр уже живёт. Без этого поля «предпросмотр не работает» неотличимо от
 * «предпросмотр не запущен», а `settled: false` у живого предпросмотра — точный признак того, что
 * сервер до приложения не доходит (панель и Chromium тоже).
 */
export function previewAddresses(now=Date.now()){
  return listPreviews().map(state=>({
    mode:state.mode,
    port:state.port,
    settled:Boolean(state.settled),
    // Предпросмотр виден панели, но не по адресу контейнера: `settled: false` без этого поля
    // выглядит как «сервер до приложения не доходит», хотя кадр в панели не пустой.
    viaExec:Boolean(state.execOnly),
    execCheckedAt:state.execOnlyCheckedAt??null,
    ageSeconds:Math.max(0,Math.round((now-state.startedAt)/1000)),
  }));
}

/**
 * Переключает предпросмотр на путь через `docker exec` (см. preview/exec-proxy.ts) и обратно.
 * Ставится прокси, когда адрес контейнера не отвечает, а приложение внутри него живо; снимается,
 * когда адрес подтверждён заново — тогда панель снова идёт прямым путём.
 */
export function setPreviewExecOnly(projectId:string,execOnly:boolean){
  const current=previews.get(projectId);
  if(!current||current.mode!=="container"||Boolean(current.execOnly)===execOnly)return false;
  // Отметка времени — вместе с признаком: включивший его прокси только что убедился, что прямой
  // адрес не отвечает, поэтому повторная проверка адреса отсчитывается от этого момента.
  previews.set(projectId,{...current,execOnly,execOnlyCheckedAt:execOnly?Date.now():undefined});
  return true;
}

/** Marks a preview as used now; returns false when the project has no running preview. */
export function touchPreview(projectId:string,now=Date.now()){
  const current=previews.get(projectId);
  if(!current)return false;
  previews.set(projectId,{...current,lastUsedAt:now});
  return true;
}
