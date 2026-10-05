import { useState } from "react";
import { Play,Square,Trash2 } from "lucide-react";
import { runProjectTerminal } from "../../lib/project-api";

export function TerminalPanel({projectId}:{projectId:string}){
  const [command,setCommand]=useState("");
  const [cwd,setCwd]=useState(".");
  const [output,setOutput]=useState("");
  const [running,setRunning]=useState(false);

  async function run(){
    if(!command.trim()||running)return;
    setRunning(true);setOutput("$ "+command+"\n\nВыполняю…");
    try{
      const d=await runProjectTerminal(projectId,command,cwd);
      setOutput("$ "+command+"\n"+[d.stdout,d.stderr].filter(Boolean).join("\n")+(d.ok?"\n\n[готово]":"\n\n[команда завершилась с ошибкой]"));
    }catch(e){setOutput("$ "+command+"\n\n"+(e instanceof Error?e.message:"Ошибка"))}
    finally{setRunning(false)}
  }
  return <section className="panel">
    <div className="panel-title"><div><span className="eyebrow">TERMINAL</span><strong>Sandbox console</strong></div><button className="ghost-button" onClick={()=>setOutput("")}><Trash2 size={14}/> Очистить</button></div>
    <div className="terminal-controls"><input value={cwd} onChange={e=>setCwd(e.target.value)} placeholder="Рабочая папка: ."/><button className="send-button" disabled={running||!command.trim()} onClick={()=>void run()} title={running?"Выполняется":"Запустить"}>{running?<Square size={14}/>:<Play size={14}/>}</button></div>
    <textarea className="terminal-input" value={command} onChange={e=>setCommand(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();void run()}}} placeholder="npm --version"/>
    <pre className="terminal-output">{output||"Результат выполнения появится здесь."}</pre>
  </section>;
}
