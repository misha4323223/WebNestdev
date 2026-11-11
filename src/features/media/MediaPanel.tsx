import { useEffect,useMemo,useRef,useState } from "react";
import { AlertTriangle,Check,Copy,ExternalLink,FileText,Image as ImageIcon,Loader2,Pencil,RefreshCw,Search,Trash2,Upload } from "lucide-react";
import { Hint } from "../../components/Hint";
import { copyText } from "../../lib/clipboard";
import {
  deleteUploadedMedia,
  listProjectMedia,
  renameProjectMedia,
  uploadProjectMedia,
  type ProjectMediaObject,
} from "../../lib/media-api";

const IMAGE_FILE=/\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;

function formatBytes(bytes:number){
  if(bytes<1024)return bytes+" Б";
  if(bytes<1024*1024)return Math.round(bytes/1024)+" КБ";
  if(bytes<1024*1024*1024)return (bytes/1024/1024).toFixed(1)+" МБ";
  return (bytes/1024/1024/1024).toFixed(2)+" ГБ";
}

function formatDate(value:string){
  const date=new Date(value);
  if(Number.isNaN(date.getTime()))return "";
  return date.toLocaleDateString("ru-RU",{day:"numeric",month:"short",year:"numeric"});
}

function usageLabel(object:ProjectMediaObject){
  if(!object.usage)return "проверка ссылок недоступна";
  if(!object.usage.count)return "не используется в проекте";
  return "используется: "+object.usage.count;
}

/**
 * Медиа проекта — это не файлы в `public`, а объекты публичного бакета. Поэтому вкладка
 * показывает сам бакет, а не только то, что осталось в истории чата: забытый файл можно
 * найти, удалить, переименовать или заменить.
 *
 * Замена пишется в тот же ключ, поэтому URL в коде не меняется — это безопасный путь для
 * картинки, которая уже используется. Переименование меняет URL, поэтому сервер разрешает
 * его только для неиспользуемых файлов; удаление используемого требует явного подтверждения.
 */
