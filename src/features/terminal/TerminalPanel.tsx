import { useState } from "react";
import { runProjectTerminal } from "../../lib/project-api";

export function TerminalPanel({projectId}:{projectId:string}){
  const [command,setCommand]=useState("");const [output,setOutput]=useState("");
  async function run(){if(!command.trim())return;setOutput("Выполняю…");try{const d=await runProjectTerminal(projectId,command);setOutput([d.stdout,d.stderr].filter(Boolean).join("\n")||"Готово")}catch(e){setOutput(e instanceof Error?e.message:"Ошибка")}}
  return <div className="panel"><div className="panel-title">Терминал sandbox</div><textarea className="terminal-input" value={command} onChange={e=>setCommand(e.target.value)} placeholder="npm --version"/><button className="send-button" onClick={()=>void run()}>Запустить</button><pre className="terminal-output">{output}</pre></div>;
}
