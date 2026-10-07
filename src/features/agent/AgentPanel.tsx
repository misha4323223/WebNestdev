import { useEffect,useRef,useState } from "react";
import { ChevronDown,Send,Sparkles,Square } from "lucide-react";
import { createAgentSocket } from "../../lib/agent-socket";
import { getConversation } from "../../lib/project-api";
import type { ChatMessage } from "../../lib/types";

export function AgentPanel({projectId,conversationId,onChanged}:{projectId:string;conversationId:string;onChanged:()=>void}){
  const [messages,setMessages]=useState<ChatMessage[]>([]);
  const [prompt,setPrompt]=useState("");
  const [running,setRunning]=useState(false);
  const [loaded,setLoaded]=useState(false);
  const socketRef=useRef<WebSocket|null>(null);\n  const messagesRef=useRef<HTMLDivElement|null>(null);\n  const shouldStickToBottomRef=useRef(true);\n\n  function updateStickiness(){\n    const el=messagesRef.current;\n    if(!el)return;\n    const distance=el.scrollHeight-el.scrollTop-el.clientHeight;\n    shouldStickToBottomRef.current=distance<96;\n  }\n\n  function scrollToBottom(behavior: ScrollBehavior="smooth"){\n    const el=messagesRef.current;\n    if(!el||!shouldStickToBottomRef.current)return;\n    el.scrollTo({top:el.scrollHeight,behavior});\n  }

  useEffect(()=>{
    let cancelled=false;
    setLoaded(false);
    void getConversation(conversationId).then(conversation=>{
      if(cancelled)return;
      const persisted=conversation.messages.filter((message):message is ChatMessage=>message.role==="user"||message.role==="assistant");
      setMessages(persisted.length?persisted:[{role:"assistant",content:"Привет. Я WebNestdev — веб-агент для создания и развития проектов. Опиши, что нужно сделать."}]);\n      requestAnimationFrame(()=>scrollToBottom("auto"));
      setLoaded(true);
    }).catch(()=>{
      if(cancelled)return;
      setMessages([{role:"assistant",content:"Не удалось загрузить историю этой сессии."}]);
      setLoaded(true);
    });
    return()=>{cancelled=true;socketRef.current?.close();socketRef.current=null};
  },[conversationId]);

  function stop(){socketRef.current?.close();socketRef.current=null;setRunning(false);setMessages(cur=>{const next=[...cur];const last=next.at(-1);if(last?.role==="assistant"&&!last.content)next[next.length-1]={role:"assistant",content:"Выполнение остановлено."};return next})}

  function send(){
    const value=prompt.trim();
    if(!value||running||!loaded)return;
    const history=[...messages,{role:"user" as const,content:value}];
    setMessages([...history,{role:"assistant",content:""}]);
    setPrompt("");
    setRunning(true);

    const socket=createAgentSocket(event=>{
      if(event.type==="message.delta"){\n        setMessages(cur=>{const next=[...cur];const last=next.at(-1);if(last?.role==="assistant")next[next.length-1]={...last,content:last.content+(event.delta??"")};return next});\n        requestAnimationFrame(()=>scrollToBottom("smooth"));\n      }
      if(event.type==="run.completed"){setRunning(false);socket.close();socketRef.current=null;onChanged()}
      if(event.type==="run.failed"){setRunning(false);setMessages(cur=>[...cur,{role:"assistant",content:"Ошибка: "+(event.error??"неизвестная ошибка")}]);socket.close();socketRef.current=null}
      if(event.type==="error"){setRunning(false);setMessages(cur=>[...cur,{role:"assistant",content:"Ошибка: "+(event.error??"WebSocket")}]);socket.close();socketRef.current=null}
    },()=>{setRunning(false);setMessages(cur=>[...cur,{role:"assistant",content:"Не удалось подключиться к Agent Runtime."}]);socketRef.current=null});
    socketRef.current=socket;
    socket.addEventListener("open",()=>socket.send(JSON.stringify({type:"agent.run",request:{projectId,conversationId,messages:history}})),{once:true});
  }

  return <section className="chat">
    <div className="chat-header"><div><div className="eyebrow">AGENT</div><h1>Что создаём?</h1></div><button className="model-select" type="button">WebNestdev Agent <ChevronDown size={14}/></button></div>
    <div className="messages" ref={messagesRef} onScroll={updateStickiness}>{messages.map((m,i)=><div className={"message-row "+m.role} key={i}><div className="message-avatar">{m.role==="assistant"?<Sparkles size={14}/>:"Вы"}</div><div className="message-content"><div className="message-role">{m.role==="assistant"?"WebNestdev":"Вы"}</div><div className="message-text">{m.content|| (running?<span className="typing-indicator"><i></i><i></i><i></i><span>Работаю…</span></span>:"")}</div></div></div>)}</div>
    <div className="composer-wrap"><div className="composer"><textarea disabled={running||!loaded} value={prompt} onChange={e=>setPrompt(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send()}}} placeholder={loaded?"Опишите проект или задачу...":"Загружаем сессию…"} rows={3}/><div className="composer-footer"><span>Enter — отправить · Shift + Enter — новая строка</span><button className="send-button" disabled={!loaded} onClick={running?stop:send} title={running?"Остановить":"Отправить"}>{running?<Square size={14}/>:<Send size={15}/>}</button></div></div></div>
  </section>;
}
