import { useEffect,useState } from "react";
import { ChevronDown, Send, Sparkles } from "lucide-react";
import { createAgentSocket } from "../../lib/agent-socket";
import { getConversation } from "../../lib/project-api";
import type { ChatMessage } from "../../lib/types";

export function AgentPanel({projectId,conversationId,onChanged}:{projectId:string;conversationId:string;onChanged:()=>void}){
  const [messages,setMessages]=useState<ChatMessage[]>([]);
  const [prompt,setPrompt]=useState("");
  const [running,setRunning]=useState(false);
  const [loaded,setLoaded]=useState(false);

  useEffect(()=>{
    let cancelled=false;
    setLoaded(false);
    void getConversation(conversationId).then(conversation=>{
      if(cancelled)return;
      const persisted=conversation.messages.filter((message):message is ChatMessage=>message.role==="user"||message.role==="assistant");
      setMessages(persisted.length?persisted:[{role:"assistant",content:"Привет. Я WebNestdev — веб-агент для создания и развития проектов. Опиши, что нужно сделать."}]);
      setLoaded(true);
    }).catch(()=>{
      if(cancelled)return;
      setMessages([{role:"assistant",content:"Привет. Я WebNestdev — веб-агент для создания и развития проектов. Опиши, что нужно сделать."}]);
      setLoaded(true);
    });
    return()=>{cancelled=true};
  },[conversationId]);

  function send(){
    const value=prompt.trim();
    if(!value||running||!loaded)return;
    const history=[...messages,{role:"user" as const,content:value}];
    setMessages([...history,{role:"assistant",content:""}]);
    setPrompt("");
    setRunning(true);

    let socket:WebSocket;
    socket=createAgentSocket(event=>{
      if(event.type==="message.delta"){
        setMessages(cur=>{
          const next=[...cur];
          const last=next.at(-1);
          if(last?.role==="assistant")next[next.length-1]={...last,content:last.content+(event.delta??"")};
          return next;
        });
      }
      if(event.type==="run.completed"){
        setRunning(false);
        socket.close();
        onChanged();
      }
      if(event.type==="run.failed"){
        setRunning(false);
        setMessages(cur=>[...cur,{role:"assistant",content:"Ошибка: "+(event.error??"неизвестная ошибка")}]);
        socket.close();
      }
    },()=>{
      setRunning(false);
      setMessages(cur=>[...cur,{role:"assistant",content:"Не удалось подключиться к Agent Runtime."}]);
    });

    socket.addEventListener("open",()=>{
      socket.send(JSON.stringify({type:"agent.run",request:{projectId,conversationId,messages:history}}));
    },{once:true});
  }

  return <section className="chat">
    <div className="chat-header"><div><div className="eyebrow">AGENT</div><h1>Что создаём?</h1></div><button className="model-select">WebNestdev Agent <ChevronDown size={14}/></button></div>
    <div className="messages">{messages.map((m,i)=><div className={"message-row "+m.role} key={i}><div className="message-avatar">{m.role==="assistant"?<Sparkles size={14}/>:"Вы"}</div><div className="message-content"><div className="message-role">{m.role==="assistant"?"WebNestdev":"Вы"}</div><div className="message-text">{m.content|| (running?"Работаю…":"")}</div></div></div>)}</div>
    <div className="composer-wrap"><div className="composer"><textarea disabled={running||!loaded} value={prompt} onChange={e=>setPrompt(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send()}}} placeholder={loaded?"Опишите проект или задачу...":"Загружаем сессию…"} rows={3}/><div className="composer-footer"><span>Enter — отправить · Shift + Enter — новая строка</span><button className="send-button" disabled={running||!loaded} onClick={send}><Send size={15}/></button></div></div></div>
  </section>;
}
