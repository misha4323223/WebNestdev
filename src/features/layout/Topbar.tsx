import { Github,Menu,Plus } from "lucide-react";
import { GitHubConnect } from "../github/GitHubConnect";
import { useState } from "react";

export function Topbar({projectName,onMenu,onNewProject}:{projectName:string;onMenu:()=>void;onNewProject:()=>void}){
  const [githubOpen,setGithubOpen]=useState(false);
  const imported=(projectId:string,conversationId:string)=>{
    localStorage.setItem("webnestdev.projectId",projectId);
    localStorage.setItem("webnestdev.conversationId",conversationId);
    localStorage.removeItem("webnestdev.projectName");
    window.location.reload();
  };
  return <header className="topbar">
    <button className="icon-button mobile-only" onClick={onMenu} aria-label="Открыть меню"><Menu size={16}/></button>
    <div className="brand"><span className="brand-mark">N</span><span>WebNestdev</span><span className="version">WEB</span></div>
    <div className="topbar-project">{projectName}</div>
    <div className="topbar-actions">
      <button className="ghost-button" onClick={onNewProject}><Plus size={14}/> Новый проект</button>
      <button className="icon-button" onClick={()=>setGithubOpen(v=>!v)} aria-label="Connect GitHub"><Github size={15}/></button>
    </div>
    {githubOpen&&<div className="github-popover"><GitHubConnect onImported={imported}/></div>}
  </header>;
}
