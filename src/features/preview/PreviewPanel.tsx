import { ExternalLink, Monitor, RefreshCw, ScrollText, Square, Terminal, X } from "lucide-react";
import { useCallback,useEffect,useState } from "react";
import { getPreviewLogs,getPreviewStatus,startPreview,stopPreview,touchPreview } from "../../lib/project-api";
import type { PreviewState } from "../../lib/types";

type Face="preview"|"logs";

/**
 * Адрес живого превью. Слэш в конце обязателен: без него относительные ссылки приложения
 * ("style.css", "app.js") разрешаются на уровень выше — в платформенный 404 с JSON, и браузер
 * отказывается применять стили и скрипты ("MIME type application/json"). Сервер так же
 * перенаправляет вход без слэша на этот адрес.
 */
function previewUrl(projectId:string){return "/api/projects/"+encodeURIComponent(projectId)+"/preview/open/";}

export function PreviewPanel({projectId,reloadToken=0,open=false,onClose,onRunningChange}:{projectId:string;reloadToken?:number;open?:boolean;onClose?:()=>void;onRunningChange?:(running:boolean)=>void}){
  const [preview,setPreview]=useState<PreviewState>({running:false});
  const [face,setFace]=useState<Face>("preview");
  const [logs,setLogs]=useState("");
  const [error,setError]=useState("");
  const [logsError,setLogsError]=useState("");
  const [loadingLogs,setLoadingLogs]=useState(false);

  const refresh=async()=>{setError("");try{setPreview(await getPreviewStatus(projectId))}catch(e){setError(e instanceof Error?e.message:"Не удалось получить статус preview")}};
  // Refreshed when the project changes and after every agent run: a preview the agent
  // started through preview.start shows up here without the user pressing anything.
  useEffect(()=>{void refresh()},[projectId,reloadToken]);

  const loadLogs=useCallback(async()=>{
    setLoadingLogs(true);setLogsError("");
    try{setLogs((await getPreviewLogs(projectId)).logs)}
    catch(e){setLogsError(e instanceof Error?e.message:"Не удалось получить логи")}
    finally{setLoadingLogs(false)}
  },[projectId]);

  // An open, visible panel keeps the preview alive: the server stops a preview nobody has
  // used for PREVIEW_IDLE_MS (five minutes by default), and a closed tab simply stops
  // sending the heartbeat, so the container is freed.
  useEffect(()=>{
    if(!preview.running)return;
    const beat=()=>{
      if(document.visibilityState!=="visible")return;
      void touchPreview(projectId).catch(()=>undefined);
    };
    beat();
    const timer=window.setInterval(beat,60000);
    return ()=>window.clearInterval(timer);
  },[preview.running,projectId]);

  // Logs refresh while the back face is visible, so the dev server output stays current.
  useEffect(()=>{
    if(face!=="logs")return;
    void loadLogs();
    const timer=setInterval(()=>void loadLogs(),4000);
    return ()=>clearInterval(timer);
  },[face,loadLogs]);

  // On a phone the panel is a drawer, and every other overlay here closes on Escape.
  useEffect(()=>{
    if(!open)return;
    const onKey=(event:KeyboardEvent)=>{if(event.key==="Escape")onClose?.()};
    window.addEventListener("keydown",onKey);
    return ()=>window.removeEventListener("keydown",onKey);
  },[open,onClose]);

  // Whether the preview is live is shown on the top-bar button that opens this drawer.
  useEffect(()=>{onRunningChange?.(Boolean(preview.running))},[preview.running,onRunningChange]);

  async function start(){
    setError("");
    try{setPreview(await startPreview(projectId))}
    catch(e){setError(e instanceof Error?e.message:"Не удалось запустить preview")}
  }
  async function stop(){
    setError("");
    try{await stopPreview(projectId);setPreview({running:false})}
    catch(e){setError(e instanceof Error?e.message:"Не удалось остановить preview")}
  }

  return <>
  {/* Затемнение и панель — одна выезжающая поверх рабочей области пара: на широком экране
      и то, и другое скрыто, панель остаётся обычной колонкой справа. */}
  <div className={"preview-backdrop"+(open?" open":"")} onClick={onClose} aria-hidden="true"/>
  <aside id="preview-panel" className={"preview"+(open?" open":"")}>
    <div className="preview-grabber" aria-hidden="true"><span/></div>
    <div className="preview-head">
      <div><span className="eyebrow">ПРЕДПРОСМОТР</span><strong>{face==="preview"?"Рабочая область":"Логи запуска"}</strong></div>
      <div className="preview-actions">
        <div className="preview-flip" role="tablist" aria-label="Переключить превью и логи">
          <button role="tab" aria-selected={face==="preview"} className={face==="preview"?"active":""} onClick={()=>setFace("preview")}><Monitor size={13}/> Превью</button>
          <button role="tab" aria-selected={face==="logs"} className={face==="logs"?"active":""} onClick={()=>setFace("logs")}><ScrollText size={13}/> Логи</button>
        </div>
        {face==="preview"
          ? <>
              {preview.running?<button className="icon-button" onClick={()=>void stop()} title="Остановить"><Square size={14}/></button>:<button className="icon-button" onClick={()=>void start()} title="Запустить"><Terminal size={14}/></button>}
              <button className="icon-button" onClick={()=>void refresh()} title="Обновить"><RefreshCw size={14}/></button>
              {preview.running&&<a className="icon-button" href={previewUrl(projectId)} target="_blank" rel="noreferrer" title="Открыть"><ExternalLink size={14}/></a>}
            </>
          : <button className="icon-button" onClick={()=>void loadLogs()} disabled={loadingLogs} title="Обновить логи"><RefreshCw size={14}/></button>}
        <button className="icon-button preview-close" onClick={onClose} title="Скрыть панель" aria-label="Скрыть панель"><X size={15}/></button>
      </div>
    </div>
    {error&&<div className="preview-error">{error}</div>}
    {!error&&preview.running&&preview.ready===false&&<div className="preview-hint">{preview.hint??"Приложение ещё запускается…"}</div>}
    {/* Статический режим отдаёт собранную версию: обновления появляются после сборки, а не сами. */}
    {!error&&preview.running&&preview.mode==="static"&&<div className="preview-hint">Статическая сборка: показывается собранная версия приложения, горячей перезагрузки нет.</div>}
    <div className="preview-body">
      <div className={"preview-stage"+(face==="logs"?" flipped":"")}>
        <div className="preview-face preview-front">
          {preview.running
            ? <iframe key={reloadToken} className="preview-frame" title="Живой предпросмотр" src={previewUrl(projectId)}/>
            : <div className="preview-empty"><div className="preview-icon"><Terminal size={20}/></div><strong>Предпросмотр проекта</strong><span>Запусти preview после создания файлов проекта.</span><button className="ghost-button" onClick={()=>void start()}>Запустить preview</button></div>}
        </div>
        <div className="preview-face preview-back">
          <div className="preview-logs-head">
            <span className={preview.running?"preview-logs-live":"preview-logs-idle"}>{preview.running?"Предпросмотр запущен":"Предпросмотр остановлен"}</span>
            <small>{loadingLogs?"обновляем…":"обновление каждые 4 секунды"}</small>
          </div>
          {logsError&&<div className="preview-error preview-logs-error">{logsError}</div>}
          <pre className="preview-logs">{logs||(preview.running?"Пока нет вывода. Логи появятся, когда приложение что-нибудь напишет.":"Запустите предпросмотр, чтобы увидеть логи запуска.")}</pre>
          {!preview.running&&<div className="preview-logs-actions"><button className="ghost-button" onClick={()=>void start()}>Запустить preview</button></div>}
        </div>
      </div>
    </div>
  </aside>
  </>;
}
