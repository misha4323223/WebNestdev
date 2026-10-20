import { Menu,Monitor } from "lucide-react";
import { logout } from "../../lib/auth-api";
import { WebNestLogo } from "../../components/WebNestLogo";

/**
 * Шапка рабочей области. Знак крупнее и стоит над названием: в панели, где работают часами, логотип
 * узнаётся раньше, чем читается подпись, поэтому подпись мелкая и уходит под знак. Тариф живёт в
 * колонке слева, а не здесь: в шапке он спорил с названием проекта за одно и то же место.
 */
export function Topbar({projectName,onMenu,onHome,previewOpen,previewRunning,onPreviewToggle}:{projectName:string;onMenu:()=>void;onHome:()=>void;previewOpen:boolean;previewRunning:boolean;onPreviewToggle:()=>void}){
  return <header className="topbar">
    <button className="icon-button mobile-only menu-toggle" onClick={onMenu} aria-label="Открыть меню"><Menu size={18}/></button>
    <button className="brand brand-home" onClick={onHome} title="На главную">
      <span className="brand-mark"><WebNestLogo size={44} tone="light"/></span>
      <span className="brand-name">NestDev</span>
    </button>
    <div className="topbar-project">{projectName}</div>
    <div className="topbar-actions">
      {/* Only on a phone, where the preview is a drawer and needs a way in and out. */}
      <button className={"icon-button preview-toggle"+(previewOpen?" active":"")} onClick={onPreviewToggle} aria-expanded={previewOpen} aria-controls="preview-panel" aria-label="Предпросмотр проекта" title="Предпросмотр проекта">
        <Monitor size={16}/>
        {previewRunning&&<span className="preview-toggle-dot" aria-hidden="true"/>}
      </button>
      <button className="ghost-button" onClick={async()=>{await logout();window.location.reload()}}>Выйти</button>
    </div>
  </header>;
}
