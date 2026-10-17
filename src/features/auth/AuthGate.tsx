import { useCallback,useEffect,useState } from "react";
import { getAuth } from "../../lib/auth-api";
import { refreshPreferences } from "../../lib/preferences";
import { rememberedScreen,rememberScreen } from "../../lib/screen";
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

/**
 * Какая поверхность была на экране до перезагрузки. Без этого адреса у страницы нет (роутера
 * в приложении нет), и F5 всегда возвращал на главную, хотя человек стоял в проекте.
 */
function restoreScreen():"workspace"|"home"{
  const savedProject=localStorage.getItem("webnestdev.projectId")??"";
  // `openWorkspace` — одноразовый флаг импорта; `screen` — постоянное место, где стоит человек.
  if(!savedProject)return "home";
  if(localStorage.getItem("webnestdev.openWorkspace")||rememberedScreen()==="workspace")return "workspace";
  return "home";
}

export function AuthGate(){
  const [state,setState]=useState<"loading"|"authenticated"|"guest">("loading");
  const [home,setHome]=useState(()=>restoreScreen()!=="workspace");
  /**
   * Проект, для которого смонтирована рабочая область, или null, если она ещё не открывалась.
   * Уход на главную её больше не размонтирует: запуск агента живёт, пока открыт сокет панели,
   * поэтому «выйти из проекта» не значит «остановить агента». Второй проект — другая область
   * (key пересоздаёт её), тот же проект продолжается с того же места.
   */
  const [workspaceProject,setWorkspaceProject]=useState<string|null>(()=>restoreScreen()==="workspace"?localStorage.getItem("webnestdev.projectId")??"":null);
  // Идёт ли запуск прямо сейчас: главная показывает это, пока пользователь вне проекта.
  const [agentRun,setAgentRun]=useState<{running:boolean;projectName:string}|null>(null);
  const reportAgentState=useCallback((next:{running:boolean;projectName:string}|null)=>setAgentRun(next),[]);
  const openWorkspace=useCallback((projectId:string)=>{
    setWorkspaceProject(projectId);setHome(false);rememberScreen("workspace");
  },[]);
  /** Уход на главную запоминается так же, как вход в проект: F5 не должен менять место. */
  const goHome=useCallback(()=>{setHome(true);rememberScreen("home")},[]);
  // Account preferences are fetched only after the session is confirmed: the caller is a guest
  // on this screen often enough that asking first would answer 401 in the browser console.
  const refresh=()=>{setState("loading");void getAuth().then(result=>{setState(result.authenticated?"authenticated":"guest");if(result.authenticated)void refreshPreferences();}).catch(()=>setState("guest"));};
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
      openWorkspace(localStorage.getItem("webnestdev.projectId")??"");
      return;
    }
    goHome();
  },[goHome]);
  if(state==="loading") return <div className="app-loading"><NestLoader size={58} label="Проверяем сессию"/><strong>Проверяем сессию…</strong><span>Подготавливаем ваше рабочее пространство</span></div>;
  if(state==="guest") return <AuthScreen onAuthenticated={refresh}/>;
  // Обе поверхности живут в дереве одновременно, а показывается одна: скрытая рабочая область
  // продолжает держать сокет запуска, поэтому агент не останавливается на главной.
  return <>
    <div className="app-pane" hidden={!home}>
      <HomeScreen onOpenWorkspace={openWorkspace} activeRun={agentRun?.running?{projectId:workspaceProject??"",projectName:agentRun.projectName}:null}/>
    </div>
    {workspaceProject!==null&&<div className="app-pane" hidden={home}>{
      <WorkspaceShell key={workspaceProject} onHome={goHome} onAgentState={reportAgentState}/>
    }</div>}
  </>;
}