export function MediaPanel({projectId,onChanged}:{projectId:string;onChanged?:()=>void}){
  const [objects,setObjects]=useState<ProjectMediaObject[]>([]);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [selectedKey,setSelectedKey]=useState("");
  const [filter,setFilter]=useState("");
  const [unusedOnly,setUnusedOnly]=useState(false);
  const [busy,setBusy]=useState("");
  const [progress,setProgress]=useState(0);
  const [copiedKey,setCopiedKey]=useState("");
  const [replaceTarget,setReplaceTarget]=useState<ProjectMediaObject|null>(null);
  const replaceInput=useRef<HTMLInputElement|null>(null);
  const usageTruncated=useRef(false);
  const usageAvailable=useRef(true);

  const selected=useMemo(
    ()=>objects.find(object=>object.key===selectedKey)??objects[0]??null,
    [objects,selectedKey],
  );
  const visible=useMemo(()=>{
    const query=filter.trim().toLowerCase();
    return objects.filter(object=>
      (!query||object.name.toLowerCase().includes(query)||object.key.toLowerCase().includes(query))&&
      (!unusedOnly||object.usage?.count===0)
    );
  },[objects,filter,unusedOnly]);
  const totalBytes=useMemo(()=>objects.reduce((sum,object)=>sum+object.bytes,0),[objects]);
  const unusedCount=useMemo(()=>objects.filter(object=>object.usage?.count===0).length,[objects]);

  async function load(){
    setLoading(true);
    setError("");
    try{
      const data=await listProjectMedia(projectId);
      setObjects(data.objects);
      usageTruncated.current=data.usageTruncated;
      usageAvailable.current=data.usageAvailable;
      setSelectedKey(current=>data.objects.some(object=>object.key===current)?current:(data.objects[0]?.key??""));
    }catch(failure){
      setError(failure instanceof Error?failure.message:"Не удалось прочитать вложения проекта");
    }finally{setLoading(false)}
  }

  // load uses the current project id; the dependency is the project switch itself.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload media only when the project changes; load reads the current project id
  useEffect(()=>{
    setObjects([]);
    setSelectedKey("");
    setError("");
    setNotice("");
    usageTruncated.current=false;
    usageAvailable.current=true;
    void load();
  },[projectId]);

  async function copy(url:string,key:string){
    if(await copyText(url)){
      setCopiedKey(key);
      window.setTimeout(()=>setCopiedKey(current=>current===key?"":current),1800);
    }else{
      setNotice("Браузер не разрешил скопировать ссылку");
    }
  }

  function beginReplace(object:ProjectMediaObject){
    setReplaceTarget(object);
    replaceInput.current?.click();
  }

  async function replaceFile(file:File|null){
    const target=replaceTarget;
    if(!file||!target)return;
    setBusy("replace:"+target.key);
    setProgress(0);
    setError("");
    setNotice("");
    try{
      const result=await uploadProjectMedia(
        projectId,
        file,
        (done,total)=>setProgress(Math.round(done/total*100)),
        {replaceKey:target.key},
      );
      setNotice("Файл заменён. Публичная ссылка не изменилась.");
      setSelectedKey(result.key);
      await load();
      onChanged?.();
    }catch(failure){
      setError(failure instanceof Error?failure.message:"Не удалось заменить файл");
    }finally{
      setBusy("");
      setProgress(0);
      setReplaceTarget(null);
    }
  }

  async function remove(object:ProjectMediaObject){
    const used=object.usage?.count??0;
    const unknown=object.usage===null;
    const files=object.usage?.files.slice(0,5).map(file=>"• "+file.path+":"+file.line).join("\n")??"";
    const question=unknown
      ? "Не удалось проверить, используется ли «"+object.name+"» в проекте. Если ссылка есть, она станет битой. Удалить всё равно?"
      : used
        ? "Файл «"+object.name+"» используется в проекте:\n\n"+(files||"ссылки найдены")+"\n\nЕсли удалить его, ссылки станут битыми. Удалить всё равно?"
        : "Удалить «"+object.name+"» из хранилища?";
    if(!window.confirm(question))return;
    setBusy("delete:"+object.key);
    setError("");
    setNotice("");
    try{
      await deleteUploadedMedia(projectId,object.key,used>0||unknown);
      setNotice("Файл удалён из хранилища.");
      if(selectedKey===object.key)setSelectedKey("");
      await load();
      onChanged?.();
    }catch(failure){
      setError(failure instanceof Error?failure.message:"Не удалось удалить файл");
    }finally{setBusy("")}
  }

  async function rename(object:ProjectMediaObject){
    if(object.usage?.count){
      setNotice("Файл используется в проекте. Переименование изменит URL и сломает ссылки — используйте «Заменить».");
      return;
    }
    const next=window.prompt("Новое имя файла",object.name);
    if(!next||next.trim()===object.name)return;
    setBusy("rename:"+object.key);
    setError("");
    setNotice("");
    try{
      const result=await renameProjectMedia(projectId,object.key,next.trim());
      setNotice("Файл переименован: "+result.name);
      setSelectedKey(result.key);
      await load();
      onChanged?.();
    }catch(failure){
      setError(failure instanceof Error?failure.message:"Не удалось переименовать файл");
    }finally{setBusy("")}
  }

  function selectObject(object:ProjectMediaObject){
    setSelectedKey(object.key);
    setNotice("");
    setError("");
  }

  return <section className="files-panel media-panel">
    <div className="panel-title">
      <div>
        <span className="eyebrow">ВЛОЖЕНИЯ</span>
        <span className="panel-title-strong"><strong>Файлы в хранилище</strong><Hint label="Вложения проекта">Здесь видны все большие вложения проекта, даже если чат с ними уже удалён.</Hint></span>
      </div>
      <button className="ghost-button" onClick={()=>void load()} disabled={loading||Boolean(busy)} title="Обновить список">
        {loading?<Loader2 size={14} className="spin"/>:<RefreshCw size={14}/>} Обновить
      </button>
    </div>

    {error&&<div className="file-error" role="alert">{error}</div>}
    {notice&&<div className="media-notice" role="status">{notice}</div>}
    {!usageAvailable.current&&<div className="media-warning"><AlertTriangle size={13}/> Не удалось проверить ссылки в проекте: удаление потребует подтверждения.</div>}
    {usageAvailable.current&&usageTruncated.current&&<div className="media-warning"><AlertTriangle size={13}/> Проверены не все файлы проекта — часть ссылок могла остаться незамеченной.</div>}

    <div className="media-toolbar">
      <label className="file-filter media-filter">
        <Search size={12}/>
        <input value={filter} onChange={event=>setFilter(event.target.value)} placeholder="Найти файл" aria-label="Найти файл" spellCheck={false}/>
      </label>
      <label className="media-unused-filter">
        <input type="checkbox" checked={unusedOnly} onChange={event=>setUnusedOnly(event.target.checked)}/>
        Только неиспользуемые
      </label>
      <span className="media-summary">{objects.length} файлов · {formatBytes(totalBytes)}{usageAvailable.current?" · не используется в проекте: "+unusedCount:""}</span>
    </div>

    <div className="media-browser">
      <div className="media-list">
        {visible.map(object=>{
          const image=IMAGE_FILE.test(object.name)||IMAGE_FILE.test(object.key);
          return <button className={"media-card"+(selected?.key===object.key?" selected":"")} key={object.key} onClick={()=>selectObject(object)} title={object.name}>
            <span className="media-thumb">
              {image?<img src={object.url} alt="" loading="lazy"/>:<FileText size={18}/>}
            </span>
            <span className="media-card-text">
              <strong>{object.name}</strong>
              <small>{formatBytes(object.bytes)}{object.lastModified?" · "+formatDate(object.lastModified):""}</small>
              <em className={object.usage?.count?"used":"unused"}>{usageLabel(object)}</em>
            </span>
          </button>;
        })}
        {!visible.length&&!loading&&<div className="file-empty">{objects.length?"Ничего не нашлось":"В хранилище пока нет файлов"}</div>}
        {loading&&!objects.length&&<div className="media-loading"><Loader2 size={18} className="spin"/> Читаем хранилище…</div>}
      </div>

      <div className="media-detail">
        {selected?<>
          <div className="media-detail-head">
            <div>
              <span className="eyebrow">{IMAGE_FILE.test(selected.name)?"ИЗОБРАЖЕНИЕ":"ФАЙЛ"}</span>
              <strong title={selected.name}>{selected.name}</strong>
            </div>
            <span className={"media-usage-badge"+(selected.usage?.count?" used":" unused")}>{usageLabel(selected)}</span>
          </div>

          <div className="media-preview">
            {IMAGE_FILE.test(selected.name)||IMAGE_FILE.test(selected.key)
              ? <img src={selected.url} alt={selected.name}/>
              : <div className="media-file-placeholder"><FileText size={30}/><span>{selected.name}</span></div>}
          </div>

          <div className="media-meta">
            <span>{formatBytes(selected.bytes)}</span>
            {selected.lastModified&&<span>Загружен {formatDate(selected.lastModified)}</span>}
            <span>Ключ: <code>{selected.key}</code></span>
          </div>

          <div className="media-url-row">
            <code title={selected.url}>{selected.url}</code>
            <button className="ghost-button" onClick={()=>void copy(selected.url,selected.key)} title="Скопировать публичную ссылку">
              {copiedKey===selected.key?<Check size={13}/>:<Copy size={13}/>} {copiedKey===selected.key?"Скопировано":"Копировать"}
            </button>
          </div>

          {selected.usage?.count?<div className="media-usage-list">
            <span><AlertTriangle size={13}/> Ссылка встречается в проекте — замена безопасна, удаление и переименование могут её сломать.</span>
            {selected.usage.files.slice(0,8).map(file=><code key={file.path+":"+file.line}>{file.path}:{file.line}</code>)}
            {selected.usage.files.length<selected.usage.count&&<small>Показаны первые {selected.usage.files.length} вхождений из {selected.usage.count}.</small>}
          </div>:<div className="media-usage-list unused"><Check size={13}/> В исходниках ссылок не найдено. Внешние ссылки не проверяются — удаление и переименование меняют URL.</div>}

          <div className="media-actions">
            <button className="ghost-button" onClick={()=>beginReplace(selected)} disabled={Boolean(busy)} title="Загрузить новый файл в тот же ключ: URL не изменится">
              {busy==="replace:"+selected.key?<Loader2 size={13} className="spin"/>:<Upload size={13}/>} Заменить
            </button>
            <button className="ghost-button" onClick={()=>void rename(selected)} disabled={Boolean(busy)||Boolean(selected.usage?.count)||!selected.usage} title={selected.usage?.count?"Используемый файл переименовывать нельзя — URL изменится":"Переименовать файл и его URL"}>
              <Pencil size={13}/> Переименовать
            </button>
            <button className="ghost-button danger" onClick={()=>void remove(selected)} disabled={Boolean(busy)} title="Удалить файл из хранилища">
              {busy==="delete:"+selected.key?<Loader2 size={13} className="spin"/>:<Trash2 size={13}/>} Удалить
            </button>
            <a className="ghost-button" href={selected.url} target="_blank" rel="noreferrer" title="Открыть публичный файл">
              <ExternalLink size={13}/> Открыть
            </a>
          </div>

          {busy==="replace:"+selected.key&&<div className="media-progress"><span style={{width:progress+"%"}}/><small>{progress}%</small></div>}
        </>:<div className="media-empty"><ImageIcon size={28}/><strong>Вложений пока нет</strong><span>Вложения больше 300 КБ из чата появятся здесь и будут доступны по прямой ссылке.</span></div>}
      </div>
    </div>

    <input
      ref={replaceInput}
      type="file"
      hidden
      onChange={event=>{const file=event.target.files?.[0]??null;event.target.value="";void replaceFile(file)}}
    />
  </section>;
}
