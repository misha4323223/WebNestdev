import { ExternalLink, Monitor, RefreshCw, ScrollText, Square, Terminal } from "lucide-react";
import { useCallback,useEffect,useState } from "react";
import { getPreviewLogs,getPreviewStatus,startPreview,stopPreview } from "../../lib/project-api";
import type { PreviewState } from "../../lib/types";

type Face="preview"|"logs";

export function PreviewPanel({projectId}:{projectId:string}){
  const [preview,setPreview]=useState<PreviewState>({running:false});
  const [face,setFace]=useState<Face>("preview");
  const [logs,setLogs]=useState("");
  const [error,setError]=useState("");
  const [logsError,setLogsError]=useState("");
  const [loadingLogs,setLoadingLogs]=useState(false);

  const refresh=async()=>{setError("");try{setPreview(await getPreviewStatus(projectId))}catch(e){setError(e instanceof Error?e.message:"Не удалось получить статус preview")}};
  useEffect(()=>{void refresh()},[projectId]);

  const loadLogs=useCallback(async()=>{
    setLoadingLogs(true);setLogsError("");
    try{setLogs((await getPreviewLogs(projectId)).logs)}
    catch(e){setLogsError(e instanceof Error?e.message:"Не удалось получить логи")}
    finally{setLoadingLogs(false)}
  },[projectId]);

  // Logs refresh while the back face is visible, so the dev server output stays current.
  useEffect(()=>{
    if(face!=="logs")return;
    void loadLogs();
    const timer=setInterval(()=>void loadLogs(),4000);
    return ()=>clearInterval(timer);
  },[face,loadLogs]);

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

  return <aside className="preview">
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
              {preview.running&&<a className="icon-button" href={"/api/projects/"+projectId+"/preview/open"} target="_blank" rel="noreferrer" title="Открыть"><ExternalLink size={14}/></a>}
            </>
          : <button className="icon-button" onClick={()=>void loadLogs()} disabled={loadingLogs} title="Обновить логи"><RefreshCw size={14}/></button>}
      </div>
    </div>
    {error&&<div className="preview-error">{error}</div>}
    <div className="preview-body">
      <div className={"preview-stage"+(face==="logs"?" flipped":"")}>
        <div className="preview-face preview-front">
          {preview.running
            ? <iframe className="preview-frame" title="Живой предпросмотр" src={"/api/projects/"+projectId+"/preview/open"}/>
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
  </aside>;
}
