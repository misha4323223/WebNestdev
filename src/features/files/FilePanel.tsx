import { ArrowLeft,Check,ChevronRight,Download,ExternalLink,FileCode,Folder,Loader2,Pencil,RefreshCw,Search } from "lucide-react";
import { useEffect,useMemo,useRef,useState,type KeyboardEvent as ReactKeyboardEvent } from "react";
import { downloadProjectZip,getProjectFile,listProjectFiles,projectAssetUrl,saveProjectFile } from "../../lib/project-api";
import type { FileEntry } from "../../lib/types";
import { Hint } from "../../components/Hint";

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

/** Расширение, которое редактор открывает как текст: по нему видно, что файл вообще правится. */
const TEXT_FILE=/\.(?:[cm]?[jt]sx?|json|css|scss|sass|less|html?|md|txt|svg|yml|yaml|toml|env|sql|sh|py|rb|go|rs|java|php)$/i;
/** Растровая картинка: сервер отдаёт её маршрутом `/asset`, а панель показывает изображением. */
const IMAGE_FILE=/\.(?:png|jpe?g|webp|gif|avif|bmp|ico)$/i;

/** Имя без пути — для заголовка редактора: полный путь остаётся в подсказке. */
function baseName(file:string){
  return file.split("/").pop()||file;
}

