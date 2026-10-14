import { useEffect,useState } from "react";
import { getAuth } from "../../lib/auth-api";
import { AuthScreen } from "./AuthScreen";
import { NestLoader } from "../../components/NestLoader";
import { WorkspaceShell } from "../workspace/WorkspaceShell";
import { HomeScreen } from "../home/HomeScreen";

/**
 * Every connector that authorizes in its own window returns through one query
 * parameter. Keeping them in one table means a new service only adds a row here,
 * in its own card and on the server.
 */
const oauthReturns = [
  { param: "github", message: "webnestdev.github", windowName: "webnestdev-github", returnFlag: "webnestdev.githubReturn", noticeFlag: "webnestdev.githubNotice" },
  { param: "yandex", message: "webnestdev.yandex", windowName: "webnestdev-yandex", returnFlag: "webnestdev.yandexReturn", noticeFlag: "webnestdev.yandexNotice" },
] as const;

export function AuthGate(){
  const [state,setState]=useState<"loading"|"authenticated"|"guest">("loading");
  // Integrations (for example a GitHub import) ask for the workspace directly after a reload.
  const [home,setHome]=useState(()=>!localStorage.getItem("webnestdev.openWorkspace"));
  const refresh=()=>{setState("loading");void getAuth().then(result=>setState(result.authenticated?"authenticated":"guest")).catch(()=>setState("guest"));};
  useEffect(()=>{refresh()},[]);
  useEffect(()=>{localStorage.removeItem("webnestdev.openWorkspace")},[]);
  // An OAuth callback returns with ?<provider>=<status>: drop the query from the
  // address bar and send the user back to the integrations list that started it.
  useEffect(()=>{
    const params=new URLSearchParams(window.location.search);
    const provider=oauthReturns.find(item=>params.has(item.param));
    if(!provider)return;
    const status=params.get(provider.param)??"error";
    params.delete(provider.param);
    const query=params.toString();
    window.history.replaceState(null,"",window.location.pathname+(query?"?"+query:""));
    // A connector opens the provider in its own named window: that window only reports
    // the result by closing, so it must not take over the app state the main window keeps.
    if(window.name===provider.windowName){
      try{ window.opener?.postMessage({type:provider.message,status},window.location.origin) }catch{}
      window.close();
      return;
    }
    // A blocked popup falls back to this full-page return: reopen the same surface.
    const returnTo=localStorage.getItem(provider.returnFlag);
    localStorage.removeItem(provider.returnFlag);
    localStorage.setItem(provider.noticeFlag,status);
    localStorage.setItem("webnestdev.openIntegrations","1");
    if(returnTo==="workspace"){
      localStorage.setItem("webnestdev.openSettings","1");
      setHome(false);
      return;
    }
    setHome(true);
  },[]);
  if(state==="loading") return <div className="app-loading"><NestLoader size={58} label="Проверяем сессию"/><strong>Проверяем сессию…</strong><span>Подготавливаем ваше рабочее пространство</span></div>;
  if(state==="guest") return <AuthScreen onAuthenticated={refresh}/>;
  if(home) return <HomeScreen onOpenWorkspace={()=>setHome(false)}/>;
  return <WorkspaceShell onHome={()=>setHome(true)}/>;
}
