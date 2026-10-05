import { Github,Menu,Plus } from "lucide-react";

export function Topbar({projectName,onMenu,onNewProject}:{projectName:string;onMenu:()=>void;onNewProject:()=>void}){
  return <header className="topbar">
    <button className="icon-button mobile-only" onClick={onMenu} aria-label="Открыть меню"><Menu size={16}/></button>
    <div className="brand"><span className="brand-mark">N</span><span>WebNestdev</span><span className="version">WEB</span></div>
    <div className="topbar-project">{projectName}</div>
    <div className="topbar-actions">
      <button className="ghost-button" onClick={onNewProject}><Plus size={14}/> Новый проект</button>
      <a className="icon-button" href="https://github.com/misha4323223/WebNestdev" target="_blank" rel="noreferrer" aria-label="GitHub"><Github size={15}/></a>
    </div>
  </header>;
}
