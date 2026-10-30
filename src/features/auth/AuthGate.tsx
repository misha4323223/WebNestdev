import { lazy,Suspense,useCallback,useEffect,useState } from "react";
import { getAuth } from "../../lib/auth-api";
import { refreshPreferences } from "../../lib/preferences";
import { rememberedScreen,rememberScreen } from "../../lib/screen";
import { AuthScreen } from "./AuthScreen";
import { NestLoader } from "../../components/NestLoader";
import { ideaKickoff } from "../../lib/agent-kickoff";
import { onboardingBrief, type OnboardingAnswers } from "../../lib/onboarding";
import { startProjectWithAgent } from "../../lib/start-project";

// Гость на входе не должен загружать интерфейс проекта. Главная и рабочая область получают
// собственные чанки: они появятся только после входа и открытия проекта соответственно.
const HomeScreen = lazy(() => import("../home/HomeScreen").then(module => ({ default: module.HomeScreen })));
const WorkspaceShell = lazy(() => import("../workspace/WorkspaceShell").then(module => ({ default: module.WorkspaceShell })));
const OnboardingFlow = lazy(() => import("../onboarding/OnboardingFlow").then(module => ({ default: module.OnboardingFlow })));

function PaneFallback({label}:{label:string}){
  return <div className="app-loading"><NestLoader size={46} label={label}/><span>{label}…</span></div>;
}

function OnboardingFallback(){
  return <div className="onboarding"><div className="onboarding-card"><div className="app-loading"><NestLoader size={46} label="Загружаем знакомство"/></div></div></div>;
}

/**
 * Every connector that authorizes in its own window returns through one query
 * parameter. Keeping them in one table means a new service only adds a row here,
 * in its own card and on the server.
 */
const oauthReturns = [
  { param: "github", message: "webnestdev.github", windowName: "webnestdev-github", returnFlag: "webnestdev.githubReturn", noticeFlag: "webnestdev.githubNotice" },
  { param: "gitlab", message: "webnestdev.gitlab", windowName: "webnestdev-gitlab", returnFlag: "webnestdev.gitlabReturn", noticeFlag: "webnestdev.gitlabNotice" },
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
  // `/auth` — явный вход: в публичном демо-режиме он не должен подменяться демо-аккаунтом,
  // иначе владелец не сможет войти в свой аккаунт, пока демо включено.
  const manualLogin=window.location.pathname==="/auth"||new URLSearchParams(window.location.search).get("login")==="1";
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
  /**
   * Знакомство поверх обеих поверхностей: аккаунт, который после входа сразу попадает в свой
   * проект, тоже должен увидеть первый экран. Внутри главной он был бы скрыт вместе с её панелью.
   */
  const [onboardingOpen,setOnboardingOpen]=useState(false);
  const [onboardingEmail,setOnboardingEmail]=useState("");
  // Главная пересоздаётся после знакомства: проект, созданный им, должен попасть в список сразу.
  const [homeVersion,setHomeVersion]=useState(0);
  const reportAgentState=useCallback((next:{running:boolean;projectName:string}|null)=>setAgentRun(next),[]);
  const openWorkspace=useCallback((projectId:string)=>{
    setWorkspaceProject(projectId);setHome(false);rememberScreen("workspace");
  },[]);
  /** Уход на главную запоминается так же, как вход в проект: F5 не должен менять место. */
  const goHome=useCallback(()=>{setHome(true);rememberScreen("home")},[]);
  // Account preferences are fetched only after the session is confirmed: the caller is a guest
  // on this screen often enough that asking first would answer 401 in the browser console.
  const refresh=()=>{
    setState("loading");
    void getAuth(manualLogin).then(result=>{
      setState(result.authenticated?"authenticated":"guest");
      if(!result.authenticated){setOnboardingOpen(false);return;}
      // Контакты приходят вместе с сессией, поэтому первый экран не мигает главной: он либо
      // нужен аккаунту, либо нет. Проверка серверная — так его увидят и те, кто вошёл до
      // появления знакомства, и на любом устройстве, а не только в одном браузере.
      // В публичном демо знакомство не нужно: посетитель пришёл смотреть сайт, а не заполнять анкету.
      setOnboardingEmail(result.user?.email??"");
      setOnboardingOpen(!result.publicDemo&&!result.onboarding?.profile);
      void refreshPreferences();
    }).catch(()=>{setState("guest");setOnboardingOpen(false);});
  };
  useEffect(()=>{refresh()},[]);
  useEffect(()=>{localStorage.removeItem("webnestdev.openWorkspace")},[]);
  // A successful Yandex sign-in never mounts AuthScreen, so its query parameter is
  // cleaned here; a failed one is left for the sign-in screen to explain and remove.
  useEffect(()=>{
    if(state!=="authenticated")return;
    const params=new URLSearchParams(window.location.search);
    if(params.get("yandex_login")!=="ok")return;
    params.delete("yandex_login");
    const query=params.toString();
    window.history.replaceState(null,"",window.location.pathname+(query?"?"+query:""));
  },[state]);
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
    if(returnTo==="workspace"){
      // Отдельный ключ для вкладки: `openIntegrations` читает ещё и главная, которая
      // смонтирована даже позади рабочей области, и съедала бы флаг до SettingsHub.
      localStorage.setItem("webnestdev.openSettings","1");
      localStorage.setItem("webnestdev.openSettingsTab","integrations");
      openWorkspace(localStorage.getItem("webnestdev.projectId")??"");
      return;
    }
    localStorage.setItem("webnestdev.openIntegrations","1");
    goHome();
  },[goHome]);
  /** Контакты знакомства к этому моменту уже сохранены на сервере; здесь создаётся проект. */
  async function startFromOnboarding(answers:OnboardingAnswers){
    const project=await startProjectWithAgent({
      name:answers.projectName.trim().slice(0,80)||"Новый проект",
      plannerPrompt:ideaKickoff(answers.idea,onboardingBrief(answers)),
      title:"Новый проект",
    });
    setOnboardingOpen(false);
    setHomeVersion(version=>version+1);
    openWorkspace(project.id);
  }

  if(state==="loading") return <div className="app-loading"><NestLoader size={58} label="Проверяем сессию"/><strong>Проверяем сессию…</strong><span>Подготавливаем ваше рабочее пространство</span></div>;
  if(state==="guest") return <AuthScreen onAuthenticated={refresh}/>;
  // Обе поверхности живут в дереве одновременно, а показывается одна: скрытая рабочая область
  // продолжает держать сокет запуска, поэтому агент не останавливается на главной.
  return <>
    <div className="app-pane" hidden={!home}>
      <Suspense fallback={<PaneFallback label="Загружаем главную"/>}>
        <HomeScreen key={homeVersion} onOpenWorkspace={openWorkspace} activeRun={agentRun?.running?{projectId:workspaceProject??"",projectName:agentRun.projectName}:null}/>
      </Suspense>
    </div>
    {workspaceProject!==null&&<div className="app-pane" hidden={home}>
      <Suspense fallback={<PaneFallback label="Загружаем рабочую область"/>}>
        <WorkspaceShell key={workspaceProject} onHome={goHome} onAgentState={reportAgentState} active={!home}/>
      </Suspense>
    </div>}
    {onboardingOpen&&<Suspense fallback={<OnboardingFallback/>}>
      <OnboardingFlow accountEmail={onboardingEmail} onStart={startFromOnboarding} onSkip={()=>setOnboardingOpen(false)}/>
    </Suspense>}
  </>;
}