/**
 * Файлы проекта: список, просмотр и прямое редактирование.
 *
 * Правка идёт прямо в файл проекта, без агента: опечатку в подписи или цвет в одном правиле
 * человек исправляет сам, и тратить на это шаг модели незачем. Агент всё равно увидит правку —
 * он читает те же файлы, а изменения попадают в «Изменения» как обычная работа.
 *
 * Панель выглядит редактором, а не просмотрщиком: строка состояния, номера строк, Tab и Ctrl+S
 * на месте, а «Сохранить» всегда на виду. Раньше это был голый textarea, и заметить, что файл
 * вообще можно править, было почти нельзя.
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
  const [filter,setFilter]=useState("");
  const [cursor,setCursor]=useState({line:1,column:1});
  const [mobileFocus,setMobileFocus]=useState(false);
  const [error,setError]=useState("");
  const sourceRef=useRef<HTMLTextAreaElement|null>(null);
  const gutterRef=useRef<HTMLDivElement|null>(null);

  const dirty=Boolean(opened&&!opened.binary&&draft!==opened.content);
  const lines=useMemo(()=>draft.split("\n").length,[draft]);
  // Каталоги показываются всегда: иначе поиск «index» прятал бы папку, через которую к нему идут.
  const visibleFiles=useMemo(()=>{
    const query=filter.trim().toLowerCase();
    if(!query)return files;
    return files.filter(file=>file.type==="directory"||file.name.toLowerCase().includes(query));
  },[files,filter]);

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
      setMobileFocus(false);
      setFilter("");
    }catch(failure){
      setError(failure instanceof Error?failure.message:"Не удалось прочитать папку проекта");
    }finally{setLoading(false)}
  }

  // Смена проекта — это другой набор файлов: старый черновик к нему не относится и спрашивать
  // о нём нечего.
  useEffect(()=>{setOpened(null);setDraft("");setSaved(false);setMobileFocus(false);void load(".",true)},[projectId]);

  /** Позиция курсора в строке состояния: по ней видно, что это настоящий редактор, а не просмотр. */
  function updateCursor(element:HTMLTextAreaElement){
    const upto=element.value.slice(0,element.selectionStart??0);
    const lastBreak=upto.lastIndexOf("\n");
    setCursor({line:upto.split("\n").length,column:upto.length-lastBreak});
  }

  async function open(entry:TreeEntry){
    if(entry.type==="directory"){await load(entry.path);return}
    if(!keepDraft())return;
    setError("");
    try{
      const file=await getProjectFile(projectId,entry.path);
      setOpened({path:file.path,content:file.content,binary:file.binary===true});
      setDraft(file.content);
      setSaved(false);
      setCursor({line:1,column:1});
      setMobileFocus(!file.binary);
      // Курсор ставится после отрисовки: до неё textarea ещё показывает старый файл.
      window.requestAnimationFrame(()=>{
        const element=sourceRef.current;
        if(!element||file.binary)return;
        element.focus({preventScroll:true});
        element.setSelectionRange(0,0);
      });
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

  function leaveEditor(){
    if(!keepDraft())return;
    setOpened(null);setDraft("");setSaved(false);setMobileFocus(false);
  }

  /** Tab вставляет отступ, а не уводит фокус: без этого правка JSON и CSS в панели неудобна. */
  function insertTab(event:ReactKeyboardEvent<HTMLTextAreaElement>){
    if(event.key!=="Tab"||event.shiftKey)return;
    event.preventDefault();
    const element=event.currentTarget;
    const start=element.selectionStart;
    const end=element.selectionEnd;
    const next=draft.slice(0,start)+"  "+draft.slice(end);
    setDraft(next);setSaved(false);
    window.requestAnimationFrame(()=>{
      element.setSelectionRange(start+2,start+2);
      updateCursor(element);
    });
  }

  const parent=currentPath==="."?null:currentPath.split("/").slice(0,-1).join("/")||".";
  return <section className="files-panel">
    <div className="panel-title">
      <div><span className="eyebrow">ФАЙЛЫ</span><span className="panel-title-strong"><strong>{currentPath==="."?"Корень проекта":currentPath}</strong><Hint label="Файлы проекта">Правьте файлы прямо здесь — агент увидит изменения.</Hint></span></div>
      <div className="files-head-actions">
        <button className="ghost-button" onClick={()=>void download()} disabled={downloading} title="Скачать проект архивом (.zip)" aria-label="Скачать проект архивом">
          {downloading?<Loader2 size={14} className="spin"/>:<Download size={14}/>} ZIP
        </button>
        <button className="ghost-button" onClick={()=>void load()} disabled={loading}><RefreshCw size={14}/> Обновить</button>
      </div>
    </div>
    {error&&<div className="file-error" role="alert">{error}</div>}
    <div className={"file-browser"+(opened?" has-file":" is-browsing")+(mobileFocus?" editing":"")}>
      <div className="file-tree">
        <label className="file-filter">
          <Search size={12}/>
          <input value={filter} onChange={event=>setFilter(event.target.value)} placeholder="Найти файл" aria-label="Найти файл в папке" title="Поиск по имени файла" spellCheck={false}/>
        </label>
        {parent&&<button className="file-item file-parent" onClick={()=>void load(parent)}><ChevronRight size={14}/><span>..</span></button>}
        {visibleFiles.map(file=><button className={"file-item "+(opened?.path===file.path?"selected ":"")+(file.type==="directory"?"folder":"")} key={file.path} onClick={()=>void open(file)} title={file.type==="directory"?"Открыть папку":"Открыть в редакторе"}>
          {file.type==="directory"?<Folder size={15}/>:<FileCode size={15}/>}
          <span>{file.name}</span>
          {file.type==="directory"&&<ChevronRight size={13}/>}
          {file.type==="file"&&TEXT_FILE.test(file.name)&&<Pencil size={11} className="file-edit-mark"/>}
          {dirty&&opened?.path===file.path&&<i className="file-dirty-dot" title="Есть несохранённые правки"/>}
        </button>)}
        {!visibleFiles.length&&!loading&&<div className="file-empty">{filter?"Ничего не нашлось":"Папка пуста"}</div>}
      </div>
      <div className="file-editor">
        {opened&&<>
          <div className="editor-head">
            <button className="editor-back" onClick={leaveEditor} title="К списку файлов" aria-label="К списку файлов"><ArrowLeft size={13}/></button>
            <span className="editor-mode" title="Ctrl+S сохраняет"><Pencil size={11}/> Редактор</span>
            <span className="editor-path" title={opened.path}>{baseName(opened.path)}</span>
            {!opened.binary&&<div className="editor-actions">
              {dirty?<span className="editor-dirty">не сохранено</span>
                :saved?<span className="editor-saved"><Check size={11}/> Сохранено</span>:null}
              {dirty&&<button className="ghost-button editor-revert" onClick={()=>{setDraft(opened.content);setSaved(false)}} disabled={saving} title="Вернуть содержимое файла">Отменить</button>}
              <button className="editor-save" onClick={()=>void save()} disabled={!dirty||saving} title="Сохранить (Ctrl+S)">
                {saving?<><Loader2 size={11} className="spin"/> Сохраняем</>:"Сохранить"}
              </button>
            </div>}
          </div>
          {opened.binary
            ? IMAGE_FILE.test(opened.path)
              // Картинку агента (или загруженное фото) надо увидеть, а не прочитать как «двоичный
              // файл»: панель показывает её сама и даёт открыть в новой вкладке.
              ? <div className="file-image">
                  <img src={projectAssetUrl(projectId,opened.path)} alt={baseName(opened.path)} loading="lazy"/>
                  <a href={projectAssetUrl(projectId,opened.path)} target="_blank" rel="noreferrer" title="Открыть изображение в новой вкладке">
                    <ExternalLink size={12}/> Открыть в новой вкладке
                  </a>
                </div>
              : <div className="file-placeholder"><FileCode size={20}/><span>Двоичный файл: только просмотр.</span></div>
            : <>
                <div className="file-editor-body">
                  {/* Номера строк — отдельная колонка: у textarea нет нумерации, а без неё
                      редактор выглядит обычным полем заметок и правку в нём не замечают. */}
                  <div className="file-gutter" ref={gutterRef} aria-hidden="true">
                    {Array.from({length:Math.min(lines,20000)},(_,index)=><span key={index}>{index+1}</span>)}
                  </div>
                  <textarea
                    ref={sourceRef}
                    className="file-source"
                    value={draft}
                    wrap="off"
                    spellCheck={false}
                    autoComplete="off"
                    onChange={event=>{setDraft(event.target.value);setSaved(false);updateCursor(event.target)}}
                    onKeyDown={event=>{
                      insertTab(event);
                      if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="s"){
                        event.preventDefault();
                        void save();
                      }
                    }}
                    onKeyUp={event=>updateCursor(event.currentTarget)}
                    onClick={event=>updateCursor(event.currentTarget)}
                    onScroll={event=>{if(gutterRef.current)gutterRef.current.scrollTop=event.currentTarget.scrollTop}}
                    aria-label={"Содержимое файла "+opened.path}
                  />
                </div>
                <div className="file-statusbar">
                  <span>Стр {cursor.line}, столб {cursor.column}</span>
                  <span>{lines} {lines%10===1&&lines%100!==11?"строка":lines%10>=2&&lines%10<=4&&(lines%100<12||lines%100>14)?"строки":"строк"}</span>
                  <span className="file-status-note">Ctrl+S сохраняет.</span>
                </div>
              </>}
        </>}
      </div>
    </div>
  </section>;
}
