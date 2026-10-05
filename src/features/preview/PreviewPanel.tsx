import { ExternalLink, RefreshCw, Square, Terminal } from "lucide-react";
import { useEffect,useState } from "react";
import { getPreviewStatus,startPreview,stopPreview } from "../../lib/project-api";
import type { PreviewState } from "../../lib/types";

export function PreviewPanel({projectId}:{projectId:string}){
  const [preview,setPreview]=useState<PreviewState>({running:false});
  const [error,setError]=useState("");
  const refresh=async()=>{setError("");try{setPreview(await getPreviewStatus(projectId))}catch(e){setError(e instanceof Error?e.message:"Не удалось получить статус preview")}};
  useEffect(()=>{void refresh()},[projectId]);
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
    <div className="preview-head"><div><span className="eyebrow">PREVIEW</span><strong>Рабочая область</strong></div><div className="preview-actions">
      {preview.running?<button className="icon-button" onClick={()=>void stop()} title="Остановить"><Square size={14}/></button>:<button className="icon-button" onClick={()=>void start()} title="Запустить"><Terminal size={14}/></button>}
      <button className="icon-button" onClick={()=>void refresh()} title="Обновить"><RefreshCw size={14}/></button>
      {preview.running&&<a className="icon-button" href={"/api/projects/"+projectId+"/preview/open"} target="_blank" rel="noreferrer" title="Открыть"><ExternalLink size={14}/></a>}
    </div></div>
    {error&&<div className="preview-error">{error}</div>}
    {preview.running?<iframe className="preview-frame" title="Live preview" src={"/api/projects/"+projectId+"/preview/open"}/>:<div className="preview-empty"><div className="preview-icon"><Terminal size={20}/></div><strong>Предпросмотр проекта</strong><span>Запусти preview после создания файлов проекта.</span><button className="ghost-button" onClick={()=>void start()}>Запустить preview</button></div>}
  </aside>;
}
