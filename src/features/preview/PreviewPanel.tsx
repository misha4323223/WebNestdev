import { ExternalLink, RefreshCw, Square, Terminal } from "lucide-react";
import { useEffect,useState } from "react";
import { getPreviewStatus,startPreview,stopPreview } from "../../lib/project-api";
import type { PreviewState } from "../../lib/types";

export function PreviewPanel({projectId}:{projectId:string}){
  const [preview,setPreview]=useState<PreviewState>({running:false});
  const refresh=()=>getPreviewStatus(projectId).then(setPreview).catch(()=>setPreview({running:false}));
  useEffect(()=>{void refresh()},[projectId]);
  async function start(){try{setPreview(await startPreview(projectId))}catch{setPreview({running:false})}}
  async function stop(){await stopPreview(projectId).catch(()=>{});setPreview({running:false})}
  return <aside className="preview">
    <div className="preview-head"><div><span className="eyebrow">PREVIEW</span><strong>Рабочая область</strong></div><div className="preview-actions">
      {preview.running?<button className="icon-button" onClick={()=>void stop()}><Square size={14}/></button>:<button className="icon-button" onClick={()=>void start()}><Terminal size={14}/></button>}
      <button className="icon-button" onClick={()=>void refresh()}><RefreshCw size={14}/></button>
      {preview.running&&<a className="icon-button" href={"/api/projects/"+projectId+"/preview/open"} target="_blank" rel="noreferrer"><ExternalLink size={14}/></a>}
    </div></div>
    {preview.running?<iframe className="preview-frame" title="Live preview" src={"/api/projects/"+projectId+"/preview/open"}/>:<div className="preview-empty"><div className="preview-icon"><Terminal size={20}/></div><strong>Предпросмотр проекта</strong><span>Запусти preview после создания файлов проекта.</span><button className="ghost-button" onClick={()=>void start()}>Запустить preview</button></div>}
  </aside>;
}
