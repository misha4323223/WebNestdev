import { ChevronRight,FileCode,Folder,FolderOpen,RefreshCw } from "lucide-react";
import { useEffect,useState } from "react";
import { getProjectFile,listProjectFiles } from "../../lib/project-api";
import type { FileEntry } from "../../lib/types";

type TreeEntry=FileEntry&{path:string};

export function FilePanel({projectId}:{projectId:string}){
  const [currentPath,setCurrentPath]=useState(".");
  const [files,setFiles]=useState<TreeEntry[]>([]);
  const [selected,setSelected]=useState<{path:string;content:string}|null>(null);
  const [loading,setLoading]=useState(false);

  async function load(path=currentPath){
    setLoading(true);
    try{
      const data=await listProjectFiles(projectId,path);
      setCurrentPath(data.path||path);
      setFiles(data.files.map(file=>({...file,path:path==="."?file.name:path+"/"+file.name})));
      setSelected(null);
    }finally{setLoading(false)}
  }

  useEffect(()=>{void load(".")},[projectId]);

  async function open(entry:TreeEntry){
    if(entry.type==="directory"){await load(entry.path);return}
    setSelected(await getProjectFile(projectId,entry.path));
  }

  const parent=currentPath==="."?null:currentPath.split("/").slice(0,-1).join("/")||".";
  return <section className="files-panel">
    <div className="panel-title">
      <div><span className="eyebrow">FILES</span><strong>{currentPath==="."?"Корень проекта":currentPath}</strong></div>
      <button className="ghost-button" onClick={()=>void load()} disabled={loading}><RefreshCw size={14}/> Обновить</button>
    </div>
    <div className="file-browser">
      <div className="file-tree">
        {parent&&<button className="file-item file-parent" onClick={()=>void load(parent)}><ChevronRight size={14}/><span>..</span></button>}
        {files.map(file=><button className={"file-item "+(selected?.path===file.path?"selected":"")} key={file.path} onClick={()=>void open(file)}>
          {file.type==="directory"?<Folder size={15}/>:<FileCode size={15}/>}
          <span>{file.name}</span>
          {file.type==="directory"&&<ChevronRight size={13}/>}
        </button>)}
        {!files.length&&!loading&&<div className="file-empty">Папка пуста</div>}
      </div>
      <div className="file-editor">
        {selected?<><div className="editor-head"><span>{selected.path}</span></div><pre>{selected.content}</pre></>:<div className="file-placeholder"><FolderOpen size={20}/><span>Выберите файл, чтобы посмотреть содержимое.</span></div>}
      </div>
    </div>
  </section>;
}
