import { FolderGit2, RefreshCw } from "lucide-react";
import { useEffect,useState } from "react";
import { listProjectFiles } from "../../lib/project-api";
import type { FileEntry } from "../../lib/types";

export function FilePanel({projectId}:{projectId:string}){
  const [files,setFiles]=useState<FileEntry[]>([]);
  const load=()=>listProjectFiles(projectId).then(d=>setFiles(d.files)).catch(()=>setFiles([]));
  useEffect(()=>{void load()},[projectId]);
  return <div className="panel"><div className="panel-title">Файлы проекта <button className="ghost-button" onClick={()=>void load()}><RefreshCw size={14}/> Обновить</button></div><div className="file-list">{files.map(f=><div className="file-item" key={f.name}><FolderGit2 size={15}/><span>{f.name}</span><span>{f.type}</span></div>)}</div></div>;
}
