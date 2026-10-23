import { Check,ChevronRight,Download,FileCode,Folder,FolderOpen,Loader2,RefreshCw } from "lucide-react";
import { useEffect,useState } from "react";
import { downloadProjectZip,getProjectFile,listProjectFiles,saveProjectFile } from "../../lib/project-api";
import type { FileEntry } from "../../lib/types";

type TreeEntry=FileEntry&{path:string};
type Opened={path:string;content:string;binary:boolean};

/**
 * The server hides `.env.local` and its variants already; this second check keeps the panel honest
 * if an older server or a cached response is in front of it. `.env.example` and other templates are
 * documentation, not secrets, so they stay visible.
 */
function isSecretEnvName(name:string){
  if(name!==".env"&&!name.startsWith(".env."))return false;
  return !/\.(example|sample|template)$/.test(name);
}

/**
 * Файлы проекта: список, просмотр и прямое редактирование.
 *
 * Правка идёт прямо в файл проекта, без агента: опечатку в подписи или цвет в одном правиле
 * человек исправляет сам, и тратить на это шаг модели незачем. Агент всё равно увидит правку —
 * он читает те же файлы, а изменения попадают в «Изменения» как обычная работа.
 *
 * Двоичные файлы сервер помечает флагом `binary`: текстовое поле сохранило бы строку поверх
 * байтов и испортило картинку, поэтому такие файлы панель только показывает.
 */
export function FilePanel({projectId,projectName,onSaved}:{projectId:string;projectName:string;onSaved?:()=>void}){
  const [currentPath,setCurrentPath]=useState(".");
  const [files,setFiles]=useState<TreeEntry[]>([]);
  const [opened,setOpened]=useState<Opened|null>(null);
  const [draft,setDraft]=useState("");
  const [loading,setLoading]=useState(false);
  const [saving,setSaving]=useState(false);
  const [saved,setSaved]=useState(false);
  const [downloading,setDownloading]=useState(false);
  const [error,setError]=useState("");

  const dirty=Boolean(opened&&!opened.binary&&draft!==opened.content);

  /** Несохранённую правку нельзя потерять молча: уход из файла спрашивает подтверждение. */
  function keepDraft(){
    if(!dirty)return true;
    return window.confirm("Изменения в «"+(opened as Opened).path+"» не сохранены. Продолжить без сохранения?");
  }

  async function load(target=currentPath,force=false){
    if(!force&&!keepDraft())return;
    setLoading(true);
    setError("");
    try{
      const data=await listProjectFiles(projectId,target);
      setCurrentPath(data.path||target);
      setFiles(data.files
        .filter(file=>!isSecretEnvName(file.name))
        .map(file=>({...file,path:target==="."?file.name:target+"/"+file.name})));
      setOpened(null);
      setDraft("");
      setSaved(false);
    }catch(failure){
      setError(failure instanceof Error?failure.message:"Не удалось прочитать папку проекта");
    }finally{setLoading(false)}
  }

  // Смена проекта — это другой набор файлов: старый черновик к нему не относится и спрашивать
  // о нём нечего.
  useEffect(()=>{setOpened(null);setDraft("");setSaved(false);void load(".",true)},[projectId]);

  async function open(entry:TreeEntry){
    if(entry.type==="directory"){await load(entry.path);return}
    if(!keepDraft())return;
    setError("");
    try{
      const file=await getProjectFile(projectId,entry.path);
      setOpened({path:file.path,content:file.content,binary:file.binary===true});
      setDraft(file.content);
      setSaved(false);
    }catch(failure){
      setError(failure instanceof Error?failure.message:"Не удалось прочитать файл");
    }
  }

  async function save(){
    if(!opened||opened.binary||saving)return;
    setSaving(true);
    setError("");
    try{
      await saveProjectFile(projectId,opened.path,draft);
      setOpened({...opened,content:draft});
      setSaved(true);
      // Предпросмотр перезагружается не сразу, а после ответа: статическая сборка пересобирается
      // на сервере, и кадр должен открыть уже новый файл.
      onSaved?.();
    }catch(failure){
      setError(failure instanceof Error?failure.message:"Не удалось сохранить файл");
    }finally{setSaving(false)}
  }

  async function download(){
    if(downloading)return;
    setDownloading(true);
    setError("");
    try{
      await downloadProjectZip(projectId,projectName);
    }catch(failure){
      setError(failure instanceof Error?failure.message:"Не удалось скачать архив проекта");
    }finally{setDownloading(false)}
  }

  const parent=currentPath==="."?null:currentPath.split("/").slice(0,-1).join("/")||".";
  return <section className="files-panel">
    <div className="panel-title">
      <div><span className="eyebrow">ФАЙЛЫ</span><strong>{currentPath==="."?"Корень проекта":currentPath}</strong></div>
      <div className="files-head-actions">
        <button className="ghost-button" onClick={()=>void download()} disabled={downloading} title="Скачать проект архивом (.zip)" aria-label="Скачать проект архивом">
          {downloading?<Loader2 size={14} className="spin"/>:<Download size={14}/>} ZIP
        </button>
        <button className="ghost-button" onClick={()=>void load()} disabled={loading}><RefreshCw size={14}/> Обновить</button>
      </div>
    </div>
    {error&&<div className="file-error" role="alert">{error}</div>}
    <div className="file-browser">
      <div className="file-tree">
        {parent&&<button className="file-item file-parent" onClick={()=>void load(parent)}><ChevronRight size={14}/><span>..</span></button>}
        {files.map(file=><button className={"file-item "+(opened?.path===file.path?"selected":"")} key={file.path} onClick={()=>void open(file)}>
          {file.type==="directory"?<Folder size={15}/>:<FileCode size={15}/>}
          <span>{file.name}</span>
          {file.type==="directory"&&<ChevronRight size={13}/>}
        </button>)}
        {!files.length&&!loading&&<div className="file-empty">Папка пуста</div>}
      </div>
      <div className="file-editor">
        {opened?<>
          <div className="editor-head">
            <span title={opened.path}>{opened.path}</span>
            {!opened.binary&&<div className="editor-actions">
              {dirty?<span className="editor-dirty">не сохранено</span>
                :saved?<span className="editor-saved"><Check size={11}/> Сохранено</span>:null}
              <button className="editor-save" onClick={()=>void save()} disabled={!dirty||saving} title="Сохранить (Ctrl+S)">
                {saving?<><Loader2 size={11} className="spin"/> Сохраняем</>:"Сохранить"}
              </button>
            </div>}
          </div>
          {opened.binary
            ? <div className="file-placeholder"><FileCode size={20}/><span>Двоичный файл: панель показывает только текст. Такой файл меняет агент.</span></div>
            : <textarea
                className="file-source"
                value={draft}
                spellCheck={false}
                autoComplete="off"
                onChange={event=>{setDraft(event.target.value);setSaved(false)}}
                onKeyDown={event=>{
                  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="s"){
                    event.preventDefault();
                    void save();
                  }
                }}
                aria-label={"Содержимое файла "+opened.path}
              />}
        </>:<div className="file-placeholder"><FolderOpen size={20}/><span>Выберите файл, чтобы посмотреть или отредактировать его.</span></div>}
      </div>
    </div>
  </section>;
}
