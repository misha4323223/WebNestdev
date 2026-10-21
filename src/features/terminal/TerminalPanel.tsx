import { useEffect,useRef,useState } from "react";
import { CornerDownLeft,FolderGit2,LoaderCircle,Trash2 } from "lucide-react";
import { runProjectTerminal } from "../../lib/project-api";

type Entry={id:number;kind:"command"|"output"|"error"|"note";text:string};

/** Путь в приглашении: корень проекта — `~`, вложенная папка — `~/src`. */
function promptPath(cwd:string){return cwd==="."?"~":"~/"+(cwd.startsWith("./")?cwd.slice(2):cwd);}

/** `cd` считается здесь: каждая команда на сервере — новый процесс, поэтому папка живёт в панели. */
function resolveCwd(parent:string,input:string){
  const raw=input.trim().replace(/^~\/?/,"");
  const base=raw.startsWith("/")||!input.trim()||input.trim()==="~"?[]:(parent==="."?[]:parent.split("/"));
  const stack=[...base];
  for(const part of raw.split("/")){
    if(!part||part===".")continue;
    if(part===".."){stack.pop();continue}
    stack.push(part);
  }
  return stack.length?stack.join("/"):".";
}

/**
 * Консоль проекта. Папку выбирать не нужно: терминал открывается в корне проекта, как в Replit —
 * набрал команду и она выполнилась. Приглашение показывает, где ты находишься; `cd` меняет
 * рабочую папку для следующих команд (каждая команда на сервере — отдельный процесс, поэтому
 * папка запоминается здесь, а не в оболочке). История команд — стрелками вверх и вниз.
 */
export function TerminalPanel({projectId}:{projectId:string}){
  const [cwd,setCwd]=useState(".");
  const [entries,setEntries]=useState<Entry[]>([]);
  const [command,setCommand]=useState("");
  const [running,setRunning]=useState(false);
  const [history,setHistory]=useState<string[]>([]);
  const [historyIndex,setHistoryIndex]=useState<number|null>(null);
  const inputRef=useRef<HTMLInputElement|null>(null);
  const logRef=useRef<HTMLDivElement|null>(null);
  const nextId=useRef(0);

  const append=(kind:Entry["kind"],text:string)=>setEntries(list=>[...list,{id:nextId.current++,kind,text}]);

  // Вывод всегда показывает последние строки: терминал, который остаётся наверху после команды,
  // заставляет прокручивать вручную то, что только что пришло.
  useEffect(()=>{
    const box=logRef.current;
    if(box)box.scrollTop=box.scrollHeight;
  },[entries,running]);

  async function run(){
    const text=command.trim();
    if(!text||running)return;
    setCommand("");
    setHistoryIndex(null);
    setHistory(list=>[...list.filter(item=>item!==text),text].slice(-60));

    if(text==="clear"){setEntries([]);return}

    if(text==="cd"||text.startsWith("cd ")){
      const target=resolveCwd(cwd,text.slice(2));
      append("command",promptPath(cwd)+" $ "+text);
      setRunning(true);
      try{
        // Проверка настоящая: сервер запускает `pwd` уже в новой папке и честно ответит, если её нет.
        await runProjectTerminal(projectId,"pwd",target);
        setCwd(target);
        append("note","папка: "+promptPath(target));
      }catch(error){
        append("error",error instanceof Error?error.message:String(error));
      }finally{setRunning(false)}
      return;
    }

    append("command",promptPath(cwd)+" $ "+text);
    setRunning(true);
    try{
      const data=await runProjectTerminal(projectId,text,cwd);
      if(data.stdout)append("output",data.stdout.replace(/\s+$/,""));
      if(data.stderr)append("error",data.stderr.replace(/\s+$/,""));
      if(!data.stdout&&!data.stderr)append("note",data.ok?"команда выполнена без вывода":"команда завершилась с ошибкой без вывода");
    }catch(error){
      append("error",error instanceof Error?error.message:String(error));
    }finally{setRunning(false)}
  }

  /** Стрелки ходят по истории введённого, Ctrl+L очищает экран — как в обычной оболочке. */
  function onKeyDown(event:React.KeyboardEvent<HTMLInputElement>){
    if(event.key==="Enter"&&!event.shiftKey){event.preventDefault();void run();return}
    if(event.ctrlKey&&event.key.toLowerCase()==="l"){event.preventDefault();setEntries([]);return}
    if(event.key==="ArrowUp"){
      event.preventDefault();
      if(!history.length)return;
      const index=historyIndex===null?history.length-1:Math.max(0,historyIndex-1);
      setHistoryIndex(index);setCommand(history[index]??"");
      return;
    }
    if(event.key==="ArrowDown"){
      event.preventDefault();
      if(historyIndex===null)return;
      const index=historyIndex+1;
      if(index>=history.length){setHistoryIndex(null);setCommand("");return}
      setHistoryIndex(index);setCommand(history[index]??"");
    }
  }

  return <section className="panel terminal-panel">
    <div className="panel-title">
      <div><span className="eyebrow">ТЕРМИНАЛ</span><strong>Консоль проекта</strong></div>
      <div className="terminal-head-actions">
        <span className="terminal-path" title="Рабочая папка команд"><FolderGit2 size={12}/>{promptPath(cwd)}</span>
        <button className="ghost-button" onClick={()=>setEntries([])} title="Очистить вывод"><Trash2 size={13}/> Очистить</button>
      </div>
    </div>

    <div className="terminal-screen" onMouseDown={()=>inputRef.current?.focus()}>
      <div className="terminal-log" ref={logRef} role="log" aria-live="polite">
        {entries.length===0&&!running&&<div className="terminal-empty">
          <strong>Консоль проекта</strong>
          <span>Команды выполняются в корне проекта — папку выбирать не нужно. Начните с <code>ls</code> или <code>npm install</code>.</span>
        </div>}
        {entries.map(entry=><pre key={entry.id} className={"terminal-entry "+entry.kind}>{entry.text}</pre>)}
        {running&&<div className="terminal-progress"><LoaderCircle size={13} className="agent-spin"/> выполняю…</div>}
      </div>
      <form className="terminal-prompt-row" onSubmit={event=>{event.preventDefault();void run()}}>
        <span className="terminal-prompt"><b>nestdev</b>:{promptPath(cwd)}<i>$</i></span>
        <input
          ref={inputRef}
          className="terminal-command"
          value={command}
          onChange={event=>setCommand(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="ls"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          aria-label="Команда для консоли проекта"
        />
        <button className="terminal-run" type="submit" disabled={running||!command.trim()} title="Выполнить" aria-label="Выполнить"><CornerDownLeft size={14}/></button>
      </form>
    </div>
  </section>;
}
