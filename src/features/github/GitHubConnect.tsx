import { useEffect, useState } from "react";
import { GitBranch, LogOut, UploadCloud } from "lucide-react";

type Repository = { id:number; name:string; full_name:string; private:boolean; default_branch:string; html_url:string; owner:{login:string} };

export function GitHubConnect({ onImported }:{ onImported:(projectId:string,conversationId:string)=>void }) {
  const [connected,setConnected]=useState(false);
  const [login,setLogin]=useState<string|null>(null);
  const [repositories,setRepositories]=useState<Repository[]>([]);
  const [selected,setSelected]=useState<Repository|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState<string|null>(null);
  const api="/api";

  async function refresh(){
    setLoading(true); setError(null);
    try {
      const status=await fetch(api+"/github/status").then(r=>r.json());
      setConnected(status.connected); setLogin(status.githubLogin);
      if(status.connected) {
        const data=await fetch(api+"/github/repositories").then(r=>r.json());
        setRepositories(data.repositories ?? []);
      }
    } catch(e){ setError(e instanceof Error?e.message:"Не удалось получить GitHub"); }
    finally{setLoading(false);}
  }
  useEffect(()=>{void refresh();},[]);

  async function importRepository(){
    if(!selected)return;
    setLoading(true); setError(null);
    try {
      const r=await fetch(api+"/github/import",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({owner:selected.owner.login,repo:selected.name})});
      const data=await r.json();
      if(!r.ok) throw new Error(data.error ?? "Не удалось импортировать репозиторий");
      onImported(data.project.id,data.conversation.id);
    } catch(e){setError(e instanceof Error?e.message:"Ошибка импорта");}
    finally{setLoading(false);}
  }

  if(loading && !connected) return <section className="github-panel"><span>Подключение к GitHub…</span></section>;
  return <section className="github-panel">
    <div className="github-panel-head"><div><span className="eyebrow">GITHUB</span><h2>{connected ? "Репозитории" : "Подключить GitHub"}</h2>{login&&<span className="github-login">@{login}</span>}</div><GitBranch size={22}/></div>
    {!connected ? <button className="send-button" onClick={()=>{window.location.href=api+"/github/connect"}}><GitBranch size={15}/> Connect GitHub</button> :
      <>
        <div className="github-repositories">{repositories.map(repo=><button key={repo.id} className={"github-repository"+(selected?.id===repo.id?" selected":"")} onClick={()=>setSelected(repo)}><span><strong>{repo.full_name}</strong><small>{repo.private?"Private":"Public"} · {repo.default_branch}</small></span></button>)}</div>
        <div className="github-actions"><button className="ghost-button" onClick={()=>{setSelected(null);setConnected(false);setRepositories([])}}><LogOut size={14}/> Сменить GitHub</button><button className="send-button" disabled={!selected} onClick={()=>void importRepository()}><UploadCloud size={14}/> Импортировать в WebNestDev</button></div>
      </>
    }
    {error&&<div className="github-error">{error}</div>}
  </section>;
}
